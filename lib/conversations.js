/**
 * Durable transcript store for sidebar-chat conversations.
 *
 * One JSON file per conversation, under the plugin's own directory in the
 * harness home (`$DSH_HOME/dsh-sidebar-chat/conversations/<id>.json`), plus an
 * `index.json` carrying the list metadata the tab renders. History is the one
 * thing that must outlive a restart, so it lives in the harness home while
 * attachments live in the system temp directory — the two have different
 * lifetimes on purpose.
 *
 * Writes are atomic (write a sibling, then rename) and the index is rebuilt
 * from the conversation files whenever it is missing or unreadable, so a
 * half-written index costs ordering metadata, never a transcript.
 *
 * @module dsh-sidebar-chat/conversations
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Format marker; bumped only when the stored shape changes incompatibly. */
const STORE_VERSION = 1

/** Longest title derived from a first message. */
const TITLE_MAX_CHARS = 40

/** A conversation identifier: `c-` plus a random hex string. */
export function newConversationId() {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  return `c-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** A message identifier. */
export function newMessageId() {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  return `m-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * First line of a prompt, clipped, as the conversation title.
 * @param text - the user's first message text.
 * @returns a single-line title.
 */
export function deriveTitle(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length === 0) return '新对话'
  return flat.length <= TITLE_MAX_CHARS ? flat : `${flat.slice(0, TITLE_MAX_CHARS - 1)}…`
}

/**
 * Conversations on disk, with an in-memory index over the list metadata.
 */
export class ConversationStore {
  #dir
  #logger
  #index = new Map()
  #loaded

  /**
   * @param options - store options.
   * @param options.dir - plugin-owned directory holding the transcripts.
   * @param options.logger - diagnostic sink.
   */
  constructor(options) {
    this.#dir = options.dir
    this.#logger = options.logger
  }

  /** Absolute path of the transcript directory. */
  get dir() {
    return this.#dir
  }

  /**
   * List conversation summaries, most recently updated first.
   * @returns the summaries the tab's conversation list renders.
   */
  async list() {
    await this.#ensure()
    return [...this.#index.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * Read one full conversation.
   * @param id - conversation identifier.
   * @returns the conversation, or undefined when it does not exist.
   */
  async get(id) {
    await this.#ensure()
    if (!this.#index.has(id)) return undefined
    try {
      const parsed = JSON.parse(await readFile(this.#pathOf(id), 'utf8'))
      return isConversation(parsed) ? parsed : undefined
    } catch (error) {
      this.#logger?.warn?.(`[sidebar-chat] 读取会话 ${id} 失败：${String(error)}`)
      return undefined
    }
  }

  /**
   * Persist one conversation and refresh its index row.
   * @param conversation - the complete conversation to write.
   * @returns the same conversation.
   */
  async save(conversation) {
    await this.#ensure()
    await mkdir(this.#dir, { recursive: true })
    await writeJsonAtomic(this.#pathOf(conversation.id), conversation)
    this.#index.set(conversation.id, summaryOf(conversation))
    await this.#flushIndex()
    return conversation
  }

  /**
   * Delete one conversation and its transcript.
   * @param id - conversation identifier.
   * @returns whether a conversation was removed.
   */
  async remove(id) {
    await this.#ensure()
    if (!this.#index.has(id)) return false
    this.#index.delete(id)
    await rm(this.#pathOf(id), { force: true })
    await this.#flushIndex()
    return true
  }

  /**
   * Delete every conversation.
   * @returns how many were removed.
   */
  async clear() {
    await this.#ensure()
    const ids = [...this.#index.keys()]
    for (const id of ids) await this.remove(id)
    return ids.length
  }

  /** Load the index once per instance, rebuilding it when it is unusable. */
  async #ensure() {
    if (this.#loaded !== undefined) return this.#loaded
    this.#loaded = (async () => {
      await mkdir(this.#dir, { recursive: true })
      let parsed
      try {
        parsed = JSON.parse(await readFile(this.#indexPath, 'utf8'))
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined && Array.isArray(parsed?.conversations)) {
        for (const row of parsed.conversations) {
          if (isSummary(row)) this.#index.set(row.id, row)
        }
        return
      }
      await this.#rebuild()
    })()
    return this.#loaded
  }

  /** Rebuild the index by reading every transcript on disk. */
  async #rebuild() {
    this.#index.clear()
    let names = []
    try {
      names = await readdir(this.#dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue
      try {
        const parsed = JSON.parse(await readFile(join(this.#dir, name), 'utf8'))
        if (isConversation(parsed)) this.#index.set(parsed.id, summaryOf(parsed))
      } catch {
        // A corrupt transcript is skipped and left on disk for inspection.
      }
    }
    if (this.#index.size > 0) {
      this.#logger?.info?.(`[sidebar-chat] 会话索引已从文件重建（${this.#index.size} 个会话）`)
    }
    await this.#flushIndex()
  }

  /** Absolute path of one transcript. */
  #pathOf(id) {
    return join(this.#dir, `${id}.json`)
  }

  /** Absolute path of the index. */
  get #indexPath() {
    return join(this.#dir, 'index.json')
  }

  /** Persist the list metadata. */
  async #flushIndex() {
    await writeJsonAtomic(this.#indexPath, {
      version: STORE_VERSION,
      conversations: [...this.#index.values()].sort((left, right) => right.updatedAt - left.updatedAt),
    })
  }
}

/** The list row one conversation contributes to the index. */
export function summaryOf(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    provider: conversation.provider,
    model: conversation.model,
    messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
    preview: previewOf(conversation),
  }
}

/** One-line preview of the newest user or assistant text. */
function previewOf(conversation) {
  const messages = Array.isArray(conversation.messages) ? conversation.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = String(messages[index]?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 0) return text.length <= 80 ? text : `${text.slice(0, 79)}…`
  }
  return ''
}

/**
 * Create a fresh conversation.
 * @param input - routing defaults the new conversation starts with.
 * @returns a conversation with no messages.
 */
export function createConversation(input = {}) {
  const now = Date.now()
  return {
    id: newConversationId(),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    provider: input.provider ?? '',
    model: input.model ?? '',
    reasoningEffort: input.reasoningEffort ?? '',
    messages: [],
  }
}

/** Write a whole JSON file through a sibling temp file and a rename. */
async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`)
  await rename(temporary, path)
}

/** Whether a parsed value looks like a stored conversation. */
function isConversation(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    Array.isArray(value.messages)
  )
}

/** Whether a parsed value looks like an index row. */
function isSummary(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.updatedAt === 'number'
  )
}
