/**
 * Host half of dsh-sidebar-chat.
 *
 * One job: be the backend of a sidebar chat tab that is *not* bound to a
 * working directory. It owns four things and nothing else —
 *
 *   - the model list, read from the harness `llm` service so the tab offers
 *     exactly the models this deployment can actually route to;
 *   - a `${DSH_HOME}/dsh-sidebar-chat/conversations` transcript store, so
 *     history survives a restart;
 *   - a `<os.tmpdir()>/dsh-sidebar-chat` attachment store, so every uploaded
 *     image lands in the system temp directory and never in a project;
 *   - `/dsh-sidebar-chat/*`, served over the harness web server: JSON for the
 *     first three, and one server-sent-event stream per assistant turn.
 *
 * It never creates a harness session, never runs the agent loop, and never
 * reads or writes the session workspace. One turn is one `ctx.llm.stream()`
 * call.
 *
 * @module dsh-sidebar-chat
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_MAX_ROUNDS,
  MAX_SEARCH_QUERIES,
  SEARCH_INSTRUCTION,
  SEARCH_MAX_RESULTS,
  WEB_SEARCH_TOOL,
  buildMessages,
  describeFailure,
  formatSearchResult,
  modelSeesImages,
  parseQueries,
  repairArguments,
  runTurn,
  sanitizeQueries,
} from './chat.js'
import { ConversationStore, createConversation, deriveTitle, newMessageId } from './conversations.js'
import { TempStore } from './temps.js'

/** Plugin identity: equals the package name and the Loader row name. */
export const name = 'dsh-sidebar-chat'

/**
 * Services that must exist before the routes are registered. `llm` is the only
 * framework capability this plugin needs; `attachments` is reached lazily with
 * `ctx.get`, so a deployment without it still loads (images then report a
 * clear error instead of the whole tab disappearing).
 */
export const inject = ['webServer', 'llm']

/** Path prefix this plugin owns on the harness web server. */
const ROUTE = '/dsh-sidebar-chat'

/** Largest request body accepted, in bytes (images are uploaded raw). */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** How many finished runs keep their record around for diagnostics. */
const RUN_HISTORY = 20

/**
 * Resolve the harness home holding this deployment's data.
 *
 * `dshHomePath` is the harness' own resolver and the only authoritative answer;
 * `$DSH_HOME` and `~/.dsh` stay as fallbacks so a deployment that did not
 * export the variable still reads the home it booted with.
 *
 * @param ctx - host plugin context.
 * @returns an absolute harness home path.
 */
export function resolveHarnessHome(ctx) {
  const candidates = []
  try {
    const service = ctx?.get?.('dshHomePath')
    if (typeof service === 'function') candidates.push(service())
    else if (typeof service === 'string') candidates.push(service)
  } catch {
    // A missing service must not stop the plugin from loading.
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) candidates.push(fromEnv.trim())
  candidates.push(join(homedir(), '.dsh'))
  const usable = candidates.filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of usable) {
    if (existsSync(join(candidate, 'sessions'))) return resolve(candidate)
  }
  return resolve(usable[0] ?? join(homedir(), '.dsh'))
}

/**
 * Register the plugin.
 * @param ctx - host plugin context carrying `webServer` and `llm`.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const llm = ctx.get('llm')
  const home = resolveHarnessHome(ctx)
  const pluginDir = join(home, 'dsh-sidebar-chat')

  const conversations = new ConversationStore({ dir: join(pluginDir, 'conversations'), logger: ctx.logger })
  const temps = new TempStore({ logger: ctx.logger })

  /** Live turns by run id, so the tab's stop button can abort one. */
  const runs = new Map()

  // Temp-directory housekeeping: the OS owns the lifetime of that tree, this
  // only keeps it from growing without bound between system cleanups.
  temps
    .sweep()
    .then((dropped) => {
      if (dropped > 0) ctx.logger?.info?.(`[sidebar-chat] 清理了 ${dropped} 个过期附件`)
      ctx.logger?.info?.(`[sidebar-chat] 附件目录 ${temps.root}`)
    })
    .catch((error) => ctx.logger?.warn?.(`[sidebar-chat] 附件清理失败：${String(error)}`))

  const handlers = createHandlers({ ctx, llm, conversations, temps, runs })

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => {
          Promise.resolve(handlers(req, res)).catch((error) => {
            ctx.logger?.warn?.(`[sidebar-chat] 处理 ${req.url ?? ''} 失败：${String(error)}`)
            if (res.headersSent) {
              try {
                res.end()
              } catch {
                // The peer is already gone; nothing left to answer.
              }
              return
            }
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          })
        },
      }),
    'dsh-sidebar-chat: routes',
  )

  // A turn must not outlive the plugin: abort every in-flight provider call.
  ctx.effect(
    () => () => {
      for (const run of runs.values()) {
        try {
          run.controller.abort()
        } catch {
          // An already-settled controller is fine.
        }
      }
      runs.clear()
    },
    'dsh-sidebar-chat: in-flight turns',
  )

  ctx.logger?.info?.(`[sidebar-chat] 路由已注册：${ROUTE}（会话目录 ${conversations.dir}）`)
}

/**
 * Build the request dispatcher.
 *
 * @param deps - the plugin's stores and services.
 * @returns an async `(req, res)` handler covering every route under `ROUTE`.
 */
function createHandlers(deps) {
  const { ctx, llm, conversations, temps, runs } = deps

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && (path === '/' || path === '/info')) {
      return sendJson(res, 200, {
        ok: true,
        plugin: name,
        tempDir: temps.root,
        conversationsDir: conversations.dir,
        home: resolveHarnessHome(ctx),
        limits: { maxBodyBytes: MAX_BODY_BYTES },
        client: clientBundleStatus(ctx),
      })
    }

    if (path === '/models' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...(await listModels(ctx, llm, temps)) })
    }

    if (path === '/conversations' && method === 'GET') {
      return sendJson(res, 200, { ok: true, conversations: await conversations.list() })
    }

    if (path === '/conversations' && method === 'POST') {
      const body = await readJson(req)
      const fallback = currentDefaultSelection(ctx)
      const conversation = createConversation({
        provider: str(body.provider) || fallback.provider || '',
        model: str(body.model) || fallback.model || '',
        reasoningEffort: str(body.reasoningEffort) || fallback.reasoningEffort || '',
      })
      // Absent means on: a conversation made before the toggle existed keeps
      // searching, and one made after starts searching.
      conversation.search = body.search !== false
      if (typeof body.system === 'string') conversation.system = body.system
      await conversations.save(conversation)
      return sendJson(res, 200, { ok: true, conversation })
    }

    const conversationMatch = /^\/conversations\/([^/]+)$/.exec(path)
    if (conversationMatch !== null) {
      const id = decodeURIComponent(conversationMatch[1])
      if (method === 'GET') {
        const conversation = await conversations.get(id)
        if (conversation === undefined) return sendJson(res, 404, { ok: false, error: '会话不存在' })
        return sendJson(res, 200, { ok: true, conversation })
      }
      if (method === 'PATCH') {
        const conversation = await conversations.get(id)
        if (conversation === undefined) return sendJson(res, 404, { ok: false, error: '会话不存在' })
        const body = await readJson(req)
        if (typeof body.title === 'string' && body.title.trim().length > 0) conversation.title = body.title.trim().slice(0, 120)
        if (typeof body.system === 'string') conversation.system = body.system
        if (typeof body.provider === 'string') conversation.provider = body.provider
        if (typeof body.model === 'string') conversation.model = body.model
        if (typeof body.reasoningEffort === 'string') conversation.reasoningEffort = body.reasoningEffort
        conversation.updatedAt = Date.now()
        await conversations.save(conversation)
        return sendJson(res, 200, { ok: true, conversation })
      }
      if (method === 'DELETE') {
        const removed = await conversations.remove(id)
        return sendJson(res, removed ? 200 : 404, { ok: removed, ...(removed ? {} : { error: '会话不存在' }) })
      }
      return sendJson(res, 405, { ok: false, error: `不支持的方法 ${method}` })
    }

    if (path === '/attachments' && method === 'POST') {
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      const name = url.searchParams.get('name') ?? undefined
      const width = Number(url.searchParams.get('width'))
      const height = Number(url.searchParams.get('height'))
      const bytes = await readBody(req)
      if (bytes === undefined) return sendJson(res, 413, { ok: false, error: `请求体超过 ${MAX_BODY_BYTES} 字节` })
      try {
        const record = await temps.put({ bytes, mediaType: contentType, name, width, height })
        return sendJson(res, 200, { ok: true, attachment: publicAttachment(record) })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    }

    const attachmentMatch = /^\/attachments\/([^/]+)$/.exec(path)
    if (attachmentMatch !== null && method === 'GET') {
      const found = await temps.read(decodeURIComponent(attachmentMatch[1]))
      if (found === undefined) return sendJson(res, 404, { ok: false, error: '附件不存在或已被系统清理' })
      res.writeHead(200, {
        'Content-Type': found.record.mediaType,
        'Content-Length': String(found.bytes.byteLength),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(found.bytes)
      return undefined
    }

    if (path === '/chat' && method === 'POST') {
      return streamChat({ ctx, llm, conversations, temps, runs }, req, res)
    }

    if (path === '/stop' && method === 'POST') {
      const body = await readJson(req)
      const runId = str(body.runId)
      const run = runs.get(runId)
      if (run === undefined) return sendJson(res, 404, { ok: false, error: '该回合已结束' })
      run.controller.abort()
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { ok: false, error: `未知路由 ${method} ${path}` })
  }
}

/**
 * Whether this deployment mounted the harness' web-search seam.
 * @param ctx - host plugin context.
 * @returns true when `ctx.web.search` can be called.
 */
export function searchAvailable(ctx) {
  try {
    const web = ctx.get('web')
    return web !== null && web !== undefined && typeof web.search === 'function'
  } catch {
    return false
  }
}

/**
 * Run one `web_search` tool call against the harness' web seam.
 *
 * Queries run concurrently and their sources merge by URL, which is what the
 * harness' own tool does; a failed query fails the call, and the model is told
 * so rather than being handed half a result set.
 *
 * @param ctx - host plugin context.
 * @param call - the assembled tool call (its `arguments` are raw JSON).
 * @param signal - the turn's abort signal.
 * @returns `{ text, queries, sources }`: the model-facing text and the sources
 *   the tab lists.
 * @throws when the seam is missing, the queries are unusable, or a search fails.
 */
export async function runWebSearch(ctx, call, signal) {
  const web = ctx.get('web')
  if (web === null || web === undefined || typeof web.search !== 'function') {
    throw new Error('本次部署没有挂载联网搜索能力（ctx.web）')
  }
  const queries = sanitizeQueries(parseQueries(call.arguments))
  if (queries.length === 0) throw new Error('web_search 需要至少一个可用的搜索词')

  const settled = await Promise.all(
    queries.map((query) => web.search({ query, maxResults: SEARCH_MAX_RESULTS }, signal)),
  )
  const sources = []
  const seen = new Set()
  let content
  for (const result of settled) {
    if (result === null || typeof result !== 'object') continue
    if (content === undefined && typeof result.content === 'string' && result.content.length > 0) content = result.content
    for (const source of Array.isArray(result.sources) ? result.sources : []) {
      if (source === null || typeof source !== 'object' || typeof source.url !== 'string' || seen.has(source.url)) continue
      seen.add(source.url)
      sources.push(source)
    }
  }
  const capped = sources.slice(0, SEARCH_MAX_RESULTS)
  const text = formatSearchResult({
    ...(content === undefined ? {} : { content }),
    sources: capped,
    truncated: sources.length > capped.length || settled.some((result) => result?.truncated === true),
  })
  return { text, queries, sources: capped }
}

/**
 * Report whether this package's browser half reached the client module graph.
 *
 * `clientModules` composes one entry per Loader row whose package.json declares
 * `dsh.client`; the tab cannot appear if that entry is missing (a stale profile
 * link, a hand-edited row, a manifest without the declaration). The tab's own
 * route is otherwise silent about this, so it is surfaced here rather than left
 * to guesswork.
 *
 * @param ctx - host plugin context.
 * @returns `{ registered, revision? }`, or `{ registered: null }` when the
 *   client-modules service is not mounted in this deployment.
 */
function clientBundleStatus(ctx) {
  try {
    const modules = ctx.get('clientModules')
    const graph = modules?.graph?.()
    if (graph === undefined || !Array.isArray(graph.entries)) return { registered: null }
    const entry = graph.entries.find((row) => row.id === name)
    return entry === undefined ? { registered: false } : { registered: true, revision: entry.rev, url: entry.url }
  } catch {
    return { registered: null }
  }
}

/**
 * Stream one assistant turn as server-sent events.
 *
 * Event payloads are the `chat.js` stream events, each tagged with `runId`:
 * `start`, `delta`, `reasoning`, `usage`, `notice`, then exactly one `done`
 * or `error`. Deltas are folded into the transcript here rather than in the
 * browser, so what the tab shows live and what a reload shows are the same
 * text; the assistant message is committed in `finally`, before the stream is
 * closed, and the client re-reads the transcript afterwards.
 *
 * @param deps - the plugin's stores and services.
 * @param req - the POST request carrying `{ conversationId, text, ... }`.
 * @param res - the response to stream on.
 */
async function streamChat(deps, req, res) {
  const { ctx, llm, conversations, temps, runs } = deps
  const body = await readJson(req)
  const conversationId = str(body.conversationId)
  const conversation = conversationId === '' ? undefined : await conversations.get(conversationId)
  if (conversation === undefined) return sendJson(res, 404, { ok: false, error: '会话不存在' })

  const text = String(body.text ?? '')
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((id) => typeof id === 'string') : []
  if (text.trim().length === 0 && attachmentIds.length === 0) {
    return sendJson(res, 400, { ok: false, error: '消息为空' })
  }

  // Routing is per turn: the tab may switch model mid-conversation, and the
  // choice is remembered on the conversation so a reload keeps it.
  if (typeof body.provider === 'string' && body.provider.length > 0) conversation.provider = body.provider
  if (typeof body.model === 'string' && body.model.length > 0) conversation.model = body.model
  if (typeof body.reasoningEffort === 'string') conversation.reasoningEffort = body.reasoningEffort
  if (typeof body.system === 'string') conversation.system = body.system
  // The 联网 toggle rides on the conversation, so reopening the tab keeps it.
  if (typeof body.search === 'boolean') conversation.search = body.search

  const userMessage = {
    id: newMessageId(),
    role: 'user',
    text,
    attachments: [],
    at: Date.now(),
  }
  for (const id of attachmentIds) {
    const record = await temps.resolve(id)
    if (record === undefined) continue
    userMessage.attachments.push(publicAttachment(record))
  }
  if (conversation.messages.length === 0 && text.trim().length > 0) conversation.title = deriveTitle(text)
  conversation.messages.push(userMessage)
  conversation.updatedAt = Date.now()
  await conversations.save(conversation)

  const runId = `r-${newMessageId().slice(2)}`
  const controller = new AbortController()
  runs.set(runId, { controller, conversationId: conversation.id })
  while (runs.size > RUN_HISTORY) runs.delete(runs.keys().next().value)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (event) => {
    if (res.writableEnded) return false
    res.write(`data: ${JSON.stringify({ runId, ...event })}\n\n`)
    return true
  }

  // Abandoning the connection (tab closed, navigate away) stops the provider
  // call rather than paying for a response nobody will read.
  req.on('close', () => controller.abort())

  send({ type: 'start', conversationId: conversation.id, userMessage, provider: conversation.provider, model: conversation.model })

  let assistant = {
    id: newMessageId(),
    role: 'assistant',
    text: '',
    reasoning: '',
    at: Date.now(),
    status: 'streaming',
    provider: conversation.provider,
    model: conversation.model,
  }
  /**
   * How long the thinking trace took to arrive, in milliseconds.
   *
   * The tab heads the trace with the chat web's own "已思考（用时 N 秒）", and a
   * reload has to show the same number the live turn did — so the span is
   * measured here, where the events actually land, and stored on the message.
   */
  let reasoningFrom = 0
  let reasoningTo = 0
  /**
   * When this turn started, for the tally line under the answer.
   *
   * The tab prints "耗时 N 秒" beside the token counts, and a reload has to
   * show the number the live turn did — so the span is measured where the
   * reader's wait actually happened (prompt assembly, provider call, any web
   * searches) and stored on the message, like `reasoningMs` above.
   */
  const turnFrom = Date.now()
  /** Web searches this turn ran, kept on the message so a reload shows them. */
  let toolActivity = []

  /**
   * Whether this turn may search.
   *
   * `search` is absent on conversations created before the toggle existed, and
   * absent means on — matching what the tab shows — so only an explicit
   * `false` turns searching off.
   */
  const wantsSearch = conversation.search !== false
  const searchOn = wantsSearch && searchAvailable(ctx)
  if (conversation.search === true && !searchOn) {
    send({ type: 'notice', level: 'warning', code: 'SEARCH_UNAVAILABLE', message: '本次部署没有挂载联网搜索能力，这一轮按普通对话回答。' })
  }

  try {
    const visionWarning = await visionNotice({ llm, conversation, userMessage })
    if (visionWarning !== undefined) send({ type: 'notice', ...visionWarning })

    const messages = await buildMessages(conversation, {
      admitImages: (message) => admitMessageImages(ctx, temps, message),
    })

    for await (const event of runTurn({
      llm,
      provider: conversation.provider,
      model: conversation.model,
      reasoningEffort: conversation.reasoningEffort,
      messages,
      system: buildSystemPrompt(conversation, searchOn),
      tools: searchOn ? [WEB_SEARCH_TOOL] : [],
      maxRounds: searchOn ? DEFAULT_MAX_ROUNDS : 1,
      executeTool: (call, signal) => runWebSearch(ctx, call, signal),
      signal: controller.signal,
    })) {
      // The transcript is folded here, not in the browser: what the tab shows
      // live and what a reload shows must be the same text, and only the host
      // survives the tab closing mid-turn.
      if (event.type === 'delta') {
        assistant.text += event.text
        send(event)
        continue
      }
      if (event.type === 'reasoning') {
        const at = Date.now()
        if (reasoningFrom === 0) reasoningFrom = at
        reasoningTo = at
        assistant.reasoning += event.text
        send(event)
        continue
      }
      if (event.type === 'usage') {
        assistant.usage = event.usage
        send(event)
        continue
      }
      if (event.type === 'error') {
        assistant.status = event.code === 'ABORTED' ? 'aborted' : 'error'
        assistant.text = event.text ?? assistant.text
        assistant.reasoning = event.reasoning ?? assistant.reasoning
        if (event.usage !== undefined) assistant.usage = event.usage
        assistant.error = { code: event.code, message: event.message }
        send({ type: 'error', code: event.code, message: event.message })
        break
      }
      if (event.type === 'tool') {
        toolActivity = upsertToolActivity(toolActivity, event)
        send(event)
        continue
      }
      // A `done` event only closes the turn: its text is already folded from
      // the deltas above.
      if (event.usage !== undefined) assistant.usage = event.usage
      if (typeof event.notice === 'string' && event.notice.length > 0) {
        send({ type: 'notice', level: 'warning', message: event.notice })
      }
      send({ type: 'done' })
    }
  } catch (error) {
    const failure = describeFailure(error, { provider: conversation.provider, model: conversation.model })
    assistant.status = failure.code === 'ABORTED' ? 'aborted' : 'error'
    assistant.error = failure
    send({ type: 'error', ...failure })
  } finally {
    runs.delete(runId)
    if (assistant.status === 'streaming') assistant.status = 'done'
    const turnTo = Date.now()
    assistant.at = turnTo
    // Never zero: a turn that answered instantly still took a measurable moment,
    // and the tab would rather print "0.1 秒" than nothing at all.
    assistant.durationMs = Math.max(1, turnTo - turnFrom)
    if (reasoningTo > reasoningFrom) assistant.reasoningMs = reasoningTo - reasoningFrom
    if (toolActivity.length > 0) assistant.tools = toolActivity
    // An assistant turn with neither text nor reasoning is still recorded, so
    // the failure stays visible in history; `buildMessages` skips it when the
    // next request is assembled.
    conversation.messages.push(assistant)
    conversation.updatedAt = Date.now()
    try {
      await conversations.save(conversation)
    } catch (error) {
      ctx.logger?.warn?.(`[sidebar-chat] 保存会话失败：${String(error)}`)
    }
    if (!res.writableEnded) {
      try {
        res.end()
      } catch {
        // The client already disconnected.
      }
    }
  }
  return undefined
}

/**
 * The system prompt for one turn: the conversation's own, plus the search
 * instruction while the 联网 toggle is on.
 * @param conversation - the conversation being answered.
 * @param searchOn - whether this turn may search.
 * @returns the system prompt text.
 */
function buildSystemPrompt(conversation, searchOn) {
  const base =
    typeof conversation.system === 'string' && conversation.system.length > 0 ? conversation.system : DEFAULT_SYSTEM_PROMPT
  return searchOn ? `${base}\n\n${SEARCH_INSTRUCTION}` : base
}

/**
 * Fold one tool event into the turn's activity list.
 * @param activity - the activity rows so far.
 * @param event - a `start` / `done` / `error` event for one call.
 * @returns the updated rows (the same array when nothing changed).
 */
function upsertToolActivity(activity, event) {
  const at = activity.findIndex((row) => row.id === event.id)
  const row = {
    id: event.id,
    name: event.name,
    queries: event.queries ?? [],
    status: event.phase === 'start' ? 'running' : event.phase,
    at: at >= 0 ? activity[at].at : Date.now(),
    ...(event.sources === undefined ? {} : { sources: event.sources }),
    ...(event.message === undefined ? {} : { message: event.message }),
  }
  if (at < 0) return activity.concat([row])
  const next = activity.slice()
  next[at] = row
  return next
}

/**
 * Warn when the chosen model cannot see the images in this turn.
 *
 * The framework degrades silently (each image becomes a "text-only model"
 * placeholder), which looks like the model ignoring the picture — so the tab
 * says it out loud instead.
 *
 * @param options - the turn's routing and the message being sent.
 * @returns a notice payload, or undefined when there is nothing to warn about.
 */
async function visionNotice(options) {
  if ((options.userMessage.attachments ?? []).length === 0) return undefined
  let info
  try {
    info = await options.llm.resolveModelInfo(options.conversation.provider, options.conversation.model)
  } catch {
    return undefined
  }
  if (modelSeesImages(info)) return undefined
  return {
    level: 'warning',
    code: 'TEXT_ONLY_MODEL',
    message: `当前模型 ${options.conversation.model} 不支持图片输入，这次的图片会被替换成占位文字。想看图请换一个带「图片」标记的模型。`,
  }
}

/**
 * Admit one message's temp files into the harness attachment store.
 *
 * A provider adapter can only read an image through a durable attachment
 * reference, so the bytes stored in the system temp directory are handed to
 * `ctx.attachments` once and the reference is written back onto the message,
 * which keeps later turns free of re-encoding.
 *
 * Each image is admitted on its own: an image the store refuses (corrupt bytes,
 * an unsupported raster, a byte the system already cleaned away) is marked on
 * the message and left out of the request, instead of failing the turn — and
 * every later turn — for the whole conversation.
 *
 * @param ctx - host plugin context.
 * @param temps - this plugin's temp store.
 * @param message - the transcript message whose attachments are being sent.
 * @returns attachment references by this plugin's attachment id.
 */
async function admitMessageImages(ctx, temps, message) {
  const refs = new Map()
  const attachments = ctx.get('attachments')
  for (const attachment of message.attachments ?? []) {
    if (attachment.ref !== undefined || attachment.error !== undefined) continue

    const stored = await temps.read(attachment.id)
    if (stored === undefined) {
      attachment.error = { code: 'ATTACHMENT_GONE', message: '附件已被系统清理，无法再发送' }
      continue
    }
    if (attachments === undefined) {
      attachment.error = {
        code: 'NO_ATTACHMENT_SERVICE',
        message: '附件服务未挂载（ctx.attachments），无法把图片发给模型；请改用文字，或在 DSH 中启用 dsh-attachment-local。',
      }
      continue
    }
    try {
      const [ref] = await attachments.saveImages([
        { data: stored.bytes, mediaType: stored.record.mediaType, name: stored.record.name },
      ])
      refs.set(attachment.id, ref)
    } catch (error) {
      // The attachment store wraps the decoder's own failure as `cause`; that
      // inner message is the only thing that says *why* the bytes were refused.
      const cause = error?.cause?.message
      const detail = String(error?.message ?? error)
      attachment.error = {
        code: typeof error?.code === 'string' ? error.code : 'IMAGE_REJECTED',
        message: typeof cause === 'string' && cause.length > 0 ? `${detail}（${cause}）` : detail,
      }
      ctx.logger?.warn?.(`[sidebar-chat] 附件 ${attachment.id}（${stored.record.name}）无法作为图片读取：${attachment.error.message}`)
    }
  }
  return refs
}

/**
 * Project the harness model catalog into what the tab renders.
 *
 * This mirrors the composition the stock model picker uses (`llm.listProviders`
 * → `llm.listModels` → `llm.resolveModelInfo`), with per-provider failures
 * isolated instead of thrown, plus the two facts the picker does not carry:
 * whether the route accepts images, and its context window.
 *
 * @param ctx - host plugin context.
 * @param llm - the `llm` service.
 * @param temps - the temp store, reported so the tab can show where files go.
 * @returns the catalog payload.
 */
async function listModels(ctx, llm, temps) {
  const groups = []
  const failures = []
  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id)
      const entries = []
      for (const model of models) {
        let info
        try {
          info = await llm.resolveModelInfo(provider.id, model.id)
        } catch {
          info = undefined
        }
        entries.push({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          image: modelSeesImages(info) || model.inputModalities?.includes('image') === true,
          ...(info?.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow }),
          ...(info?.reasoning === undefined
            ? {}
            : {
                reasoning: {
                  efforts: info.reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name })),
                  ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
                },
              }),
        })
      }
      if (entries.length > 0) groups.push({ id: provider.id, name: provider.name, models: entries })
    } catch (error) {
      failures.push({ id: provider.id, name: provider.name, message: String(error?.message ?? error) })
    }
  }
  return { default: currentDefaultSelection(ctx), groups, failures, tempDir: temps.root, search: searchAvailable(ctx) }
}

/**
 * The harness' current default model selection, when the service is mounted.
 * @param ctx - host plugin context.
 * @returns `{ provider, model, reasoningEffort }`, with empty strings when unknown.
 */
function currentDefaultSelection(ctx) {
  try {
    const selected = ctx.get('agentDefaultModel')?.currentSelection?.()
    return {
      provider: str(selected?.provider),
      model: str(selected?.model),
      reasoningEffort: str(selected?.reasoningEffort),
    }
  } catch {
    return { provider: '', model: '', reasoningEffort: '' }
  }
}

/** The attachment fields the browser is allowed to see. */
function publicAttachment(record) {
  return {
    id: record.id,
    name: record.name,
    mediaType: record.mediaType,
    bytes: record.bytes,
    ...(record.width === undefined ? {} : { width: record.width }),
    ...(record.height === undefined ? {} : { height: record.height }),
    createdAt: record.createdAt,
  }
}

/** Answer one JSON response. */
function sendJson(res, status, value) {
  if (res.writableEnded) return undefined
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
  return undefined
}

/** Read a request body as bytes, refusing (not truncating) an oversized one. */
async function readBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    req.destroy()
    return undefined
  }
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > limit) {
      req.destroy()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Read a JSON request body; an empty or malformed body reads as `{}`. */
async function readJson(req, limit = MAX_BODY_BYTES) {
  const bytes = await readBody(req, limit)
  if (bytes === undefined || bytes.byteLength === 0) return {}
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Coerce to a string, empty when absent. */
function str(value) {
  return typeof value === 'string' ? value : ''
}
