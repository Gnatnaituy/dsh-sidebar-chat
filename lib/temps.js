/**
 * Temp-file store for sidebar-chat attachments.
 *
 * The plugin is deliberately not bound to a working directory: nothing it
 * receives ever lands in the session workspace or in the user's project. An
 * uploaded image is written, verbatim, into one directory under the operating
 * system's temporary directory —
 *
 *   <os.tmpdir()>/dsh-sidebar-chat/files/<id>.<ext>
 *   <os.tmpdir()>/dsh-sidebar-chat/index.json
 *
 * — and that copy is what the tab renders and what the user's disk carries.
 * The operating system owns the lifetime of that tree; the sweep below only
 * keeps it from growing without bound between system cleanups.
 *
 * The harness additionally keeps its own *normalized* copy of any image that
 * is actually sent to a model (that is `ctx.attachments`' content-addressed
 * store, the only representation a provider adapter can read). That copy is an
 * implementation detail of the request path: the plugin's own record, and the
 * only thing the UI ever resolves, stays here.
 *
 * @module dsh-sidebar-chat/temps
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

/** Directory name this plugin owns inside the system temp directory. */
export const TEMP_DIR_NAME = 'dsh-sidebar-chat'

/** Media types an attachment may carry, mapped to the extension stored on disk. */
export const MEDIA_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
})

/** Largest single attachment accepted, in bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** How long an unused attachment is kept before the sweep removes it. */
export const ATTACHMENT_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** Extension of a stored media type, or `.bin` for a type this store does not know. */
export function extensionFor(mediaType) {
  return MEDIA_EXTENSIONS[mediaType] ?? '.bin'
}

/** Media type of a stored file name, by extension. */
export function mediaTypeOf(name) {
  const ext = extname(name).toLowerCase()
  for (const [mediaType, candidate] of Object.entries(MEDIA_EXTENSIONS)) {
    if (candidate === ext) return mediaType
  }
  return undefined
}

/** Filename-safe form of a user-supplied display name. */
export function safeDisplayName(name, fallback) {
  const raw = typeof name === 'string' ? name.trim() : ''
  if (raw.length === 0) return fallback
  // Keep the name readable but strip anything that could escape the directory
  // or confuse a shell; the stored file name is the id, so this is display-only.
  return raw.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 120)
}

/** A record identifier: `a-` plus a random hex string. */
export function newAttachmentId() {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return `a-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Attachment records held in the system temp directory.
 *
 * The index is written on every mutation and rebuilt from the files on disk
 * when it is missing or unreadable, so a crash or a manual `rm` of the index
 * costs metadata, never the bytes.
 */
export class TempStore {
  #root
  #files
  #logger
  #index = new Map()
  #loaded

  /**
   * @param options - store options.
   * @param options.logger - diagnostic sink (`ctx.logger` when available).
   * @param options.root - temp root override; defaults to `<os.tmpdir()>/dsh-sidebar-chat`.
   */
  constructor(options = {}) {
    this.#root = options.root ?? join(tmpdir(), TEMP_DIR_NAME)
    this.#files = join(this.#root, 'files')
    this.#logger = options.logger
  }

  /** Absolute path of the directory holding every plugin attachment. */
  get root() {
    return this.#root
  }

  /** Absolute path of the index file. */
  get indexPath() {
    return join(this.#root, 'index.json')
  }

  /**
   * Store one uploaded file verbatim and return its record.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns the stored record, including the absolute path on disk.
   * @throws when the type is unsupported or the payload exceeds the size cap.
   */
  async put(input) {
    const mediaType = String(input.mediaType ?? '').toLowerCase()
    if (MEDIA_EXTENSIONS[mediaType] === undefined) {
      throw new Error(`不支持的附件类型 ${mediaType || '(空)'}（仅支持 PNG / JPEG / WebP / GIF）`)
    }
    const bytes = toBuffer(input.bytes)
    if (bytes.byteLength === 0) throw new Error('附件内容为空')
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限`)
    }

    await this.#ensure()
    const id = newAttachmentId()
    const record = {
      id,
      name: safeDisplayName(input.name, `image${extensionFor(mediaType)}`),
      mediaType,
      bytes: bytes.byteLength,
      ...(Number.isFinite(input.width) && input.width > 0 ? { width: Math.round(input.width) } : {}),
      ...(Number.isFinite(input.height) && input.height > 0 ? { height: Math.round(input.height) } : {}),
      createdAt: Date.now(),
      usedAt: Date.now(),
    }

    const path = join(this.#files, `${id}${extensionFor(mediaType)}`)
    await writeFile(path, bytes)
    this.#index.set(id, record)
    await this.#flush()
    return { ...record, path }
  }

  /**
   * Look one attachment up, refreshing its last-use mark.
   * @param id - record identifier.
   * @returns the record with its absolute path, or undefined when unknown.
   */
  async resolve(id) {
    await this.#ensure()
    const record = this.#index.get(id)
    if (record === undefined) return undefined
    const path = join(this.#files, `${record.id}${extensionFor(record.mediaType)}`)
    record.usedAt = Date.now()
    await this.#flush()
    return { ...record, path }
  }

  /**
   * Read one attachment's bytes.
   * @param id - record identifier.
   * @returns the record and its bytes, or undefined when the file is gone.
   */
  async read(id) {
    const found = await this.resolve(id)
    if (found === undefined) return undefined
    try {
      return { record: found, bytes: await readFile(found.path) }
    } catch {
      // The system cleaned the temp directory out from under us: forget the
      // record so the UI reports a missing file instead of a broken image.
      await this.remove(id)
      return undefined
    }
  }

  /** Every known record, newest first. */
  async list() {
    await this.#ensure()
    return [...this.#index.values()].sort((left, right) => right.createdAt - left.createdAt)
  }

  /**
   * Forget one attachment and delete its bytes.
   * @param id - record identifier.
   * @returns whether a record was removed.
   */
  async remove(id) {
    await this.#ensure()
    const record = this.#index.get(id)
    if (record === undefined) return false
    this.#index.delete(id)
    await rm(join(this.#files, `${record.id}${extensionFor(record.mediaType)}`), { force: true })
    await this.#flush()
    return true
  }

  /**
   * Drop records unused for longer than the retention window, plus file bytes
   * with no record at all. Called once when the plugin loads.
   * @returns how many records were dropped.
   */
  async sweep(now = Date.now()) {
    await this.#ensure()
    let dropped = 0
    for (const record of [...this.#index.values()]) {
      const lastUse = Math.max(record.usedAt ?? 0, record.createdAt ?? 0)
      if (now - lastUse <= ATTACHMENT_TTL_MS) continue
      await this.remove(record.id)
      dropped += 1
    }
    try {
      const known = new Set([...this.#index.values()].map((record) => `${record.id}${extensionFor(record.mediaType)}`))
      for (const name of await readdir(this.#files)) {
        if (known.has(name)) continue
        await rm(join(this.#files, name), { force: true })
      }
    } catch {
      // A missing files directory is not an error: nothing has been uploaded yet.
    }
    return dropped
  }

  /** Load the index once per store instance, creating the temp tree on first use. */
  async #ensure() {
    if (this.#loaded !== undefined) return this.#loaded
    this.#loaded = (async () => {
      await mkdir(this.#files, { recursive: true })
      let parsed
      try {
        parsed = JSON.parse(await readFile(this.indexPath, 'utf8'))
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined && typeof parsed === 'object' && parsed.records !== undefined) {
        for (const record of Object.values(parsed.records)) {
          if (isRecord(record)) this.#index.set(record.id, record)
        }
        return
      }
      await this.#rebuild()
    })()
    return this.#loaded
  }

  /** Rebuild the index from the files on disk after the index was lost. */
  async #rebuild() {
    this.#index.clear()
    let names = []
    try {
      names = await readdir(this.#files)
    } catch {
      return
    }
    for (const name of names) {
      const mediaType = mediaTypeOf(name)
      if (mediaType === undefined) continue
      const id = name.slice(0, name.length - extname(name).length)
      let info
      try {
        info = await stat(join(this.#files, name))
      } catch {
        continue
      }
      this.#index.set(id, {
        id,
        name,
        mediaType,
        bytes: info.size,
        createdAt: info.mtimeMs,
        usedAt: info.mtimeMs,
      })
    }
    this.#logger?.info?.(`[sidebar-chat] 临时目录索引已从文件重建（${this.#index.size} 个附件）`)
    await this.#flush()
  }

  /** Persist the index atomically: write a sibling file, then rename over it. */
  async #flush() {
    const payload = JSON.stringify(
      { version: 1, records: Object.fromEntries(this.#index) },
      undefined,
      2,
    )
    const temporary = `${this.indexPath}.${process.pid}.tmp`
    await writeFile(temporary, payload)
    await rename(temporary, this.indexPath)
  }
}

/** Coerce an upload payload into a Buffer without copying when it already is one. */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (typeof bytes === 'string') return Buffer.from(bytes, 'binary')
  throw new Error('附件内容必须是字节')
}

/** Whether a parsed index entry is a usable record. */
function isRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.mediaType === 'string' &&
    MEDIA_EXTENSIONS[value.mediaType] !== undefined
  )
}
