/**
 * Unit tests for the parts of dsh-sidebar-chat that do not need a harness:
 * the temp-file store, the transcript store, and transcript→message building.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  WEB_SEARCH_TOOL,
  buildMessages,
  describeFailure,
  formatSearchResult,
  modelSeesImages,
  parseQueries,
  repairArguments,
  runTurn,
  sanitizeQueries,
  streamTurn,
} from '../lib/chat.js'
import { ConversationStore, createConversation, deriveTitle, summaryOf } from '../lib/conversations.js'
import { TempStore, safeDisplayName } from '../lib/temps.js'

/** A one-pixel PNG, so the stores deal with real bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-chat-test-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('TempStore', () => {
  it('stores bytes under the temp root and reads them back', async () => {
    const store = new TempStore({ root: join(root, 'temps') })
    const record = await store.put({ bytes: PNG, mediaType: 'image/png', name: 'shot.png', width: 1, height: 1 })

    assert.equal(record.mediaType, 'image/png')
    assert.equal(record.name, 'shot.png')
    assert.equal(record.bytes, PNG.byteLength)
    assert.ok(record.path.startsWith(store.root), `${record.path} must live under ${store.root}`)

    const found = await store.read(record.id)
    assert.equal(found.record.id, record.id)
    assert.deepEqual(Buffer.from(found.bytes), PNG)
  })

  it('refuses an unsupported media type and an empty payload', async () => {
    const store = new TempStore({ root: join(root, 'temps') })
    await assert.rejects(() => store.put({ bytes: PNG, mediaType: 'application/pdf' }), /不支持的附件类型/)
    await assert.rejects(() => store.put({ bytes: Buffer.alloc(0), mediaType: 'image/png' }), /内容为空/)
  })

  it('rebuilds its index from the files when the index is lost', async () => {
    const dir = join(root, 'rebuild')
    const first = new TempStore({ root: dir })
    const record = await first.put({ bytes: PNG, mediaType: 'image/png', name: 'a.png' })

    await rm(first.indexPath, { force: true })
    const second = new TempStore({ root: dir })
    const listed = await second.list()

    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, record.id)
    assert.equal(listed[0].mediaType, 'image/png')
  })

  it('drops an attachment the system already cleaned off disk', async () => {
    const store = new TempStore({ root: join(root, 'gone') })
    const record = await store.put({ bytes: PNG, mediaType: 'image/png' })
    await rm(record.path, { force: true })

    assert.equal(await store.read(record.id), undefined)
    assert.deepEqual(await store.list(), [])
  })

  it('sweeps records unused beyond the retention window, and orphan bytes', async () => {
    const store = new TempStore({ root: join(root, 'sweep') })
    const old = await store.put({ bytes: PNG, mediaType: 'image/png', name: 'old.png' })
    const fresh = await store.put({ bytes: PNG, mediaType: 'image/png', name: 'fresh.png' })

    // Age the first record by hand: fifteen days past any retention window.
    const index = JSON.parse(await readFile(store.indexPath, 'utf8'))
    index.records[old.id].createdAt = Date.now() - 15 * 24 * 60 * 60 * 1000
    index.records[old.id].usedAt = index.records[old.id].createdAt
    await writeFile(store.indexPath, JSON.stringify(index))

    const orphan = join(store.root, 'files', 'a-orphan.png')
    await writeFile(orphan, PNG)

    const reloaded = new TempStore({ root: store.root })
    assert.equal(await reloaded.sweep(), 1)
    assert.deepEqual(
      (await reloaded.list()).map((row) => row.id),
      [fresh.id],
    )
    await assert.rejects(() => readFile(orphan), /ENOENT/)
  })

  it('keeps a display name readable without letting it escape the directory', () => {
    assert.equal(safeDisplayName('../../etc/passwd', 'fallback'), '.._.._etc_passwd')
    assert.equal(safeDisplayName('   ', 'fallback'), 'fallback')
    assert.equal(safeDisplayName(undefined, 'fallback'), 'fallback')
  })
})

describe('ConversationStore', () => {
  /** A store rooted in this test file's own directory. */
  const makeStore = (name) => new ConversationStore({ dir: join(root, 'conversations', name) })

  it('saves, lists, reads and deletes a conversation', async () => {
    const store = makeStore('crud')
    const conversation = createConversation({ provider: 'deepseek-account', model: 'deepseek-flash' })
    conversation.messages.push({ id: 'm-1', role: 'user', text: '你好', attachments: [], at: Date.now() })
    conversation.title = deriveTitle('你好')
    await store.save(conversation)

    const listed = await store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].title, '你好')
    assert.equal(listed[0].messageCount, 1)
    assert.equal(listed[0].preview, '你好')

    const loaded = await store.get(conversation.id)
    assert.equal(loaded.messages[0].text, '你好')

    assert.equal(await store.remove(conversation.id), true)
    assert.equal(await store.remove(conversation.id), false)
    assert.deepEqual(await store.list(), [])
  })

  it('rebuilds the index from the transcripts when index.json is lost', async () => {
    const store = makeStore('rebuild')
    const first = createConversation({ provider: 'p', model: 'm' })
    first.messages.push({ id: 'm-1', role: 'user', text: 'one', attachments: [], at: 1 })
    const second = createConversation({ provider: 'p', model: 'm' })
    second.messages.push({ id: 'm-2', role: 'user', text: 'two', attachments: [], at: 2 })
    await store.save(first)
    await store.save(second)

    await rm(join(store.dir, 'index.json'), { force: true })
    const reopened = makeStore('rebuild')
    const ids = (await reopened.list()).map((row) => row.id).sort()
    assert.deepEqual(ids, [first.id, second.id].sort())
  })

  it('ignores a corrupt transcript instead of failing the whole list', async () => {
    const store = makeStore('corrupt')
    const good = createConversation({ provider: 'p', model: 'm' })
    await store.save(good)
    await writeFile(join(store.dir, 'c-broken.json'), '{ not json')

    const reopened = makeStore('corrupt')
    assert.equal((await reopened.list()).length, 1)
  })

  it('summarizes the newest text as the preview', () => {
    const conversation = createConversation({})
    conversation.messages.push({ role: 'user', text: 'first' })
    conversation.messages.push({ role: 'assistant', text: 'second' })
    assert.equal(summaryOf(conversation).preview, 'second')
  })
})

describe('deriveTitle', () => {
  it('flattens, clips and defaults', () => {
    assert.equal(deriveTitle('  你好\n世界  '), '你好 世界')
    assert.equal(deriveTitle(''), '新对话')
    assert.equal(deriveTitle('x'.repeat(80)).length, 40)
  })
})

describe('buildMessages', () => {
  it('maps a transcript onto provider messages and skips empty turns', async () => {
    const conversation = createConversation({ provider: 'deepseek-account', model: 'deepseek-flash' })
    conversation.messages.push(
      { id: 'u1', role: 'user', text: '看图', attachments: [], at: 1 },
      { id: 'a1', role: 'assistant', text: '看到了', reasoning: '让我看看', status: 'done', at: 2 },
      { id: 'u2', role: 'user', text: '', attachments: [{ id: 'att', ref: { attachmentId: 'sha256:x' } }], at: 3 },
      { id: 'a2', role: 'assistant', text: '', reasoning: '', status: 'error', at: 4 },
    )

    const messages = await buildMessages(conversation)
    assert.equal(messages.length, 3)
    assert.deepEqual(messages[0].role, 'user')
    assert.deepEqual(messages[0].content, [{ type: 'text', text: '看图' }])
    assert.deepEqual(messages[1].source, { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' })
    assert.deepEqual(messages[1].content, [{ type: 'text', text: '看到了' }])
    assert.deepEqual(messages[2].content, [{ type: 'image', attachment: { attachmentId: 'sha256:x' } }])
  })

  it('replays reasoning only when asked to', async () => {
    const conversation = createConversation({ provider: 'p', model: 'm' })
    conversation.messages.push({ id: 'a1', role: 'assistant', text: 'answer', reasoning: 'thinking', at: 1 })
    const withReasoning = await buildMessages(conversation, { includeReasoning: true })
    assert.deepEqual(withReasoning[0].content, [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('admits a temp attachment through the caller when no reference is stored yet', async () => {
    const conversation = createConversation({ provider: 'p', model: 'm' })
    const attachment = { id: 'a-1', mediaType: 'image/png', name: 'x.png' }
    conversation.messages.push({ id: 'u1', role: 'user', text: '', attachments: [attachment], at: 1 })

    const seen = []
    const messages = await buildMessages(conversation, {
      admitImages: async (message) => {
        seen.push(message.id)
        return new Map([['a-1', { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }]])
      },
    })
    assert.deepEqual(seen, ['u1'])
    assert.equal(messages[0].content[0].attachment.attachmentId, 'sha256:abc')
    // The reference is written back so the next turn does not re-encode.
    assert.equal(attachment.ref.attachmentId, 'sha256:abc')
  })

  it('drops a user message whose only attachment could not be admitted', async () => {
    const conversation = createConversation({ provider: 'p', model: 'm' })
    conversation.messages.push({ id: 'u1', role: 'user', text: '', attachments: [{ id: 'a-1' }], at: 1 })
    const messages = await buildMessages(conversation, { admitImages: async () => new Map() })
    assert.deepEqual(messages, [])
  })
})

describe('streamTurn', () => {
  /** A fake `llm` service streaming the given chunks. */
  const fakeLlm = (chunks) => ({
    stream() {
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  })

  /** Collect a turn's events. */
  const collect = async (options) => {
    const events = []
    for await (const event of streamTurn(options)) events.push(event)
    return events
  }

  it('accumulates text and reasoning and ends with one done', async () => {
    const events = await collect({
      llm: fakeLlm([
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '想' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '你' },
        { type: 'text-delta', index: 1, text: '好' },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
      provider: 'p',
      model: 'm',
      messages: [],
    })

    assert.deepEqual(events.map((event) => event.type), ['reasoning', 'delta', 'delta', 'usage', 'done'])
    const done = events.at(-1)
    assert.equal(done.text, '你好')
    assert.equal(done.reasoning, '想')
    assert.deepEqual(done.usage, { inputTokens: 3, outputTokens: 2 })
  })

  it('turns a terminal error chunk into an error event carrying the partial text', async () => {
    const events = await collect({
      llm: fakeLlm([
        { type: 'text-delta', index: 0, text: '部分' },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } } },
      ]),
      provider: 'p',
      model: 'm',
      messages: [],
    })

    const error = events.at(-1)
    assert.equal(error.type, 'error')
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.text, '部分')
    assert.match(error.message, /p \/ m：slow down/)
    assert.match(error.message, /限流/)
  })

  it('reports a synchronous throw from the service as an error event', async () => {
    const events = await collect({
      llm: {
        stream() {
          throw new Error('no adapter registered for provider "nope"')
        },
      },
      provider: 'nope',
      model: 'm',
      messages: [],
    })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'error')
    assert.match(events[0].message, /no adapter/)
  })

  it('reports an abort distinctly', async () => {
    const events = await collect({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } } }]),
      provider: 'p',
      model: 'm',
      messages: [],
    })
    assert.equal(events[0].code, 'ABORTED')
    assert.equal(events[0].message, '已停止生成')
  })
})

describe('runTurn (the search loop)', () => {
  /** A fake `llm` whose rounds are scripted; the last script repeats forever. */
  const scriptedLlm = (rounds) => ({
    calls: 0,
    lastOptions: undefined,
    stream(options) {
      const round = Math.min(this.calls, rounds.length - 1)
      this.calls += 1
      this.lastOptions = options
      const chunks = rounds[round]
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  })

  /** A round that asks for one search. */
  const searchRound = (id, args) => [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: id, name: 'web_search', argumentsDelta: args.slice(0, 8) },
    { type: 'tool-call-delta', index: 0, argumentsDelta: args.slice(8) },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  /** A round that answers. */
  const answerRound = (text) => [
    { type: 'text-delta', index: 0, text: text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  /** Collect a whole turn. */
  const collect = async (options) => {
    const events = []
    for await (const event of runTurn(options)) events.push(event)
    return events
  }

  const base = {
    provider: 'p',
    model: 'm',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '今天天气' }], source: { kind: 'user' } }],
    tools: [WEB_SEARCH_TOOL],
  }

  it('executes the search and answers from its result', async () => {
    const llm = scriptedLlm([searchRound('call-1', '{"queries":["北京 天气"]}'), answerRound('今天晴。')])
    const executed = []
    const events = await collect({
      ...base,
      llm,
      executeTool: async (call) => {
        executed.push(call)
        return { text: 'Sources:\n- [x](https://example.com)', queries: ['北京 天气'], sources: [{ url: 'https://example.com', title: 'x' }] }
      },
    })

    assert.deepEqual(
      events.filter((event) => event.type === 'tool').map((event) => event.phase),
      ['start', 'done'],
    )
    assert.equal(executed.length, 1)
    assert.equal(executed[0].name, 'web_search')
    assert.equal(executed[0].arguments, '{"queries":["北京 天气"]}')

    const done = events.at(-1)
    assert.equal(done.type, 'done')
    assert.equal(done.text, '今天晴。')
    assert.equal(done.tools.length, 1)
    assert.equal(done.tools[0].status, 'done')
    assert.equal(done.tools[0].queries[0], '北京 天气')
    assert.equal(done.tools[0].sources[0].url, 'https://example.com')

    // The second round must carry the asking turn and its result.
    const sent = llm.lastOptions.messages
    assert.equal(sent.at(-2).role, 'assistant')
    assert.deepEqual(sent.at(-2).content.at(-1), {
      type: 'tool-call',
      id: 'call-1',
      name: 'web_search',
      arguments: '{"queries":["北京 天气"]}',
    })
    assert.equal(sent.at(-1).role, 'tool')
    assert.equal(sent.at(-1).toolCallId, 'call-1')
    assert.equal(sent.at(-1).isError, false)
    assert.match(sent.at(-1).content[0].text, /example\.com/)
  })

  it('tells the model a search failed instead of failing the turn', async () => {
    const llm = scriptedLlm([searchRound('call-2', '{"queries":["x"]}'), answerRound('没查到，我说点别的。')])
    const events = await collect({
      ...base,
      llm,
      executeTool: async () => {
        throw new Error('额度用尽')
      },
    })

    assert.deepEqual(
      events.filter((event) => event.type === 'tool').map((event) => event.phase),
      ['start', 'error'],
    )
    const done = events.at(-1)
    assert.equal(done.type, 'done')
    assert.equal(done.tools[0].status, 'error')
    assert.match(done.tools[0].message, /额度用尽/)
    const sent = llm.lastOptions.messages
    assert.equal(sent.at(-1).isError, true)
    assert.match(sent.at(-1).content[0].text, /搜索失败/)
  })

  it('drops a tool call that max-tokens truncated instead of replaying it', async () => {
    const llm = scriptedLlm([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'call-cut', name: 'web_search', argumentsDelta: '{"queries":["小米电视 S75 Mini LED 和 Redmi X75 的详细参数、价' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
      answerRound('好的。'),
    ])
    const executed = []
    const events = await collect({ ...base, llm, executeTool: async (call) => { executed.push(call); return { text: 'ok', queries: [], sources: [] } } })

    assert.equal(executed.length, 0, 'a truncated call is never executed')
    const done = events.at(-1)
    assert.equal(done.type, 'done')
    assert.equal(done.toolCalls === undefined || done.toolCalls.length === 0, true)
    // The next round (if any) must not carry the truncated call either.
    assert.equal(llm.calls, 1, 'without tool calls the turn ends after the opening round')
  })

  it('repairs malformed arguments into a valid replayable call', () => {
    assert.equal(repairArguments('{"queries":["a"]}'), '{"queries":["a"]}')
    // A max-tokens truncation mid-string still carries the query as a literal.
    const truncated = repairArguments('{"queries":["小米电视 S75 和 Redmi')
    assert.deepEqual(JSON.parse(truncated), { queries: ['小米电视 S75 和 Redmi'] })
    assert.deepEqual(JSON.parse(repairArguments('')), { queries: [] })
    const repaired = JSON.parse(repairArguments('queries 是 数组 才对'))
    assert.deepEqual(repaired, { queries: ['queries 是 数组 才对'] })
  })

  it('sanitizes queries before they reach the provider', () => {
    const withNewline = '  北京 \n 天气  '
    assert.deepEqual(sanitizeQueries([withNewline, '', 'x'.repeat(500)]), ['北京 天气', 'x'.repeat(200)])
    assert.deepEqual(sanitizeQueries(['a', 'a', 'b']).length, 2, 'duplicates collapse')
    assert.deepEqual(sanitizeQueries(undefined), [])
  })

  it('ends the turn when the search is stopped, instead of asking again', async () => {
    const llm = scriptedLlm([searchRound('call-abort', '{"queries":["x"]}'), answerRound('不该走到这里')])
    const controller = new AbortController()
    const events = await collect({
      ...base,
      llm,
      signal: controller.signal,
      executeTool: async () => {
        controller.abort()
        throw new Error('aborted')
      },
    })

    assert.equal(llm.calls, 1, 'a stopped search does not spend another model call')
    const last = events.at(-1)
    assert.equal(last.type, 'error')
    assert.equal(last.code, 'ABORTED')
    assert.equal(last.tools[0].status, 'error')
  })

  it('ignores a tool this window does not offer', async () => {
    const llm = scriptedLlm([
      [
        { type: 'tool-call-delta', index: 0, id: 'call-3', name: 'run_code', argumentsDelta: '{}' },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      answerRound('好的。'),
    ])
    const events = await collect({ ...base, llm, executeTool: async () => ({ text: '', queries: [], sources: [] }) })

    assert.equal(events.filter((event) => event.type === 'tool').length, 0)
    assert.equal(llm.calls, 1, 'an unknown tool ends the turn rather than looping')
    assert.match(events.at(-1).notice, /不提供的工具/)
  })

  it('reserves the last round for writing the answer', async () => {
    const llm = scriptedLlm([
      searchRound('call-1', '{"queries":["a"]}'),
      searchRound('call-2', '{"queries":["b"]}'),
      searchRound('call-3', '{"queries":["c"]}'),
      answerRound('综合结论。'),
    ])
    const events = await collect({ ...base, llm, maxRounds: 4, executeTool: async () => ({ text: 'ok', queries: ['x'], sources: [{ url: 'https://s' }] }) })

    assert.equal(llm.calls, 4)
    // The final call is tool-less and carries the synthesis nudge.
    assert.equal(llm.lastOptions.tools, undefined)
    const nudge = llm.lastOptions.messages.at(-1)
    assert.equal(nudge.role, 'user')
    assert.match(nudge.content[0].text, /次数已用完/)
    const done = events.at(-1)
    assert.equal(done.type, 'done')
    assert.equal(done.text, '综合结论。')
    assert.equal(done.tools.length, 3)
    assert.match(events.find((event) => event.type === 'notice').message, /综合资料/)
  })

  it('still closes the turn when even the synthesis round asks for tools', async () => {
    const llm = scriptedLlm([searchRound('call-x', '{"queries":["loop"]}')])
    const events = await collect({
      ...base,
      llm,
      maxRounds: 3,
      executeTool: async () => ({ text: 'nothing', queries: ['loop'], sources: [] }),
    })

    assert.equal(llm.calls, 3)
    const done = events.at(-1)
    assert.equal(done.type, 'done')
    assert.equal(done.tools.length, 2, 'only the two tool-allowed rounds searched')
    assert.match(done.notice, /上限/)
  })

  it('is exactly one model call when no tools are offered', async () => {
    const llm = scriptedLlm([answerRound('直接回答')])
    const events = await collect({ ...base, llm, tools: [] })
    assert.equal(llm.calls, 1)
    assert.equal(events.at(-1).text, '直接回答')
    assert.equal(llm.lastOptions.tools, undefined, 'no tool declaration reaches the provider')
  })
})

describe('search helpers', () => {
  it('reads queries out of the raw arguments', () => {
    assert.deepEqual(parseQueries('{"queries":["a","b"]}'), ['a', 'b'])
    assert.deepEqual(parseQueries('{"queries":["a","  "]}'), ['a'])
    assert.deepEqual(parseQueries('not json'), [])
    assert.deepEqual(parseQueries('{}'), [])
  })

  it('formats a result as a citable source list with the untrusted notice', () => {
    const text = formatSearchResult({
      content: '北京今天晴。',
      sources: [{ url: 'https://a.example', title: 'A', snippet: '片段', publishedAt: '2026-01-01' }],
      truncated: true,
    })
    assert.match(text, /不可信数据/)
    assert.match(text, /北京今天晴。/)
    assert.match(text, /\[A\]\(https:\/\/a\.example\) — 片段 \(2026-01-01\)/)
    assert.match(text, /markdown 链接引用/)
  })

  it('says so when nothing came back', () => {
    assert.match(formatSearchResult({ sources: [] }), /No results found/)
  })
})

describe('runWebSearch (the search executor)', () => {
  /** A fake `web` seam answering one canned result per query. */
  const fakeWeb = (sourcesByQuery, content) => ({
    search: async (request) => ({
      ...(content ? { content } : {}),
      sources: sourcesByQuery[request.query] ?? [],
      truncated: false,
    }),
  })
  const call = (queries) => ({ id: 'call-1', name: 'web_search', arguments: JSON.stringify({ queries }) })

  it('merges queries, dedupes by URL and caps the source count', async () => {
    const { runWebSearch } = await import('../lib/index.js')
    const web = {
      search: async (request) => ({
        sources:
          request.query === 'a'
            ? [
                { url: 'https://same', title: 'same' },
                { url: 'https://only-a', title: 'a' },
              ]
            : [
                { url: 'https://same', title: 'same again' },
                { url: 'https://only-b', title: 'b' },
              ],
        truncated: false,
      }),
    }
    const result = await runWebSearch({ get: () => web }, call(['a', 'b']), undefined)
    assert.deepEqual(result.queries, ['a', 'b'])
    assert.deepEqual(
      result.sources.map((source) => source.url),
      ['https://same', 'https://only-a', 'https://only-b'],
    )
    assert.match(result.text, /only-a/)
    assert.match(result.text, /不可信数据/)
  })

  it('refuses to run without the web seam or without usable queries', async () => {
    const { runWebSearch } = await import('../lib/index.js')
    await assert.rejects(() => runWebSearch({ get: () => undefined }, call(['a']), undefined), /没有挂载联网搜索/)
    const web = fakeWeb({})
    await assert.rejects(() => runWebSearch({ get: () => web }, call(['   ']), undefined), /至少一个可用的搜索词/)
  })

  it('collapses whitespace and caps query length before the provider sees them', async () => {
    const { runWebSearch } = await import('../lib/index.js')
    const seen = []
    const web = { search: async (request) => { seen.push(request.query); return { sources: [] } } }
    await runWebSearch({ get: () => web }, call(['  北京  \n 天气   Today  ', 'x'.repeat(600)]), undefined)
    assert.equal(seen[0], '北京 天气 Today')
    assert.equal(seen[1].length, 200)
  })
})

describe('capability helpers', () => {
  it('reads vision from the resolved model info only when positively advertised', () => {
    assert.equal(modelSeesImages({ inputModalities: ['text', 'image'] }), true)
    assert.equal(modelSeesImages({ inputModalities: ['text'] }), false)
    assert.equal(modelSeesImages(undefined), false)
  })

  it('names the failure a user can act on', () => {
    const described = describeFailure({ code: 'MISSING_CREDENTIAL', message: 'no key' }, { provider: 'p', model: 'm' })
    assert.match(described.message, /API Key/)
  })
})
