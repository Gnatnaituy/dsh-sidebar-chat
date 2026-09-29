/**
 * Client-half smoke tests.
 *
 * The bundle is not a module: it installs itself through
 * `window.__ModuleLoader__.load()`. These tests run it in a `node:vm` context
 * with a minimal DOM, a stub React and a mock plugin context, then check the
 * two things a browser would otherwise be the first to discover — that the tab
 * type and both of its seats are registered under the right keys, and that the
 * component tree actually renders (including a seeded transcript).
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, it } from 'node:test'

/** A React stub that is just real enough to run the components. */
function createReactStub() {
  /** Hook slots per component, so state survives a re-render like React's. */
  const hookStore = new Map()
  /** The component currently being invoked. */
  let current = null
  let cursor = 0
  /** Effects queued by the current render pass, run by `flushEffects`. */
  let effects = []
  /**
   * Start rendering one component: hooks are addressed per component, so two
   * renders of the same component see each other's state.
   * @param component - the function component about to run.
   */
  const begin = (component) => {
    current = component
    cursor = 0
  }
  /** The hook slots of the component being rendered. */
  const slotsOf = () => {
    let slots = hookStore.get(current)
    if (slots === undefined) {
      slots = []
      hookStore.set(current, slots)
    }
    return slots
  }
  /**
   * Run the effects queued since the last flush, the way React runs them after
   * a commit. Tests that need mount behaviour call this explicitly.
   */
  const flushEffects = () => {
    const queued = effects
    effects = []
    for (const effect of queued) effect()
  }

  class Component {
    /** @param props - the element's props. */
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }

    /** Minimal state setter for class components. */
    setState(patch) {
      this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch)
    }
  }

  const React = {
    Component,
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props)
      const flat = children.length <= 1 ? children[0] : children
      if (flat !== undefined) merged.children = flat
      return { type, props: merged }
    },
    useState(initial) {
      const slots = slotsOf()
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) {
      const slots = slotsOf()
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect) {
      effects.push(effect)
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
  return { React, begin, flushEffects }
}

/**
 * Assert every element in a rendered tree is renderable.
 *
 * The stub React builds elements without validating their type, so a component
 * face that is missing from a kit (or from the fallback set) would only blow up
 * in the browser. This walk is the cheap stand-in for that check.
 *
 * @param node - the rendered tree.
 * @param path - where the walk currently is, for the failure message.
 */
function assertRenderable(node, path = 'root') {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => assertRenderable(child, `${path}[${index}]`))
    return
  }
  assert.ok(
    node.type !== null && node.type !== undefined,
    `${path} has no element type (a missing component face or icon would crash React here)`,
  )
  assertRenderable(node.props?.children, path)
}

/**
 * Walk an element tree, invoking every function component, so rendering is
 * exercised rather than just element construction.
 * @param element - the element (or array, or text).
 * @param react - the stub React, whose hook state is reset per component.
 * @param depth - recursion guard for a runaway tree.
 * @returns the tree with components expanded.
 */
function deepRender(element, react, depth = 0) {
  if (depth > 60 || element === null || typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map((child) => deepRender(child, react, depth + 1))
  const type = element.type
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(element.props)
      return deepRender(instance.render(), react, depth + 1)
    }
    react.begin(type)
    return deepRender(type(element.props), react, depth + 1)
  }
  const props = Object.assign({}, element.props)
  if (props.children !== undefined) props.children = deepRender(props.children, react, depth + 1)
  return { type, props }
}

/** Every string in a rendered tree, for content assertions. */
function textsOf(node, found = []) {
  if (typeof node === 'string') {
    found.push(node)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, found)
    return found
  }
  textsOf(node.props?.children, found)
  return found
}

/** Every element of one tag in a rendered tree. */
function elementsOf(node, tag, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, tag, found)
    return found
  }
  if (node.type === tag) found.push(node)
  elementsOf(node.props?.children, tag, found)
  return found
}

/**
 * A `fetch` response shaped the way the tab reads one.
 * @param payload - the JSON body.
 * @param ok - whether the transport succeeded.
 * @returns a response stand-in.
 */
function jsonResponse(payload, ok = true) {
  return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(payload) }
}

/**
 * A stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * It renders the same semantics the real kit does — an anchor plus a list of
 * rows for `Menu`, the text for `MarkdownText`, the icon for each icon export —
 * so the tab's structure can be asserted without the shell's stylesheet.
 *
 * @param React - the stub React.
 * @returns the kit's faces.
 */
function createKitStub(React) {
  const h = React.createElement
  const icon = (name) => (props) => h('svg', { 'data-icon': name, width: props?.size ?? 16, height: props?.size ?? 16 })
  // The real kit's Button is a `forwardRef` object, not a function: the stub
  // mirrors that so the loader's capability check is exercised the same way.
  const Button = { $$typeof: Symbol.for('react.forward_ref'), render: (props) => props }
  const Pill = (props) =>
    h(
      props.onClick ? 'button' : 'span',
      {
        className: props.className,
        onClick: props.onClick,
        disabled: props.disabled,
        title: props.title,
        'data-pill': props.active === true ? 'on' : 'off',
        'data-dsh-sc': props['data-dsh-sc'],
      },
      props.children,
    )
  const Tooltip = (props) => h('span', { 'data-tooltip': props.label }, props.children)
  const TextShimmer = (props) => h('span', { 'data-shimmer': props.active === true ? 'on' : 'off' }, props.children)
  const DisclosureRow = (props) =>
    h(
      'div',
      { 'data-disclosure': props.open === true ? 'open' : 'closed' },
      h('button', { type: 'button', 'data-disclosure-toggle': true, onClick: () => props.expandable !== false && props.onToggle() }, props.icon, props.title),
      props.open === true ? props.children : null,
    )
  const MarkdownText = (props) => h('div', { 'data-md': props.streaming === true ? 'streaming' : 'settled' }, props.text)
  const ImageLightbox = (props) => h('div', { 'data-lightbox': props.src }, props.alt)
  const Menu = (props) => {
    if (props.open !== true) return h('span', { 'data-menu': 'closed', className: props.className }, props.anchor)
    const rows = []
    for (const entry of props.items ?? []) {
      if (entry.type === 'separator') continue
      if (entry.type === 'label') {
        rows.push(h('div', { key: entry.id, 'data-menu-label': entry.text }))
        continue
      }
      rows.push(
        h('button', { key: entry.id, type: 'button', 'data-menu-item': entry.id, onClick: () => props.onSelect?.(entry.id) }, entry.label),
      )
      for (const sub of entry.submenu ?? []) {
        rows.push(h('button', { key: sub.id, type: 'button', 'data-menu-item': sub.id, onClick: () => props.onSelect?.(sub.id) }, sub.label))
      }
    }
    return h('span', { 'data-menu': 'open', className: props.className }, props.anchor, h('div', null, rows))
  }
  return {
    Button,
    Pill,
    Tooltip,
    Menu,
    MarkdownText,
    ImageLightbox,
    TextShimmer,
    DisclosureRow,
    IconNewChatOutlineRegular: icon('chat'),
    IconPlusOutlineRegular: icon('plus'),
    IconPaperclipOutlineRegular: icon('paperclip'),
    IconSendOutlineRegular: icon('send'),
    IconStopFillRegular: icon('stop'),
    IconFlatListOutlineRegular: icon('list'),
    IconCloseOutlineRegular: icon('close'),
    IconTrashOutlineRegular: icon('trash'),
    IconChevronDownOutlineRegular: icon('chevron-down'),
    IconRefreshOutlineRegular: icon('refresh'),
    IconWarningOutlineRegular: icon('warning'),
    IconSparkleRegular: icon('sparkle'),
    IconThinkOutlineRegular: icon('think'),
    IconCheckOutlineRegular: icon('check'),
  }
}

/**
 * Load the client bundle in a sandbox.
 * @param options - `withPrimitives` decides whether the shell's component kit resolves.
 * @returns the plugin module the bundle exported, plus its sandbox window.
 */
async function loadClient(options = {}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const { React, begin, flushEffects } = createReactStub()
  /** The render harness `deepRender` drives. */
  const react = { React, begin, flushEffects }
  let definition
  /** A localStorage good enough for the tab's two preference keys. */
  const storage = new Map()
  const windowStub = {
    location: { origin: 'http://127.0.0.1:19387' },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    __ModuleLoader__: { load: (value) => { definition = value } },
  }
  /** Style elements this page has, keyed by id, mirroring a live DOM. */
  const styles = new Map()
  const sandbox = {
    window: windowStub,
    document: {
      getElementById: (id) => styles.get(id) ?? null,
      createElement: () => ({ style: {} }),
      head: { appendChild: (node) => styles.set(node.id, node) },
    },
    URL,
    TextDecoder,
    AbortController,
    Image: class { set src(_value) {} },
    // Timers exist in the page; the stub keeps deferred work (and the plugin's
    // own temporary hooks) from running inside a test.
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: options.fetch ?? (async () => { throw new Error('network disabled in this test') }),
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  assert.ok(definition !== undefined, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-sidebar-chat')

  const require = (spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.withPrimitives === true) return createKitStub(React)
      throw new Error('client-modules: require missed the module table')
    }
    throw new Error(`unexpected require("${spec}")`)
  }

  const plugin = definition.factory(require)

  /**
   * Render the tab body with the given props, the way its seat would.
   * @param body - the registered body component.
   * @param props - the slot props.
   * @returns the rendered tree.
   */
  const renderBody = (body, props) => {
    begin(body)
    return deepRender(body(props), react)
  }

  return { plugin, react, renderBody, windowStub, styles }
}

/**
 * The component registered for one slot in a mock context.
 * @param ctx - the mock context.
 * @param name - the slot name to look up.
 * @returns the registered component.
 */
function componentOf(ctx, name) {
  const entry = ctx.slots.entries.find((item) => item.options.name === name)
  assert.ok(entry !== undefined, `no component registered for ${name}`)
  return entry.component
}

/** A mock client plugin context recording every registration. */
function createContext() {
  const registered = []
  const injected = []
  const service = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(deps, callback) {
      injected.push(deps)
      if (deps.includes('sidebarRightTabs')) {
        return callback({ get: (name) => (name === 'sidebarRightTabs' ? service : undefined) })
      }
      return callback({ get: () => undefined })
    },
    slots: {
      declare: [],
      inject(key, callback) {
        ctx.slots.declare.push(key)
        return callback()
      },
      register(options, component) {
        ctx.slots.entries = ctx.slots.entries ?? []
        ctx.slots.entries.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

describe('client bundle', () => {
  it('registers the tab type and both seats under the type id', async () => {
    const { plugin } = await loadClient()
    const { ctx, registered } = createContext()
    assert.equal(plugin.name, 'dsh-sidebar-chat')
    assert.deepEqual(Array.from(plugin.inject), ['slots'])

    plugin.apply(ctx)

    assert.equal(registered.length, 1)
    const definition = registered[0]
    assert.equal(definition.kind, 'sidebar-chat')
    assert.equal(definition.id, 'dsh-sidebar-chat/panel')
    assert.equal(definition.priority, 'extension')
    assert.equal(definition.keepMounted, true)
    assert.equal(definition.title(), '聊天')
    assert.equal(definition.guide.length, 1)
    assert.equal(definition.guide[0].id, 'chat')

    // The composer button, then the tab body and its chip title.
    assert.deepEqual(Array.from(ctx.slots.declare), [
      'conversation.input.left',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
    ])
    const bodies = ctx.slots.entries.filter((entry) => entry.options.name.startsWith('sidebar.right'))
    assert.deepEqual(
      bodies.map((entry) => entry.options.key),
      ['dsh-sidebar-chat/panel', 'dsh-sidebar-chat/panel'],
    )
    assert.deepEqual(
      bodies.map((entry) => entry.options.name),
      ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    )
  })

  it('renders the empty transcript and the composer', async () => {
    const { plugin, react, renderBody } = await loadClient()
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')
    plugin._internal.stateOf('tab-1').set({ status: 'ready' })

    const info = { tab: { id: 'tab-1' }, sidebar: {}, panel: {} }
    const tree = renderBody(body, { useTabInfo: () => info })
    assertRenderable(tree)
    const texts = textsOf(tree)
    assert.ok(texts.some((text) => String(text).includes('不绑定工作目录')), 'the empty state explains the tab')
    assert.equal(elementsOf(tree, 'textarea').length, 1)
    assert.equal(elementsOf(tree, 'input')[0].props.type, 'file')
  })

  it('renders a seeded transcript, falling back to plain text without the primitives module', async () => {
    const { plugin, react, renderBody, windowStub } = await loadClient()
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')

    // Seed the tab's store through the same module the component reads.
    const internal = plugin._internal
    const state = internal.stateOf('tab-2')
    state.set({
      status: 'ready',
      conversation: {
        id: 'c-1',
        title: '看图',
        provider: 'p',
        model: 'm',
        messages: [
          { id: 'u1', role: 'user', text: '这是什么？', attachments: [{ id: 'a-1', name: 'x.png', mediaType: 'image/png' }], at: 1 },
          { id: 'a1', role: 'assistant', text: '**一张图**', reasoning: '想想', status: 'streaming', at: 2 },
          { id: 'a2', role: 'assistant', text: 'done', status: 'done', usage: { inputTokens: 5, outputTokens: 7 }, at: 3 },
          { id: 'a3', role: 'assistant', text: '', status: 'error', error: { code: 'RATE_LIMIT', message: '慢一点' }, at: 4 },
        ],
      },
      draft: '接下来问什么',
      conversations: [{ id: 'c-1', title: '看图', model: 'm', messageCount: 4, updatedAt: Date.now() }],
    })

    const info = { tab: { id: 'tab-2' }, sidebar: {}, panel: {} }
    const tree = renderBody(body, { useTabInfo: () => info })
    assertRenderable(tree)
    const texts = textsOf(tree).map(String)
    // Without the shell kit the markdown renderer is the stand-in, which shows
    // the assistant's raw text — and nothing throws.
    assert.ok(texts.includes('**一张图**'))
    assert.ok(texts.includes('这是什么？'))
    assert.ok(texts.some((text) => text.includes('RATE_LIMIT') && text.includes('慢一点')))
    assert.ok(texts.some((text) => text.includes('输入 5')))
    assert.ok(texts.includes('思考中'), 'a streaming turn names its reasoning as running')
    assert.equal(elementsOf(tree, 'textarea')[0].props.value, '接下来问什么')
    assert.equal(windowStub.localStorage.getItem('dsh-sidebar-chat:last-model'), null)
    assert.equal(plugin._internal.usingKit, false, 'the fallback kit is what rendered here')

    // The model menu lists providers, models and the chosen model's efforts.
    state.set({
      menu: 'models',
      provider: 'p',
      model: 'm',
      catalog: {
        default: {},
        groups: [
          {
            id: 'p',
            name: '供应商',
            models: [
              {
                id: 'm',
                name: '模型',
                image: true,
                contextWindow: 1000000,
                reasoning: { efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' },
              },
            ],
          },
        ],
      },
    })
    const panelTree = renderBody(body, { useTabInfo: () => info })
    assertRenderable(panelTree)
    const menuLabels = elementsOf(panelTree, 'div')
      .filter((node) => node.props['data-menu-label'] !== undefined)
      .map((node) => node.props['data-menu-label'])
    assert.deepEqual(menuLabels, ['供应商'])
    const rows = elementsOf(panelTree, 'button').filter((node) => node.props['data-menu-item'] !== undefined)
    assert.deepEqual(
      rows.map((node) => node.props['data-menu-item']),
      ['model:p/m', 'effort', 'effort:', 'effort:low', 'action:reload'],
    )
    assert.ok(textsOf(panelTree).map(String).includes('图片'), 'the vision badge is shown')

    // Picking a model adopts it, remembers it, and closes the menu.
    rows.find((node) => node.props['data-menu-item'] === 'model:p/m').props.onClick()
    const chosen = JSON.parse(windowStub.localStorage.getItem('dsh-sidebar-chat:last-model'))
    assert.deepEqual(chosen, { provider: 'p', model: 'm', reasoningEffort: 'low' })
    assert.equal(state.get().menu, '')
  })

  it('renders through the shell kit when it resolves', async () => {
    const { plugin, renderBody } = await loadClient({ withPrimitives: true })
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')
    assert.equal(plugin._internal.usingKit, true)

    const state = plugin._internal.stateOf('tab-3')
    state.set({
      status: 'ready',
      conversation: {
        id: 'c-9',
        title: 't',
        provider: 'p',
        model: 'm',
        messages: [
          { id: 'a1', role: 'assistant', text: '# 标题', reasoning: '推理', status: 'streaming', at: 1 },
          { id: 'u1', role: 'user', text: '问题', at: 2 },
        ],
      },
      conversations: [{ id: 'c-9', title: 't', updatedAt: Date.now() }],
      menu: 'conversations',
    })

    const info = { tab: { id: 'tab-3' }, sidebar: {}, panel: {} }
    const tree = renderBody(body, { useTabInfo: () => info })
    assertRenderable(tree)
    const markdown = elementsOf(tree, 'div').filter((node) => node.props['data-md'] !== undefined)
    assert.equal(markdown.length, 1)
    assert.equal(markdown[0].props.children, '# 标题')
    assert.equal(markdown[0].props['data-md'], 'streaming', 'the streaming flag reaches the renderer')
    assert.ok(elementsOf(tree, 'div').some((node) => node.props['data-disclosure'] !== undefined), 'reasoning uses the kit disclosure')

    // The conversation menu lists the stored conversation plus both actions.
    const actions = elementsOf(tree, 'button')
      .filter((node) => node.props['data-menu-item'] !== undefined)
      .map((node) => node.props['data-menu-item'])
    assert.ok(actions.includes('conversation:c-9'))
    assert.ok(actions.includes('action:new'))
    assert.ok(actions.includes('action:delete'))
  })

  it('refreshes its stylesheet when a live page reloads the module', async () => {
    const { plugin, styles } = await loadClient({ withPrimitives: true })
    const { ctx } = createContext()
    plugin.apply(ctx)

    const injected = styles.get('dsh-sidebar-chat-style')
    assert.ok(injected !== undefined, 'the first load injects a stylesheet')
    assert.ok(injected.textContent.includes('.dsh-sc-root'))
    assert.ok(injected.textContent.includes('.dsh-sc-bubbleUser'))

    // A client-plugin HMR reload swaps the module but not the page, so the
    // previous version's element is still there: it must be refreshed, not
    // reused as-is.
    injected.textContent = '.dsh-sc-root{color:red}'
    plugin.apply(ctx)
    assert.equal(styles.size, 1, 'no second stylesheet is stacked')
    assert.ok(styles.get('dsh-sidebar-chat-style').textContent.includes('.dsh-sc-send'))
  })

  it('resolves every glyph it renders, with or without the shell kit', async () => {
    for (const withPrimitives of [false, true]) {
      const { plugin } = await loadClient({ withPrimitives })
      assert.equal(plugin._internal.usingKit, withPrimitives)
      assert.deepEqual(
        Array.from(plugin._internal.missingIcons),
        [],
        `missing glyphs with withPrimitives=${withPrimitives}: ${plugin._internal.missingIcons}`,
      )
      assert.ok(plugin._internal.iconNames.length >= 14)
    }
  })

  it('starts a new conversation even when others already exist', async () => {
    const calls = []
    const oldRow = { id: 'c-old', title: '旧的会话', updatedAt: 2, messageCount: 2, model: 'm', provider: 'p' }
    const fetchStub = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = String(url)
      calls.push({ path, method })
      if (path.endsWith('/conversations') && method === 'GET') {
        return jsonResponse({ ok: true, conversations: [oldRow] })
      }
      if (path.endsWith('/conversations') && method === 'POST') {
        return jsonResponse({ ok: true, conversation: { id: 'c-new', title: '新对话', provider: 'p', model: 'm', reasoningEffort: '', messages: [] } })
      }
      if (path.endsWith('/conversations/c-new') && method === 'GET') {
        return jsonResponse({ ok: true, conversation: { id: 'c-new', title: '新对话', provider: 'p', model: 'm', messages: [] } })
      }
      if (path.includes('/models')) {
        return jsonResponse({ ok: true, default: { provider: 'p', model: 'm' }, groups: [], failures: [] })
      }
      return jsonResponse({ ok: false, error: 'unexpected ' + method + ' ' + path }, false)
    }

    const { plugin, react, renderBody } = await loadClient({ withPrimitives: true, fetch: fetchStub })
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')

    const state = plugin._internal.stateOf('tab-new')
    state.set({
      status: 'ready',
      conversation: { id: 'c-old', title: '旧的会话', provider: 'p', model: 'm', messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }] },
      conversations: [oldRow],
      provider: 'p',
      model: 'm',
      draft: '还没发出去的草稿',
    })

    const info = { tab: { id: 'tab-new' }, sidebar: {}, panel: {} }
    const tree = renderBody(body, { useTabInfo: () => info })

    const plus = elementsOf(tree, 'button').find((node) => node.props['data-dsh-sc'] === 'new-conversation')
    assert.ok(plus !== undefined, 'the header has a new-conversation button')
    await plus.props.onClick()

    assert.ok(
      calls.some((call) => call.method === 'POST' && call.path.endsWith('/conversations')),
      'a new conversation is created, not the most recent one reopened',
    )
    assert.equal(state.get().conversation.id, 'c-new')
    assert.equal(state.get().draft, '', 'the new conversation starts with an empty composer')
  })

  it('recovers when the conversation was deleted before the send landed', async () => {
    const calls = []
    const fetchStub = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = String(url)
      calls.push({ path, method })
      if (path.endsWith('/chat')) return jsonResponse({ ok: false, error: '会话不存在' }, false)
      if (path.endsWith('/conversations') && method === 'POST') {
        return jsonResponse({ ok: true, conversation: { id: 'c-fresh', title: '新对话', provider: 'p', model: 'm', messages: [] } })
      }
      if (path.endsWith('/conversations') && method === 'GET') {
        return jsonResponse({ ok: true, conversations: [{ id: 'c-fresh', title: '新对话', updatedAt: 9, messageCount: 0, model: 'm' }] })
      }
      if (path.includes('/models')) {
        return jsonResponse({ ok: true, default: { provider: 'p', model: 'm' }, groups: [], failures: [] })
      }
      return jsonResponse({ ok: false, error: 'unexpected ' + method + ' ' + path }, false)
    }

    const { plugin, react, renderBody } = await loadClient({ withPrimitives: true, fetch: fetchStub })
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')

    const state = plugin._internal.stateOf('tab-vanished')
    state.set({
      status: 'ready',
      conversation: { id: 'c-gone', title: '已删除', provider: 'p', model: 'm', messages: [] },
      conversations: [],
      provider: 'p',
      model: 'm',
      draft: '这句要发出去',
    })

    const info = { tab: { id: 'tab-vanished' }, sidebar: {}, panel: {} }
    const tree = renderBody(body, { useTabInfo: () => info })
    const send = elementsOf(tree, 'button').find((node) => node.props['data-dsh-sc'] === 'send')
    await send.props.onClick()

    assert.ok(calls.some((call) => call.path.endsWith('/conversations') && call.method === 'POST'), 'a replacement conversation is created')
    assert.equal(state.get().conversation.id, 'c-fresh')
    assert.equal(state.get().draft, '这句要发出去', 'the words survive the restart')
    assert.match(state.get().error, /已经不存在/)
  })

  it('resumes the most recent conversation when the tab attaches with none remembered', async () => {
    const calls = []
    const fetchStub = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = String(url)
      calls.push({ path, method })
      if (path.endsWith('/conversations') && method === 'GET') {
        return jsonResponse({ ok: true, conversations: [{ id: 'c-recent', title: '最近的', updatedAt: 5, messageCount: 1, model: 'm', provider: 'p' }] })
      }
      if (path.endsWith('/conversations/c-recent') && method === 'GET') {
        return jsonResponse({ ok: true, conversation: { id: 'c-recent', title: '最近的', provider: 'p', model: 'm', messages: [] } })
      }
      if (path.includes('/models')) return jsonResponse({ ok: true, default: {}, groups: [], failures: [] })
      return jsonResponse({ ok: false, error: 'unexpected ' + method + ' ' + path }, false)
    }

    const { plugin, react, renderBody } = await loadClient({ withPrimitives: true, fetch: fetchStub })
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')
    plugin._internal.stateOf('tab-resume').set({ status: 'ready' })

    const info = { tab: { id: 'tab-resume' }, sidebar: {}, panel: {} }
    renderBody(body, { useTabInfo: () => info })
    react.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(
      calls.some((call) => call.path.endsWith('/conversations/c-recent')),
      'attaching loads the most recent conversation',
    )
    assert.ok(
      !calls.some((call) => call.method === 'POST'),
      'attaching to a tab with history never creates a conversation',
    )
  })

  it('shows the 联网 toggle on by default, gated by availability', async () => {
    const { plugin, renderBody } = await loadClient({ withPrimitives: true })
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')
    const info = { tab: { id: 'tab-search' }, sidebar: {}, panel: {} }
    const toggleOf = (tree) => elementsOf(tree, 'button').find((node) => node.props['data-dsh-sc'] === 'search-toggle')

    // A fresh tab searches by default.
    const state = plugin._internal.stateOf('tab-search')
    assert.equal(state.get().searchOn, true, '联网 starts on')

    // No search provider in this deployment: the chip shows but cannot be used.
    state.set({ status: 'ready', conversation: { id: 'c-1', title: 't', messages: [] }, catalogSearch: false })
    let toggle = toggleOf(renderBody(body, { useTabInfo: () => info }))
    assert.ok(toggle !== undefined, 'the composer carries a search chip')
    assert.equal(toggle.props.disabled, true, 'disabled while the deployment has no search provider')
    assert.equal(toggle.props['data-pill'], 'on', 'the default state reads as on')
    assert.ok(textsOf(toggle).some((text) => String(text).includes('联网')), 'the chip is labelled, not just an icon')

    // Available, and explicitly turned off: it reads as off and can be clicked back on.
    state.set({ catalogSearch: true, searchOn: false })
    toggle = toggleOf(renderBody(body, { useTabInfo: () => info }))
    assert.equal(toggle.props.disabled, false)
    assert.equal(toggle.props['data-pill'], 'off')
    toggle.props.onClick()
    assert.equal(state.get().searchOn, true)
  })

  it('treats a conversation without a stored preference as searching', async () => {
    const fetchStub = async (url) => {
      const path = String(url)
      if (path.endsWith('/conversations') ) return jsonResponse({ ok: true, conversations: [{ id: 'c-legacy', title: '旧的', updatedAt: 3, messageCount: 1, model: 'm' }] })
      if (path.endsWith('/conversations/c-legacy')) {
        return jsonResponse({ ok: true, conversation: { id: 'c-legacy', title: '旧的', provider: 'p', model: 'm', messages: [] } })
      }
      if (path.includes('/models')) return jsonResponse({ ok: true, search: true, default: { provider: 'p', model: 'm' }, groups: [], failures: [] })
      return jsonResponse({ ok: false, error: 'unexpected ' + path }, false)
    }

    const { plugin, react, renderBody } = await loadClient({ withPrimitives: true, fetch: fetchStub })
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')
    plugin._internal.stateOf('tab-legacy').set({ status: 'ready' })

    renderBody(body, { useTabInfo: () => ({ tab: { id: 'tab-legacy' }, sidebar: {}, panel: {} }) })
    react.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The stored conversation carries no `search` field at all.
    assert.equal(plugin._internal.stateOf('tab-legacy').get().searchOn, true)
  })

  it('renders search activity: running, sources, and failure', async () => {
    const { plugin, react, renderBody } = await loadClient({ withPrimitives: true })
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')

    const state = plugin._internal.stateOf('tab-tools')
    state.set({
      status: 'ready',
      conversation: {
        id: 'c-tools',
        title: 't',
        provider: 'p',
        model: 'm',
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            text: '根据搜索结果……',
            status: 'done',
            at: 1,
            tools: [
              { id: 'call-1', name: 'web_search', status: 'done', queries: ['今日天气'], sources: [{ url: 'https://example.com/x', title: '天气页' }] },
              { id: 'call-2', name: 'web_search', status: 'error', queries: ['别的'], message: '额度用尽' },
              { id: 'call-3', name: 'web_search', status: 'running', queries: ['正在进行'] },
            ],
          },
        ],
      },
    })

    const tree = renderBody(body, { useTabInfo: () => ({ tab: { id: 'tab-tools' }, sidebar: {}, panel: {} }) })
    assertRenderable(tree)
    const texts = textsOf(tree).map(String)
    assert.ok(texts.some((text) => text.includes('联网搜索 · 1 个来源')))
    assert.ok(texts.some((text) => text.includes('搜索失败：额度用尽')))
    assert.ok(texts.some((text) => text.includes('正在搜索：正在进行')))
    // Opening the finished search's disclosure reveals its sources as links.
    const disclosure = elementsOf(tree, 'button').find((node) => node.props['data-disclosure-toggle'] !== undefined)
    assert.ok(disclosure !== undefined, 'the finished search is a disclosure')
    disclosure.props.onClick()
    const opened = textsOf(renderBody(body, { useTabInfo: () => ({ tab: { id: 'tab-tools' }, sidebar: {}, panel: {} }) })).map(String)
    assert.ok(opened.some((text) => text.includes('[天气页](https://example.com/x)')), 'the sources render as markdown links')
  })

  it('sends the 联网 toggle with the turn and remembers it on the conversation', async () => {
    const calls = []
    const fetchStub = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = String(url)
      calls.push({ path, method, body: init?.body })
      if (path.endsWith('/chat')) return jsonResponse({ ok: false, error: '会话不存在' }, false)
      if (path.endsWith('/conversations/c-1') && method === 'PATCH') {
        return jsonResponse({ ok: true, conversation: { id: 'c-1', title: 't', provider: 'p', model: 'm', search: true, messages: [] } })
      }
      if (path.endsWith('/conversations') && method === 'POST') {
        return jsonResponse({ ok: true, conversation: { id: 'c-2', title: '新对话', provider: 'p', model: 'm', messages: [] } })
      }
      if (path.endsWith('/conversations') && method === 'GET') return jsonResponse({ ok: true, conversations: [] })
      if (path.includes('/models')) return jsonResponse({ ok: true, search: true, default: { provider: 'p', model: 'm' }, groups: [], failures: [] })
      return jsonResponse({ ok: false, error: 'unexpected ' + method + ' ' + path }, false)
    }

    const { plugin, react, renderBody } = await loadClient({ withPrimitives: true, fetch: fetchStub })
    const { ctx } = createContext()
    plugin.apply(ctx)
    const body = componentOf(ctx, 'sidebar.right.pane.tab')

    const state = plugin._internal.stateOf('tab-toggle')
    state.set({
      status: 'ready',
      catalogSearch: true,
      searchOn: true,
      provider: 'p',
      model: 'm',
      conversation: { id: 'c-1', title: 't', provider: 'p', model: 'm', messages: [] },
      draft: '问一句',
    })

    const info = { tab: { id: 'tab-toggle' }, sidebar: {}, panel: {} }
    const tree = renderBody(body, { useTabInfo: () => info })
    const toggle = elementsOf(tree, 'button').find((node) => node.props['data-dsh-sc'] === 'search-toggle')
    toggle.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(state.get().searchOn, false, 'the default-on toggle turns off')
    const patched = calls.find((call) => call.method === 'PATCH')
    assert.ok(patched !== undefined, 'the preference is written to the conversation')
    assert.deepEqual(JSON.parse(patched.body), { search: false })

    // …and the next turn carries it to the host.
    const nextTree = renderBody(body, { useTabInfo: () => info })
    const send = elementsOf(nextTree, 'button').find((node) => node.props['data-dsh-sc'] === 'send')
    await send.props.onClick()
    const chat = calls.find((call) => call.path.endsWith('/chat'))
    assert.ok(chat !== undefined)
    assert.equal(JSON.parse(chat.body).search, false, 'an explicit off rides the turn')
  })

  it('keeps one state object per tab and notifies subscribers on change', async () => {
    const { plugin } = await loadClient()
    const first = plugin._internal.stateOf('a')
    const second = plugin._internal.stateOf('a')
    const other = plugin._internal.stateOf('b')
    assert.equal(first, second)
    assert.notEqual(first, other)

    let notifications = 0
    const unsubscribe = first.subscribe(() => {
      notifications += 1
    })
    first.set({ draft: 'hi' })
    assert.equal(first.get().draft, 'hi')
    assert.equal(notifications, 1)
    unsubscribe()
    first.set({ draft: 'bye' })
    assert.equal(notifications, 1)
  })
})
