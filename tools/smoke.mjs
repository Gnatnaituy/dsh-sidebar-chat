/**
 * Live smoke test for a running DSH harness.
 *
 * Exercises the plugin's own routes end to end: catalog, conversation,
 * temp-file upload, a streamed turn with an image, the text-only-model notice,
 * and the stop button. It creates one conversation, then deletes it, so a
 * successful run leaves nothing behind but the attachment it uploaded (which
 * lives in the system temp directory).
 *
 * Usage:
 *   node tools/smoke.mjs [--base http://127.0.0.1:19387] [--model provider/model]
 *                        [--text-model provider/model] [--keep]
 *
 * Without `--model` it picks the first image-capable model the deployment
 * advertises; without `--text-model` it picks the first text-only one. Both
 * defaults are skipped (with a note) when the deployment offers none.
 */

import { deflateSync } from 'node:zlib'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const keep = argv.includes('--keep')
const base = option('--base', process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/$/, '')
const route = `${base}/dsh-sidebar-chat`

let failures = 0

/**
 * Report one check.
 * @param label - what was checked.
 * @param ok - whether it held.
 * @param detail - optional evidence for the line.
 */
function check(label, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Call one JSON route. */
async function api(path, options) {
  const response = await fetch(`${route}${path}`, options)
  const text = await response.text()
  let parsed
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${path} answered non-JSON: ${text.slice(0, 200)}`)
  }
  if (!response.ok || parsed.ok === false) throw new Error(`${path}: ${parsed.error ?? response.status}`)
  return parsed
}

/** CRC-32 of one buffer, for the PNG chunks below. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * A tiny but genuinely valid PNG, so the attachment store's decoder accepts it.
 * @param size - width and height in pixels.
 * @returns the encoded bytes.
 */
function makePng(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0
    for (let x = 0; x < size; x += 1) {
      const at = y * (size * 3 + 1) + 1 + x * 3
      raw[at] = (x * 255) / size
      raw[at + 1] = (y * 255) / size
      raw[at + 2] = 160
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Run one turn and collect its events.
 * @param body - the `/chat` request.
 * @param onEvent - called per event; may return `'stop'` to end early.
 * @returns every event seen.
 */
async function turn(body, onEvent) {
  const response = await fetch(`${route}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`/chat: HTTP ${response.status} ${await response.text()}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let boundary
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const event = JSON.parse(line.slice(5).trim())
        events.push(event)
        if (onEvent?.(event) === 'stop') {
          await reader.cancel()
          return events
        }
      }
    }
  }
  return events
}

/** Pick the first model matching a capability filter. */
function pickModel(groups, wantsImage) {
  for (const group of groups) {
    for (const model of group.models) {
      if (model.image === wantsImage) return { provider: group.id, model: model.id }
    }
  }
  return undefined
}

/**
 * Poll until a probe answers with something, or give up.
 * @param probe - async () => value | undefined.
 * @param timeoutMs - how long to keep trying.
 * @returns the first non-undefined value, or undefined on timeout.
 */
async function waitFor(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const info = await api('/')
console.log(`harness: ${base}`)
console.log(`temp dir: ${info.tempDir}`)
console.log(`client half: ${info.client?.registered === true ? `composed (rev ${info.client.revision})` : info.client?.registered === false ? 'NOT in the module graph' : 'client-modules not mounted'}`)
console.log('')

const catalog = await api('/models')
check('模型目录可读', catalog.groups.length > 0, `${catalog.groups.length} 个供应商，${catalog.groups.reduce((sum, group) => sum + group.models.length, 0)} 个模型`)
check('联网搜索可用性已上报', typeof catalog.search === 'boolean', catalog.search ? '本次部署已挂载搜索' : '本次部署没有搜索能力')
check('模型带图片能力标记', catalog.groups.some((group) => group.models.some((model) => model.image === true)))
check('默认模型已解析', typeof catalog.default?.provider === 'string')

const [wantedProvider, wantedModel] = option('--model', '').split('/')
const vision = wantedProvider !== undefined && wantedProvider !== '' ? { provider: wantedProvider, model: wantedModel } : pickModel(catalog.groups, true)
const [textProvider, textModel] = option('--text-model', '').split('/')
const textOnly = textProvider !== undefined && textProvider !== '' ? { provider: textProvider, model: textModel } : pickModel(catalog.groups, false)

const created = await api('/conversations', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(vision ?? catalog.default),
})
const conversationId = created.conversation.id
check('新建会话', typeof conversationId === 'string' && conversationId.length > 0, conversationId)

const png = makePng(16)
const uploaded = await api(`/attachments?name=smoke.png&width=16&height=16`, {
  method: 'POST',
  headers: { 'content-type': 'image/png' },
  body: png,
})
const attachmentId = uploaded.attachment.id
check('图片落盘临时目录', typeof attachmentId === 'string', `${uploaded.attachment.bytes} 字节`)
check('上传的字节原样可取回', Buffer.compare(Buffer.from(await (await fetch(`${route}/attachments/${attachmentId}`)).arrayBuffer()), png) === 0)

if (vision !== undefined) {
  const events = await turn({
    conversationId,
    text: '这张图是什么颜色？只回答颜色。',
    attachmentIds: [attachmentId],
    provider: vision.provider,
    model: vision.model,
  })
  const text = events.filter((event) => event.type === 'delta').map((event) => event.text).join('')
  check(`图片回合（${vision.provider}/${vision.model}）`,
    events.some((event) => event.type === 'done') && text.length > 0,
    text.replace(/\s+/g, ' ').slice(0, 60))
  check('图片回合无错误事件', !events.some((event) => event.type === 'error'))
} else {
  console.log('  skip  图片回合：这个部署没有声明支持图片的模型')
}

if (textOnly !== undefined) {
  const events = await turn({
    conversationId,
    text: '收到了吗？',
    attachmentIds: [attachmentId],
    provider: textOnly.provider,
    model: textOnly.model,
  })
  check(`纯文本模型给出降级提示（${textOnly.provider}/${textOnly.model}）`,
    events.some((event) => event.type === 'notice' && event.code === 'TEXT_ONLY_MODEL'))
} else {
  console.log('  skip  纯文本模型提示：这个部署没有纯文本模型')
}

if (catalog.search === true && vision !== undefined && !argv.includes('--skip-search')) {
  // Search is model-driven, so the prompt names the tool: the check is about
  // the seam and the loop, not about a model's willingness to browse.
  const events = await turn({
    conversationId,
    text: '请先用 web_search 工具搜索 “DeepSeek Harness”，然后用一句话总结并给出你引用的来源链接。',
    provider: vision.provider,
    model: vision.model,
    search: true,
  })
  const started = events.filter((event) => event.type === 'tool' && event.phase === 'start')
  const finished = events.filter((event) => event.type === 'tool' && event.phase === 'done')
  const sources = finished.flatMap((event) => event.sources ?? [])
  check('模型发起了联网搜索', started.length > 0, started.flatMap((event) => event.queries ?? []).join(' / '))
  check('搜索结果带来源', sources.length > 0, `${sources.length} 个来源，例如 ${sources[0]?.url ?? '—'}`)
  check('搜索后仍以正文收尾', events.some((event) => event.type === 'done'))

  const withTools = await api(`/conversations/${conversationId}`)
  const toolMessage = withTools.conversation.messages.filter((message) => Array.isArray(message.tools) && message.tools.length > 0).pop()
  check('搜索活动写入历史', toolMessage !== undefined && (toolMessage.tools.at(-1).sources ?? []).length > 0)
} else if (catalog.search !== true) {
  console.log('  skip  联网搜索：本次部署没有挂载搜索能力')
}

if (vision !== undefined) {
  // Stop the turn from inside the stream: the first delta proves the provider
  // call is live, so the abort cannot be a no-op racing an idle connection.
  const events = await turn(
    {
      conversationId,
      text: '从 1 数到 200，每个数字一行。',
      provider: vision.provider,
      model: vision.model,
    },
    (event) => {
      if (event.type !== 'delta') return undefined
      fetch(`${route}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: event.runId }),
      }).catch(() => {})
      return 'stop'
    },
  )
  check('停止按钮中止回合', events.some((event) => event.type === 'delta'))

  // The host commits the aborted turn in its own `finally`, on the other side
  // of a socket the client just walked away from, so wait for the write rather
  // than assuming it already happened.
  const aborted = await waitFor(async () => {
    const settled = await api(`/conversations/${conversationId}`)
    const last = settled.conversation.messages.at(-1)
    return last?.role === 'assistant' ? last : undefined
  })
  check('中止的回合仍写入历史', aborted?.status === 'aborted', aborted === undefined ? '5 秒内没有写入' : `status=${aborted.status}`)
}

const settled = await api(`/conversations/${conversationId}`)
const roles = settled.conversation.messages.map((message) => message.role)
check('回合写回历史', roles.includes('user') && roles.includes('assistant'), roles.join(','))
const assistant = settled.conversation.messages.filter((message) => message.role === 'assistant')
check('助手正文已持久化', assistant.some((message) => (message.text ?? '').length > 0))
// The tally line the tab prints is read back from the transcript, so every
// turn this build produced has to carry its own clock — the aborted one
// included, since the tab names its elapsed time too.
check(
  '回合耗时写入历史',
  assistant.length > 0 && assistant.every((message) => typeof message.durationMs === 'number' && message.durationMs > 0),
  assistant.map((message) => `${message.status}=${message.durationMs}ms`).join(' / '),
)

if (keep) {
  console.log(`\n保留会话 ${conversationId}（--keep）`)
} else {
  await api(`/conversations/${conversationId}`, { method: 'DELETE' })
  console.log(`\n已删除测试会话 ${conversationId}`)
}
console.log(`附件 ${attachmentId} 留在临时目录，由系统清理`)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
