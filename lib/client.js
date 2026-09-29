/**
 * Browser half of dsh-sidebar-chat.
 *
 * One native right-sidebar tab (`kind: 'sidebar-chat'`) holding a chat that is
 * not tied to a working directory: pick a model, type, drop in images, send.
 * Everything the tab shows comes from the host half's `/dsh-sidebar-chat/*`
 * routes — the model catalog, the transcripts, the temp-file uploads, and one
 * server-sent-event stream per turn.
 *
 * The UI is built from the shell's own component kit,
 * `@deepseek-ai/dsh-client-ui-primitives` — a frozen platform word whose
 * stylesheet is already in the page — so the tab is made of the same buttons,
 * menus, tooltips, icons, markdown renderer, disclosures and image lightbox
 * the rest of the application uses, styled by the same design tokens. A kit
 * that is missing or older than this plugin degrades to plain elements rather
 * than an empty tab (see `loadUi`).
 *
 * The bundle is build-free plain JavaScript in the module-loader CJS form, so
 * the whole plugin stays editable in the profile without a toolchain; React and
 * the kit are the only dependencies, and both are platform words.
 *
 * @module dsh-sidebar-chat/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    /** Reference-stable labels object: a new identity would drop the streaming render cache. */
    var MARKDOWN_LABELS = Object.freeze({})

    /** Package id: equals the Loader row name and the host plugin's name. */
    var PLUGIN_ID = 'dsh-sidebar-chat'
    /** The tab record's discriminator, and this plugin's own kind. */
    var KIND = 'sidebar-chat'
    /** Globally unique type id; also the key its two slot bodies register under. */
    var TYPE_ID = PLUGIN_ID + '/panel'
    /** Path prefix the host half owns. */
    var ROUTE = '/dsh-sidebar-chat'
    /** Style element id, so a reload replaces rather than stacks stylesheets. */
    var STYLE_ID = 'dsh-sidebar-chat-style'
    /** Where the tab remembers which conversation it was showing. */
    var LAST_CONVERSATION_KEY = 'dsh-sidebar-chat:last-conversation'
    /** Where a new conversation takes its starting model from. */
    var LAST_MODEL_KEY = 'dsh-sidebar-chat:last-model'
    /** Tab title, and the fallback chip label before a conversation exists. */
    var TAB_TITLE = '聊天'
    /** Image types the host accepts. */
    var IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

    // ── the shell's component kit ───────────────────────────────────────────

    /**
     * A minimal stand-in for the shell kit.
     *
     * It exists so a deployment whose kit is absent (or renamed upstream) still
     * renders a usable tab: every element the real kit would draw has a plain
     * equivalent here, styled by this plugin's own stylesheet.
     *
     * @param icons - the fallback glyph set.
     * @returns the stand-in component faces.
     */
    function fallbackUi(icons) {
      /**
       * A plain button; the kit's own props (`variant`, `size`, `icon`) are honoured
       * only as far as this plugin's stylesheet can express them.
       */
      function Button(props) {
        var rest = Object.assign({}, props)
        var icon = rest.icon
        var variant = rest.variant
        var size = rest.size
        delete rest.icon
        delete rest.variant
        delete rest.size
        return h(
          'button',
          Object.assign({ type: 'button' }, rest, {
            className: 'dsh-sc-fbButton dsh-sc-fbButton-' + (variant || 'ghost') + ' dsh-sc-fbButton-' + (size || 'md') + (props.className ? ' ' + props.className : ''),
          }),
          icon != null ? h('span', { className: 'dsh-sc-fbIcon' }, icon) : null,
          props.children,
        )
      }

      /** A pill chip; interactive when it carries an `onClick`. */
      function Pill(props) {
        var tag = props.onClick ? 'button' : 'span'
        var rest = Object.assign({}, props)
        delete rest.active
        delete rest.children
        if (tag === 'button') rest.type = 'button'
        return h(
          tag,
          Object.assign({}, rest, {
            className: 'dsh-sc-fbPill' + (props.active ? ' dsh-sc-fbPillActive' : '') + (props.className ? ' ' + props.className : ''),
          }),
          props.children,
        )
      }

      /** A tooltip: the anchor plus a native title, so the label survives without CSS. */
      function Tooltip(props) {
        return h('span', { className: 'dsh-sc-fbTooltip', title: props.label }, props.children)
      }

      /**
       * A dropdown card. Submenus are flattened into the list, which keeps every
       * option reachable without the kit's nested positioning.
       */
      function Menu(props) {
        var anchorClass = 'dsh-sc-fbAnchor' + (props.className ? ' ' + props.className : '')
        if (props.open !== true) return h('span', { className: anchorClass }, props.anchor)
        var rows = []
        /** Append one data row, or a group label, from either level of the menu. */
        var pushRow = (entry, nested) => {
          if (entry.type === 'separator') {
            rows.push(h('div', { className: 'dsh-sc-fbMenuSep', key: 'sep-' + entry.id }))
            return
          }
          if (entry.type === 'label') {
            rows.push(h('div', { className: 'dsh-sc-fbMenuLabel', key: 'label-' + entry.id, 'data-menu-label': entry.text }, entry.text))
            return
          }
          rows.push(
            h(
              'button',
              {
                type: 'button',
                key: entry.id,
                className: 'dsh-sc-fbMenuItem' + (nested ? ' dsh-sc-fbMenuItemNested' : '') + (entry.danger ? ' dsh-sc-fbMenuItemDanger' : ''),
                disabled: entry.disabled === true,
                'data-menu-item': entry.id,
                onClick: () => {
                  props.onClose && props.onClose()
                  props.onSelect && props.onSelect(entry.id)
                },
              },
              entry.icon != null ? h('span', { className: 'dsh-sc-fbIcon' }, entry.icon) : null,
              h('span', { className: 'dsh-sc-fbMenuLabelText' }, entry.label),
            ),
          )
          if (Array.isArray(entry.submenu)) for (const sub of entry.submenu) pushRow(sub, true)
        }
        for (const entry of props.items || []) pushRow(entry, false)
        return h(
          'span',
          { className: anchorClass },
          props.anchor,
          h(
            'div',
            {
              className:
                'dsh-sc-fbMenu' +
                (props.side === 'top' ? ' dsh-sc-fbMenuTop' : '') +
                (props.align === 'end' ? ' dsh-sc-fbMenuEnd' : ''),
            },
            rows,
          ),
        )
      }

      /** Markdown degrades to its own text. */
      function MarkdownText(props) {
        return props.text
      }

      /** The stock lightbox, minus the focus trap. */
      function ImageLightbox(props) {
        return h(
          'div',
          { className: 'dsh-sc-lightbox', onClick: props.onClose, role: 'dialog', 'aria-label': props.labels && props.labels.dialog },
          h('img', { src: props.src, alt: props.alt || '' }),
        )
      }

      /** Activity text without the moving highlight. */
      function TextShimmer(props) {
        return h('span', { className: props.className, 'data-text-shimmer': props.active || undefined }, props.children)
      }

      /** A disclosure row built from the native element. */
      function DisclosureRow(props) {
        return h(
          'div',
          { className: 'dsh-sc-fbDisclosure' + (props.className ? ' ' + props.className : '') },
          h(
            'button',
            { type: 'button', className: 'dsh-sc-fbDisclosureHead', onClick: props.expandable === false ? undefined : props.onToggle },
            props.expandable === false ? null : h('span', { className: 'dsh-sc-fbDisclosureChevron' }, props.open ? '▾' : '▸'),
            props.icon != null ? h('span', { className: 'dsh-sc-fbIcon' }, props.icon) : null,
            h('span', { className: 'dsh-sc-fbDisclosureTitle' }, props.title),
          ),
          props.open === true ? h('div', { className: 'dsh-sc-fbDisclosureBody' }, props.children) : null,
        )
      }

      return {
        usingKit: false,
        missingIcons: [],
        Button: Button,
        Pill: Pill,
        Tooltip: Tooltip,
        Menu: Menu,
        MarkdownText: MarkdownText,
        ImageLightbox: ImageLightbox,
        TextShimmer: TextShimmer,
        DisclosureRow: DisclosureRow,
        icons: icons,
      }
    }

    /**
     * Every glyph this tab renders. A deployment whose kit lacks one still works
     * (the glyph is simply omitted), but the gap is worth surfacing rather than
     * discovering as a blank square.
     */
    var ICON_NAMES = [
      'chat',
      'plus',
      'paperclip',
      'send',
      'stop',
      'list',
      'close',
      'trash',
      'chevronDown',
      'refresh',
      'warning',
      'sparkle',
      'think',
      'check',
      'search',
    ]

    /** Inline glyphs the fallback kit draws; the real kit supplies its own. */
    var FALLBACK_ICONS = (() => {
      /** Build one 16px glyph from a path. */
      const glyph = (d, options) => (props) => {
        const size = props && props.size ? props.size : 16
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false', className: props && props.className },
          h('path', Object.assign({ fill: 'currentColor', d: d }, options)),
        )
      }
      return {
        chat: glyph('M2 3.2h12v8.1H7.4L4.2 14v-2.7H2V3.2zm1.4 1.4v5.3h2.4v1.5l1.8-1.5h5V4.6H3.4z'),
        plus: glyph('M7.2 2.4h1.6v4.8h4.8v1.6H8.8v4.8H7.2V8.8H2.4V7.2h4.8V2.4z'),
        paperclip: glyph(
          'M10.5 4.4v5.2a2.5 2.5 0 01-5 0V4.9a1.6 1.6 0 013.2 0v4.7a.7.7 0 01-1.4 0V5.2H6v4.4a1.9 1.9 0 003.8 0V4.9a2.8 2.8 0 00-5.6 0v4.7a4 4 0 008 0V4.4h-1.7z',
        ),
        send: glyph('M8 2.6l4.6 4.6-1.1 1.1L8.8 5.6v7.8H7.2V5.6L4.5 8.3 3.4 7.2 8 2.6z'),
        stop: glyph('M4 4h8v8H4z', { rx: 1.5 }),
        list: glyph('M2.4 3.4h11.2v1.4H2.4V3.4zm0 3.9h11.2v1.4H2.4V7.3zm0 3.9h11.2v1.4H2.4v-1.4z'),
        close: glyph('M3.5 4.6L4.6 3.5 8 6.9l3.4-3.4 1.1 1.1L9.1 8l3.4 3.4-1.1 1.1L8 9.1l-3.4 3.4-1.1-1.1L6.9 8 3.5 4.6z'),
        trash: glyph('M6.2 2h3.6l.5 1H13v1.4H3V3h2.7l.5-1zM4.2 6h7.6l-.5 8H4.7l-.5-8z'),
        chevronDown: glyph('M8 10.4L3.6 6 4.7 4.9 8 8.2l3.3-3.3L12.4 6 8 10.4z'),
        warning: glyph('M8 1.8l6.2 11.4H1.8L8 1.8zm-.8 4.3v3.6h1.6V6.1H7.2zm0 4.5v1.5h1.6v-1.5H7.2z'),
        sparkle: glyph('M8 1.2l1.5 4.4 4.4 1.5-4.4 1.5L8 13l-1.5-4.4L2.1 7.1l4.4-1.5L8 1.2z'),
        refresh: glyph('M8 2.6a5.4 5.4 0 015.2 4H11.5A3.9 3.9 0 008 4.1V2.6zm-.9 1.7v6.3l2.6-3.1-2.6-3.2zM2.8 9.4h1.7A3.9 3.9 0 008 11.9v1.5a5.4 5.4 0 01-5.2-4z'),
        think: glyph('M6.2 2.6h3.6l.4 1.2 1.2.5 1.2-.4 1.8 3.1-.9.9v1.3l.9.9-1.8 3.1-1.2-.4-1.2.5-.4 1.2H6.2l-.4-1.2-1.2-.5-1.2.4-1.8-3.1.9-.9V7.9l-.9-.9 1.8-3.1 1.2.4 1.2-.5.4-1.2zm1.2 3.6a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z'),
        check: glyph('M6.5 10.2L3.9 7.6 3 8.5l3.5 3.5L13 5.5l-.9-.9-5.6 5.6z'),
        // Outline rather than fill: an outlined magnifier is what the shell's
        // own icon set is drawn with.
        search: (props) => {
          const size = props && props.size ? props.size : 16
          return h(
            'svg',
            {
              width: size,
              height: size,
              viewBox: '0 0 16 16',
              fill: 'none',
              'aria-hidden': 'true',
              focusable: 'false',
              className: props && props.className,
            },
            h('circle', { cx: 7.1, cy: 7.1, r: 4.35, stroke: 'currentColor', strokeWidth: 1.2 }),
            h('path', { d: 'M10.4 10.4L14 14', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
          )
        },
        image: glyph('M2 3h12v10H2V3zm1.4 1.4v7.2h9.2V4.4H3.4zm1.2 5.9l1.9-2.3 1.5 1.8 1.2-1.4 1.9 2.3H4.6v-.4zM5.6 5.3a1.1 1.1 0 110 2.2 1.1 1.1 0 010-2.2z'),
      }
    })()

    /**
     * Resolve the component faces this tab renders with: the shell's kit when it
     * is present and carries what the tab uses, its own stand-in otherwise.
     *
     * @param requireFn - the module loader's `require`.
     * @returns `{ usingKit, Button, Pill, Tooltip, Menu, MarkdownText,
     *   ImageLightbox, TextShimmer, DisclosureRow, icons }`.
     */
    function loadUi(requireFn) {
      var kit = null
      try {
        kit = requireFn('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        kit = null
      }
      // A face may be a plain function, a `forwardRef` object or a `memo`
      // object; only a missing or non-component export means "no kit".
      const isFace = (value) => value !== null && value !== undefined && (typeof value === 'function' || typeof value === 'object')
      if (kit === null || typeof kit !== 'object' || !isFace(kit.Button) || !isFace(kit.Menu) || !isFace(kit.MarkdownText) || !isFace(kit.Tooltip)) {
        return fallbackUi(FALLBACK_ICONS)
      }
      /** One kit icon, or the fallback glyph of the same meaning. */
      const icon = (name, fallbackName) => kit[name] ?? FALLBACK_ICONS[fallbackName ?? ''] ?? null
      const icons = {
        chat: icon('IconNewChatOutlineRegular', 'chat'),
        plus: icon('IconPlusOutlineRegular', 'plus'),
        paperclip: icon('IconPaperclipOutlineRegular', 'paperclip'),
        send: icon('IconSendOutlineRegular', 'send'),
        stop: icon('IconStopFillRegular', 'stop'),
        list: icon('IconFlatListOutlineRegular', 'list'),
        close: icon('IconCloseOutlineRegular', 'close'),
        trash: icon('IconTrashOutlineRegular', 'trash'),
        chevronDown: icon('IconChevronDownOutlineRegular', 'chevronDown'),
        refresh: icon('IconRefreshOutlineRegular', 'refresh'),
        warning: icon('IconWarningOutlineRegular', 'warning'),
        sparkle: icon('IconSparkleRegular', 'sparkle'),
        think: icon('IconThinkOutlineRegular', 'think'),
        check: icon('IconCheckOutlineRegular', 'check'),
        // The kit's own web_search glyph: the same magnifier the main chat
        // draws for a search tool call.
        search: icon('IconSearchOutlineRegular', 'search'),
      }
      return {
        usingKit: true,
        missingIcons: ICON_NAMES.filter((name) => typeof icons[name] !== 'function'),
        icons: icons,
        Button: kit.Button,
        Pill: kit.Pill,
        Tooltip: kit.Tooltip,
        Menu: kit.Menu,
        MarkdownText: kit.MarkdownText,
        ImageLightbox: typeof kit.ImageLightbox === 'function' ? kit.ImageLightbox : fallbackUi(FALLBACK_ICONS).ImageLightbox,
        TextShimmer: typeof kit.TextShimmer === 'function' ? kit.TextShimmer : fallbackUi(FALLBACK_ICONS).TextShimmer,
        DisclosureRow: typeof kit.DisclosureRow === 'function' ? kit.DisclosureRow : fallbackUi(FALLBACK_ICONS).DisclosureRow,
      }
    }

    /** The kit this page renders with. */
    var ui = loadUi(require)
    // ── tiny observable store ───────────────────────────────────────────────
    //
    // One state object per tab id, because the body and the sidebar chip are two
    // separately mounted React trees that must agree on the title.

    /** @type {Map<string, TabState>} */
    var states = new Map()

    /**
     * The observable state of one chat tab.
     * @param id - the tab id it belongs to.
     */
    function TabState(id) {
      this.id = id
      this.listeners = new Set()
      this.value = {
        status: 'loading',
        error: '',
        notice: '',
        conversations: [],
        conversation: null,
        catalog: null,
        catalogError: '',
        provider: '',
        model: '',
        reasoningEffort: '',
        // 联网 defaults to on: the toggle exists to turn it OFF for a question
        // that clearly does not need the web.
        searchOn: true,
        catalogSearch: false,
        draft: '',
        pending: [],
        uploading: 0,
        streaming: false,
        runId: '',
        menu: '',
        atBottom: true,
      }
    }

    /** Read the current snapshot. */
    TabState.prototype.get = function get() {
      return this.value
    }

    /** Subscribe one listener; returns the unsubscribe function. */
    TabState.prototype.subscribe = function subscribe(listener) {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }

    /** Merge a patch into the state and notify every listener. */
    TabState.prototype.set = function set(patch) {
      this.value = Object.assign({}, this.value, patch)
      for (const listener of Array.from(this.listeners)) listener()
    }

    /**
     * The state of one tab, created on first use.
     * @param id - the tab id.
     * @returns the tab's state object.
     */
    function stateOf(id) {
      var key = typeof id === 'string' && id.length > 0 ? id : 'default'
      var found = states.get(key)
      if (found === undefined) {
        found = new TabState(key)
        states.set(key, found)
      }
      return found
    }

    /**
     * React binding for one tab's state.
     * @param state - the tab state.
     * @returns the current state value, re-rendering on change.
     */
    function useTabState(state) {
      return React.useSyncExternalStore(
        React.useCallback((listener) => state.subscribe(listener), [state]),
        React.useCallback(() => state.get(), [state]),
      )
    }

    // ── host API ────────────────────────────────────────────────────────────

    /** Absolute URL of one host route. */
    function apiUrl(path) {
      return window.location.origin + ROUTE + path
    }

    /**
     * Call one host route and decode its JSON envelope.
     * @param path - route path below the prefix.
     * @param options - fetch options.
     * @returns the decoded body.
     * @throws when the transport or the envelope failed.
     */
    async function api(path, options) {
      var response = await fetch(apiUrl(path), options)
      var text = await response.text()
      var parsed
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {}
      } catch {
        throw new Error('服务端返回了非 JSON 内容：' + text.slice(0, 200))
      }
      if (!response.ok || parsed.ok === false) {
        throw new Error(parsed.error || '请求失败（HTTP ' + response.status + '）')
      }
      return parsed
    }

    /** Read the model catalog. */
    function fetchCatalog() {
      return api('/models')
    }

    /** Read every conversation summary. */
    function fetchConversations() {
      return api('/conversations')
    }

    /** Read one full transcript. */
    function fetchConversation(id) {
      return api('/conversations/' + encodeURIComponent(id))
    }

    /** Create one conversation. */
    function createConversation(body) {
      return api('/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    /** Update one conversation. */
    function patchConversation(id, body) {
      return api('/conversations/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    /** Delete one conversation. */
    function deleteConversation(id) {
      return api('/conversations/' + encodeURIComponent(id), { method: 'DELETE' })
    }

    /** Abort the turn currently streaming on the host. */
    function stopRun(runId) {
      return api('/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: runId }),
      })
    }

    /** Natural pixel size of a picked image, for the transcript's metadata. */
    function imageSize(file) {
      return new Promise((resolve) => {
        var url = URL.createObjectURL(file)
        var image = new Image()
        image.onload = () => {
          URL.revokeObjectURL(url)
          resolve({ width: image.naturalWidth, height: image.naturalHeight })
        }
        image.onerror = () => {
          URL.revokeObjectURL(url)
          resolve({})
        }
        image.src = url
      })
    }

    /**
     * Upload one image into the host's temp directory.
     * @param file - the picked or pasted image.
     * @returns the stored attachment record.
     */
    async function uploadAttachment(file) {
      var size = await imageSize(file)
      var query = [
        'name=' + encodeURIComponent(file.name || 'pasted-image'),
        size.width ? 'width=' + size.width : '',
        size.height ? 'height=' + size.height : '',
      ]
        .filter(Boolean)
        .join('&')
      var result = await api('/attachments?' + query, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })
      return result.attachment
    }

    // ── attachment bytes back into the tab ──────────────────────────────────

    /** Object URLs already fetched, so a transcript re-render does not refetch. */
    var blobUrls = new Map()

    /** Load one attachment's bytes once and hand back a blob URL. */
    function loadAttachmentUrl(id) {
      if (blobUrls.has(id)) return blobUrls.get(id)
      var pending = fetch(apiUrl('/attachments/' + encodeURIComponent(id)))
        .then((response) => {
          if (!response.ok) throw new Error('附件已不可用（HTTP ' + response.status + '）')
          return response.blob()
        })
        .then((blob) => URL.createObjectURL(blob))
        .catch((error) => {
          blobUrls.delete(id)
          throw error
        })
      blobUrls.set(id, pending)
      return pending
    }

    // ── server-sent events ──────────────────────────────────────────────────

    /**
     * POST one turn and consume its event stream.
     * @param body - the turn request.
     * @param onEvent - called once per decoded event.
     * @param signal - aborts the request.
     */
    async function streamTurn(body, onEvent, signal) {
      var response = await fetch(apiUrl('/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal,
      })
      if (!response.ok) {
        var text = await response.text()
        var message = text
        try {
          message = JSON.parse(text).error || text
        } catch {
          // A non-JSON error body is shown verbatim.
        }
        throw new Error(message || 'HTTP ' + response.status)
      }
      if (response.body === null) throw new Error('服务端没有返回事件流')

      var reader = response.body.getReader()
      var decoder = new TextDecoder()
      var buffer = ''
      while (true) {
        var chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        var boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          var frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of frame.split('\n')) {
            if (line.slice(0, 5) !== 'data:') continue
            var payload = line.slice(5).trim()
            if (payload.length === 0) continue
            try {
              onEvent(JSON.parse(payload))
            } catch {
              // A malformed frame is skipped; the stream itself stays usable.
            }
          }
        }
      }
    }

    // ── turn orchestration ──────────────────────────────────────────────────

    /** The model selection a new conversation should start from. */
    function rememberedSelection() {
      try {
        var raw = window.localStorage.getItem(LAST_MODEL_KEY)
        if (raw === null) return null
        var parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    /** Remember a selection for the next new conversation. */
    function rememberSelection(selection) {
      try {
        window.localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(selection))
      } catch {
        // A browser that refuses storage simply loses the preference.
      }
    }

    /** The conversation id this tab was last showing. */
    function rememberedConversation() {
      try {
        return window.localStorage.getItem(LAST_CONVERSATION_KEY) || ''
      } catch {
        return ''
      }
    }

    /** Remember the conversation this tab is showing. */
    function rememberConversation(id) {
      try {
        if (id) window.localStorage.setItem(LAST_CONVERSATION_KEY, id)
        else window.localStorage.removeItem(LAST_CONVERSATION_KEY)
      } catch {
        // See above: storage is a preference, not a requirement.
      }
    }

    /**
     * Attach the tab to a conversation: load it and adopt its routing.
     * @param state - the tab state.
     * @param id - conversation id, or empty for "create one".
     */
    async function openConversation(state, id) {
      state.set({ status: 'loading', error: '' })
      try {
        var catalog = await ensureCatalog(state)
        var summaries = (await fetchConversations()).conversations || []
        var target = id
        // An empty or stale id means "whatever this tab was last showing" —
        // resuming, not creating. Starting a new conversation is its own
        // action (`startConversation`), because "nothing to resume" and "the
        // user asked for a new one" are different intents.
        if (target === '' || !summaries.some((row) => row.id === target)) {
          target = summaries.length > 0 ? summaries[0].id : ''
        }
        if (target === '') {
          await startConversation(state, catalog)
          return
        }
        var loaded = await fetchConversation(target)
        rememberConversation(target)
        state.set({
          status: 'ready',
          conversations: summaries,
          conversation: loaded.conversation,
          provider: loaded.conversation.provider,
          model: loaded.conversation.model,
          reasoningEffort: loaded.conversation.reasoningEffort,
          searchOn: loaded.conversation.search !== false,
        })
      } catch (error) {
        state.set({ status: 'error', error: String((error && error.message) || error) })
      }
    }

    /**
     * Read the model catalog once per tab, caching it on the tab's state.
     * @param state - the tab state.
     * @returns the catalog.
     */
    async function ensureCatalog(state) {
      var catalog = state.get().catalog
      if (catalog !== null) return catalog
      catalog = await fetchCatalog()
      state.set({ catalog: catalog, catalogError: '', catalogSearch: catalog.search === true })
      return catalog
    }

    /**
     * Which model a brand-new conversation should start from: whatever the tab
     * has selected now, else the remembered/default choice.
     * @param state - the tab state.
     * @param catalog - the model catalog.
     * @returns the selection to create with.
     */
    function selectionForNewConversation(state, catalog) {
      var snapshot = state.get()
      var selection =
        snapshot.provider && snapshot.model
          ? { provider: snapshot.provider, model: snapshot.model, reasoningEffort: snapshot.reasoningEffort }
          : defaultSelection(state, catalog)
      // 联网 is a preference of the person, not of the transcript: it survives
      // into the next conversation.
      return Object.assign({}, selection, { search: snapshot.searchOn !== false })
    }

    /**
     * Create a conversation and make it the tab's own.
     *
     * The composer is emptied with it: a draft and its uploaded previews belong
     * to the conversation they were typed in, not to the new one.
     *
     * @param state - the tab state.
     * @param catalog - the model catalog, already loaded.
     * @returns the created conversation.
     */
    async function startConversation(state, catalog) {
      var pending = state.get().pending
      var created = await createConversation(selectionForNewConversation(state, catalog))
      var summaries = (await fetchConversations()).conversations || []
      rememberConversation(created.conversation.id)
      for (const item of pending) releasePreview(item)
      state.set({
        status: 'ready',
        conversations: summaries.length > 0 ? summaries : [summaryRow(created.conversation)],
        conversation: created.conversation,
        provider: created.conversation.provider,
        model: created.conversation.model,
        reasoningEffort: created.conversation.reasoningEffort,
        searchOn: created.conversation.search !== false,
        draft: '',
        pending: [],
        error: '',
        notice: '',
        menu: '',
      })
      return created.conversation
    }

    /**
     * Start a brand-new conversation, whatever the tab was showing.
     * @param state - the tab state.
     */
    async function newConversation(state) {
      state.set({ status: 'loading', error: '', menu: '' })
      try {
        await startConversation(state, await ensureCatalog(state))
      } catch (error) {
        state.set({ status: 'error', error: String((error && error.message) || error) })
      }
    }

    /**
     * Release one pending attachment's local preview URL.
     * @param item - a pending attachment record.
     */
    function releasePreview(item) {
      if (item && typeof item.previewUrl === 'string' && item.previewUrl.length > 0 && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(item.previewUrl)
      }
    }

    /**
     * Fold one tool event into a message's activity list.
     * @param rows - the rows so far, or undefined.
     * @param event - a `start` / `done` / `error` event for one call.
     * @returns the updated rows.
     */
    function upsertToolRow(rows, event) {
      var list = Array.isArray(rows) ? rows.slice() : []
      var at = -1
      for (var index = 0; index < list.length; index += 1) {
        if (list[index].id === event.id) at = index
      }
      var row = {
        id: event.id,
        name: event.name,
        queries: event.queries || [],
        status: event.phase === 'start' ? 'running' : event.phase,
        at: at >= 0 ? list[at].at : Date.now(),
        sources: event.sources === undefined ? (at >= 0 ? list[at].sources : undefined) : event.sources,
        message: event.message === undefined ? (at >= 0 ? list[at].message : undefined) : event.message,
      }
      if (at < 0) return list.concat([row])
      list[at] = row
      return list
    }

    /** A conversation's summary row, as the host would compute it. */
    function summaryRow(conversation) {
      return {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        createdAt: conversation.createdAt,
        provider: conversation.provider,
        model: conversation.model,
        messageCount: (conversation.messages || []).length,
        preview: '',
      }
    }

    /** The selection a fresh conversation should use. */
    function defaultSelection(state, catalog) {
      var remembered = rememberedSelection()
      if (remembered && remembered.provider && remembered.model) return remembered
      var fallback = (catalog && catalog.default) || {}
      if (fallback.provider && fallback.model) return fallback
      var groups = (catalog && catalog.groups) || []
      var first = groups.length > 0 && groups[0].models.length > 0 ? { provider: groups[0].id, model: groups[0].models[0].id } : null
      return first || { provider: '', model: '', reasoningEffort: '' }
    }

    /** The catalog entry behind one provider/model pair. */
    function modelEntry(catalog, provider, model) {
      var groups = (catalog && catalog.groups) || []
      for (const group of groups) {
        if (group.id !== provider) continue
        for (const entry of group.models) {
          if (entry.id === model) return entry
        }
      }
      return null
    }

    /** Human-readable provider name. */
    function providerName(catalog, provider) {
      var groups = (catalog && catalog.groups) || []
      for (const group of groups) {
        if (group.id === provider) return group.name
      }
      return provider || '未选择供应商'
    }

    /**
     * Send the current draft.
     * @param state - the tab state.
     */
    async function sendDraft(state) {
      var snapshot = state.get()
      if (snapshot.streaming) return
      var text = snapshot.draft
      var attachments = snapshot.pending
      if (text.trim().length === 0 && attachments.length === 0) return
      var conversation = snapshot.conversation
      if (conversation === null) return
      if (snapshot.provider === '' || snapshot.model === '') {
        state.set({ error: '请先选择一个模型', menu: 'models' })
        return
      }

      // Show the turn immediately; the host's `start` event replaces the
      // optimistic rows with the stored ones.
      var optimistic = {
        id: 'local-' + Date.now(),
        role: 'user',
        text: text,
        attachments: attachments.map((item) => ({
          id: item.id,
          name: item.name,
          mediaType: item.mediaType,
          bytes: item.bytes,
          previewUrl: item.previewUrl,
        })),
        at: Date.now(),
      }
      var assistant = {
        id: 'local-assistant-' + Date.now(),
        role: 'assistant',
        text: '',
        reasoning: '',
        status: 'streaming',
        provider: snapshot.provider,
        model: snapshot.model,
        at: Date.now(),
      }
      state.set({
        draft: '',
        pending: [],
        error: '',
        notice: '',
        streaming: true,
        conversation: Object.assign({}, conversation, {
          provider: snapshot.provider,
          model: snapshot.model,
          messages: conversation.messages.concat([optimistic, assistant]),
        }),
      })

      var controller = new AbortController()
      var runId = ''
      /** Append a delta to the streaming assistant row. */
      var patchStreaming = (patch) => {
        var current = state.get().conversation
        if (current === null) return
        var messages = current.messages.slice()
        for (var index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].id !== assistant.id) continue
          messages[index] = Object.assign({}, messages[index], patch(messages[index]))
          break
        }
        state.set({ conversation: Object.assign({}, current, { messages: messages }) })
      }

      try {
        await streamTurn(
          {
            conversationId: conversation.id,
            text: text,
            attachmentIds: attachments.map((item) => item.id),
            provider: snapshot.provider,
            model: snapshot.model,
            reasoningEffort: snapshot.reasoningEffort,
            search: snapshot.searchOn !== false,
          },
          (event) => {
            if (event.runId) runId = event.runId
            if (event.type === 'start') {
              state.set({ runId: event.runId })
              return
            }
            if (event.type === 'notice') {
              state.set({ notice: event.message })
              return
            }
            if (event.type === 'delta') {
              patchStreaming((message) => ({ text: message.text + event.text }))
              return
            }
            if (event.type === 'reasoning') {
              patchStreaming((message) => ({ reasoning: message.reasoning + event.text }))
              return
            }
            if (event.type === 'usage') {
              patchStreaming(() => ({ usage: event.usage }))
              return
            }
            if (event.type === 'tool') {
              patchStreaming((message) => ({ tools: upsertToolRow(message.tools, event) }))
              return
            }
            if (event.type === 'error') {
              patchStreaming(() => ({ status: event.code === 'ABORTED' ? 'aborted' : 'error', error: { code: event.code, message: event.message } }))
              state.set({ error: event.message, streaming: false })
              return
            }
            if (event.type === 'done') {
              patchStreaming(() => ({ status: 'done' }))
              state.set({ streaming: false })
            }
          },
          controller.signal,
        )
      } catch (error) {
        var aborted = error && error.name === 'AbortError'
        // The conversation can disappear between typing and sending — deleted
        // from another pane, or swept by a cleanup. Landing the tab on a fresh
        // conversation, with the words still in the box, beats a dead end.
        var vanished = !aborted && /会话不存在/.test(String((error && error.message) || error))
        if (vanished) {
          try {
            await startConversation(state, await ensureCatalog(state))
            state.set({ draft: text, error: '这个会话已经不存在了，已为你新建一个会话，请重新发送。' })
          } catch (restartError) {
            state.set({ error: '发送失败：' + String((restartError && restartError.message) || restartError) })
          }
        } else {
          patchStreaming(() => ({ status: aborted ? 'aborted' : 'error', error: { code: aborted ? 'ABORTED' : 'NETWORK', message: String((error && error.message) || error) } }))
          if (!aborted) state.set({ error: '发送失败：' + String((error && error.message) || error) })
        }
      } finally {
        state.set({ streaming: false, runId: '' })
        // The host owns the transcript, so the tab re-reads it once the turn is
        // committed: titles, attachment faults, and message ids then match what
        // a reload would show, instead of the optimistic rows built above.
        try {
          var settled = await fetchConversation(conversation.id)
          state.set({ conversation: settled.conversation })
          // The stored attachments are served from the host's temp store now,
          // so the local object URLs this turn borrowed can be released.
          for (const item of attachments) releasePreview(item)
        } catch {
          // Keeping the streamed rows (and their preview URLs) beats blanking
          // the transcript.
        }
        try {
          var listed = await fetchConversations()
          state.set({ conversations: listed.conversations || [] })
        } catch {
          // A failed list refresh leaves the previous rows in place.
        }
      }
    }


    // ── styles ──────────────────────────────────────────────────────────────
    //
    // Everything here is expressed in the application's own design tokens, so
    // the tab follows the theme (light/dark) and the font-size preference the
    // way the rest of the shell does. Class names are this plugin's own; the
    // kit's components bring their own stylesheet.

    /**
     * Inject this plugin's stylesheet once per page, refreshing it when a
     * previous version already injected one.
     */
    function ensureStyles() {
      var existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        // A client-plugin HMR reload swaps this module without reloading the
        // page, so the element outlives the code that wrote it: refresh its
        // content, or new markup would meet the previous version's rules.
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    var CSS = `
.dsh-sc-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative;
  font-family: var(--dsw-font-family, inherit);
  font-size: calc(14px + var(--dsh-content-font-delta, 0px));
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}

/* ── header ──────────────────────────────────────────────────────────── */
.dsh-sc-header {
  flex: none; display: flex; align-items: center; gap: 2px;
  padding: 6px 8px 6px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-sc-titleAnchor { flex: 1 1 auto; min-width: 0; max-width: 100%; }
.dsh-sc-titleButton {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; width: 100%;
  height: 28px; padding: 0 8px; border: none; background: transparent; cursor: pointer;
  border-radius: var(--dsw-radius-md); color: var(--dsw-alias-label-primary);
  font: inherit; text-align: left;
}
.dsh-sc-titleButton:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-sc-titleText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.dsh-sc-titleChevron { flex: none; color: var(--dsw-alias-label-tertiary); display: inline-flex; }
.dsh-sc-headerSpacer { flex: 1 1 auto; }
.dsh-sc-iconButton {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; height: 28px; padding: 0; border: none; cursor: pointer;
  border-radius: var(--dsw-radius-md); background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.dsh-sc-iconButton:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.dsh-sc-iconButton:disabled { opacity: .4; cursor: default; }
.dsh-sc-toolBlock { margin-bottom: 8px; }
/* The search chip sits in the composer's toolbar; the kit draws its on/off
   states, this only keeps a disabled chip from looking clickable. */
.dsh-sc-searchPill[disabled] { opacity: .4; cursor: default; }
.dsh-sc-searchPill { flex: none; }

/* ── transcript ──────────────────────────────────────────────────────── */
/* The user's own words sit on the deployment's brand-tinted surface — the
   same alias the main chat's message bubbles use (deepseek-100 / deepseek-800). */
.dsh-sc-scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  padding: 14px 12px 8px; display: flex; flex-direction: column; gap: 18px;
}
.dsh-sc-scroll::-webkit-scrollbar { width: 8px; }
.dsh-sc-scroll::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(0,0,0,.15));
  border-radius: 4px;
}
.dsh-sc-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(0,0,0,.3)); }

.dsh-sc-empty {
  margin: auto; display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 24px 16px; text-align: center; color: var(--dsw-alias-label-tertiary);
}
.dsh-sc-emptyGlyph { color: var(--dsw-alias-label-dimmed); }
.dsh-sc-emptyTitle { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-sc-emptyHint { font-size: calc(var(--dsh-content-font-size-secondary, 13px)); line-height: 20px; }

.dsh-sc-msg { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsh-sc-msgUser { align-items: flex-end; }
.dsh-sc-bubbleUser {
  max-width: 86%; padding: 8px 12px; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-state-business-tertiary);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.dsh-sc-assistant { width: 100%; min-width: 0; overflow-wrap: anywhere; }
.dsh-sc-metaRow {
  display: flex; align-items: center; gap: 6px; margin-top: 6px;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px)); line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-sc-metaError { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.dsh-sc-reasoning {
  margin-bottom: 8px; padding: 6px 8px 6px 4px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font-size: calc(var(--dsh-content-font-size-secondary, 13px)); line-height: 20px;
  white-space: pre-wrap; max-height: 220px; overflow: auto;
}
.dsh-sc-alerts { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 0 12px 8px; }
.dsh-sc-alert {
  display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px;
  border-radius: var(--dsw-radius-md);
  font-size: calc(var(--dsh-content-font-size-secondary, 13px)); line-height: 20px;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.dsh-sc-alertError {
  color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc5050) 10%, transparent);
}
.dsh-sc-alertNotice {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary));
  background: var(--dsw-alias-state-warn-tertiary, rgba(230,160,30,.12));
}
.dsh-sc-alertIcon { flex: none; margin-top: 2px; }

/* ── attachments ─────────────────────────────────────────────────────── */
.dsh-sc-thumbs { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-sc-msgUser .dsh-sc-thumbs { justify-content: flex-end; }
.dsh-sc-thumb {
  position: relative; width: 64px; height: 64px; flex: none; overflow: hidden;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dsh-sc-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }
.dsh-sc-thumbPlaceholder {
  display: flex; align-items: center; justify-content: center; text-align: center;
  width: 100%; height: 100%; padding: 4px; color: var(--dsw-alias-label-tertiary);
  font-size: 11px; line-height: 14px;
}
.dsh-sc-thumbRemove {
  position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.5));
  color: var(--dsw-static-neutral-00, #fff);
}
.dsh-sc-thumbRemove:hover { background: var(--dsw-alias-label-primary); }

/* ── composer ────────────────────────────────────────────────────────── */
.dsh-sc-composer { flex: none; padding: 8px 12px 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-sc-box {
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dsh-sc-boxFocused { border-color: var(--dsw-alias-border-l4); }
.dsh-sc-input {
  width: 100%; min-height: 22px; max-height: 180px; resize: none; border: none; outline: none;
  background: transparent; color: inherit; font: inherit; padding: 0 2px;
}
.dsh-sc-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-sc-toolbar { position: relative; display: flex; align-items: center; gap: 4px; }
.dsh-sc-toolbarSpacer { flex: 1 1 auto; min-width: 0; }
.dsh-sc-modelAnchor { flex: 0 1 auto; min-width: 0; max-width: 62%; }
.dsh-sc-picker {
  position: absolute; bottom: calc(100% + 8px); right: -9px; z-index: 30;
  width: max-content; min-width: 248px; max-width: min(360px, calc(100vw - 24px));
  display: flex; flex-direction: column; max-height: min(62vh, 540px);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  box-shadow: 0 12px 32px var(--dsw-alias-bg-mask-1, rgba(0,0,0,.24));
}
.dsh-sc-pickerHead { flex: none; display: flex; align-items: center; gap: 6px; padding: 8px 10px 4px; }
.dsh-sc-pickerTitle { flex: 1 1 auto; font-weight: 600; }
.dsh-sc-pickerBody { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 4px 6px; }
.dsh-sc-pickerGroup {
  display: flex; align-items: center; gap: 6px;
  margin: 4px 4px 2px; padding: 4px 8px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-weight: 600;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); line-height: 18px;
}
.dsh-sc-pickerGroupDot {
  flex: none; width: 6px; height: 6px; border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-fill, currentColor); opacity: .7;
}
.dsh-sc-pickerRow {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px;
  border: none; border-radius: var(--dsw-radius-md); background: transparent;
  color: inherit; font: inherit; cursor: pointer; text-align: left;
}
.dsh-sc-pickerRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-sc-pickerRowActive { background: var(--dsw-alias-button-ghost-active-fill); }
.dsh-sc-rowMain { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dsh-sc-pickerName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sc-pickerId {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
}
.dsh-sc-pickerCheck { flex: none; display: inline-flex; color: var(--dsw-alias-label-primary); }
.dsh-sc-pickerEmpty { padding: 10px 8px; color: var(--dsw-alias-label-tertiary); }
.dsh-sc-pickerFoot {
  flex: none; border-top: 1px solid var(--dsw-alias-border-l2);
  padding: 2px 4px 6px; max-height: 42%; overflow-y: auto;
}
.dsh-sc-effortButton { max-width: 132px; color: var(--dsw-alias-label-secondary); }
.dsh-sc-modelButton {
  display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%;
  height: 28px; padding: 0 8px; border: none; cursor: pointer;
  border-radius: var(--dsw-radius-md); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit;
}
.dsh-sc-modelButton:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-sc-modelName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sc-send {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; height: 28px; padding: 0; border: none; cursor: pointer;
  border-radius: 999px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsh-sc-send:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-sc-send:disabled { opacity: .4; cursor: default; }
.dsh-sc-stop {
  background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-bg-layer-3));
  color: var(--dsw-alias-label-primary);
}
.dsh-sc-stop:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-bg-layer-4)); }

/* ── menu rows ───────────────────────────────────────────────────────── */
/* Caps the dropdown card: the kit leaves a list carrying a submenu unscrolled,
   and an unmeasured-height list is placed off the bottom of the window. */
.dsh-sc-menuList { max-height: min(60vh, 460px); overflow-y: auto; }
.dsh-sc-menuRow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-sc-menuMain { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sc-menuNote {
  margin-left: 6px; color: var(--dsw-alias-label-dimmed);
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
}
.dsh-sc-badge {
  flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 5px;
  border-radius: 999px; background: var(--dsw-alias-markdown-tag, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px;
}

/* ── fallback kit (only when the shell's component kit is unavailable) ── */
.dsh-sc-fbAnchor { display: inline-flex; position: relative; }
.dsh-sc-fbButton {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px;
  border: none; border-radius: var(--dsw-radius-md); cursor: pointer; font: inherit;
  background: transparent; color: var(--dsw-alias-label-primary);
}
.dsh-sc-fbButton:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-sc-fbButton-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-sc-fbIcon { display: inline-flex; align-items: center; }
.dsh-sc-fbPill {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px;
  border: none; border-radius: 999px; font: inherit; font-size: 12px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
}
.dsh-sc-fbPillActive { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-button-ghost-active-fill); }
.dsh-sc-fbTooltip { display: inline-flex; }
.dsh-sc-fbMenu {
  position: absolute; z-index: 40; top: calc(100% + 4px); left: 0; min-width: 220px; max-height: min(60vh, 460px);
  overflow: auto; padding: 4px; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 8px 24px var(--dsw-alias-bg-mask-1, rgba(0,0,0,.2));
}
.dsh-sc-fbMenuTop { top: auto; bottom: calc(100% + 4px); }
.dsh-sc-fbMenuEnd { left: auto; right: 0; }
.dsh-sc-fbMenuItem {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 7px;
  border: none; border-radius: var(--dsw-radius-md); cursor: pointer; font: inherit;
  background: transparent; color: var(--dsw-alias-label-primary); text-align: left;
}
.dsh-sc-fbMenuItem:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-sc-fbMenuItemNested { padding-left: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-sc-fbMenuItemDanger { color: var(--dsw-alias-label-error); }
.dsh-sc-fbMenuLabel { padding: 6px 7px 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-sc-fbMenuLabelText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sc-fbMenuSep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l2); }
.dsh-sc-fbDisclosure { display: flex; flex-direction: column; }
.dsh-sc-fbDisclosureHead {
  display: flex; align-items: center; gap: 6px; padding: 2px 0; border: none;
  background: transparent; cursor: pointer; font: inherit; color: var(--dsw-alias-label-secondary);
}
.dsh-sc-fbDisclosureChevron { width: 10px; }
.dsh-sc-fbDisclosureBody { padding-top: 4px; }
.dsh-sc-lightbox {
  position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.72)); cursor: zoom-out;
}
.dsh-sc-lightbox img { max-width: 92vw; max-height: 92vh; }
`

    // ── components ──────────────────────────────────────────────────────────

    /** `HH:MM` for a timestamp, or a date when it is older than today. */
    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      var date = new Date(value)
      var now = new Date()
      var sameDay =
        date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
      var pad = (number) => (number < 10 ? '0' + number : String(number))
      var time = pad(date.getHours()) + ':' + pad(date.getMinutes())
      return sameDay ? time : date.getMonth() + 1 + '月' + date.getDate() + '日 ' + time
    }

    /**
     * Render one kit icon, or nothing when this deployment has no glyph for it.
     *
     * The kit is versioned independently of this plugin, so a missing export is
     * normal drift rather than a bug; returning null keeps a decorative glyph
     * from taking the tab down.
     *
     * @param face - a component face from `ui.icons`.
     * @param size - pixel size.
     * @returns the icon element, or null.
     */
    function renderIcon(face, size) {
      return face === null || face === undefined || (typeof face !== 'function' && typeof face !== 'object')
        ? null
        : h(face, { size: size })
    }

    /**
     * One icon button with the shell's tooltip.
     * @param props - `label`, `icon`, and the button's own props.
     */
    function IconButton(props) {
      var rest = Object.assign({}, props)
      delete rest.label
      delete rest.icon
      var button = h(
        'button',
        Object.assign({ type: 'button', className: 'dsh-sc-iconButton' + (props.className ? ' ' + props.className : ''), 'aria-label': props.label }, rest),
        renderIcon(props.icon, 16),
      )
      return props.label ? h(ui.Tooltip, { label: props.label, side: 'bottom' }, button) : button
    }

    /**
     * The message's images: thumbnails that open the shell's lightbox.
     * @param props - `attachments`, optional `onRemove`, and `label` for remove buttons.
     */
    function AttachmentStrip(props) {
      var opened = React.useState(null)
      var zoomed = opened[0]
      var setZoomed = opened[1]
      var items = props.attachments || []

      var thumbs = items.map((attachment) =>
        h(
          'div',
          { className: 'dsh-sc-thumb', key: attachment.id },
          h(Thumbnail, { attachment: attachment, onOpen: (url, alt) => setZoomed({ url: url, alt: alt }) }),
          props.onRemove
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-sc-thumbRemove',
                  title: '移除这张图片',
                  'aria-label': '移除这张图片',
                  onClick: () => props.onRemove(attachment.id),
                },
                renderIcon(ui.icons.close, 12),
              )
            : null,
        ),
      )

      return h(
        React.Fragment,
        null,
        h('div', { className: 'dsh-sc-thumbs' }, thumbs),
        zoomed !== null
          ? h(ui.ImageLightbox, {
              src: zoomed.url,
              alt: zoomed.alt || '图片',
              labels: { dialog: '图片预览', close: '关闭' },
              onClose: () => setZoomed(null),
            })
          : null,
      )
    }

    /**
     * One thumbnail's bytes: a local preview URL while the image is still in the
     * composer, the host's temp store otherwise.
     * @param props - `attachment` and `onOpen`.
     */
    function Thumbnail(props) {
      var attachment = props.attachment
      var local = typeof attachment.previewUrl === 'string' ? attachment.previewUrl : ''
      var loaded = React.useState(local)
      var url = loaded[0]
      var setUrl = loaded[1]
      var failed = React.useState(false)
      var broken = failed[0]
      var setBroken = failed[1]

      React.useEffect(() => {
        if (local.length > 0) {
          setUrl(local)
          return undefined
        }
        var cancelled = false
        loadAttachmentUrl(attachment.id)
          .then((value) => {
            if (!cancelled) setUrl(value)
          })
          .catch(() => {
            if (!cancelled) setBroken(true)
          })
        return () => {
          cancelled = true
        }
      }, [attachment.id, local])

      var reason = attachment.error ? attachment.error.message || '这张图片无法读取' : broken ? '图片已过期' : ''
      if (reason !== '') {
        return h('div', { className: 'dsh-sc-thumbPlaceholder', title: reason }, reason)
      }
      if (url.length === 0) {
        return h('div', { className: 'dsh-sc-thumbPlaceholder' }, h(ui.TextShimmer, { active: true }, '载入中'))
      }
      return h('img', {
        src: url,
        alt: attachment.name || '图片',
        title: attachment.name || '图片',
        onClick: () => props.onOpen(url, attachment.name),
      })
    }

    /**
     * The collapsible reasoning trace of one assistant turn.
     * @param props - `text`, `open`, `onToggle`, and whether it is still streaming.
     */
    function ReasoningRow(props) {
      return h(
        ui.DisclosureRow,
        {
          icon: renderIcon(ui.icons.think, 16),
          title: h(ui.TextShimmer, { active: props.running === true }, props.running === true ? '思考中' : '思考过程'),
          open: props.open === true,
          expandable: true,
          running: props.running === true,
          onToggle: props.onToggle,
          expandOnRowClick: true,
        },
        h('div', { className: 'dsh-sc-reasoning' }, props.text),
      )
    }

    /**
     * The web searches one assistant turn ran.
     *
     * A running search shimmers, a finished one collapses into a disclosure the
     * reader can open for the sources, and a failed one says so instead of
     * pretending the answer came from nowhere.
     *
     * @param props - `rows`, the open row's id, and its toggle.
     */
    function ToolActivity(props) {
      return h(
        React.Fragment,
        null,
        (props.rows || []).map((row) => {
          if (row.status === 'running') {
            return h(
              'div',
              { className: 'dsh-sc-metaRow', key: row.id, 'data-dsh-sc': 'tool-running' },
              renderIcon(ui.icons.search, 14),
              h(ui.TextShimmer, { active: true }, '正在搜索：' + ((row.queries || []).join('、') || '…')),
            )
          }
          if (row.status === 'error') {
            return h(
              'div',
              { className: 'dsh-sc-metaRow dsh-sc-metaError', key: row.id, 'data-dsh-sc': 'tool-error' },
              renderIcon(ui.icons.warning, 14),
              h('span', null, '搜索失败：' + (row.message || '未知错误')),
            )
          }
          const sources = row.sources || []
          const markdown = sources
            .map((source) => {
              const label = source.title && source.title.length > 0 ? source.title : source.url
              const note = typeof source.snippet === 'string' && source.snippet.length > 0 ? ` — ${source.snippet}` : ''
              return `- [${label}](${source.url})${note}`
            })
            .join('\n')
          return h(
            'div',
            { className: 'dsh-sc-toolBlock', key: row.id, 'data-dsh-sc': 'tool-done' },
            h(
              ui.DisclosureRow,
              {
                icon: renderIcon(ui.icons.search, 16),
                title: sources.length > 0 ? `联网搜索 · ${sources.length} 个来源` : '联网搜索 · 没有结果',
                open: props.openId === row.id,
                expandable: sources.length > 0,
                onToggle: () => props.onToggle(row.id),
                expandOnRowClick: true,
              },
              h(ui.MarkdownText, { text: markdown, variant: 'compact', labels: MARKDOWN_LABELS }),
            ),
          )
        }),
      )
    }

    /**
     * One transcript turn.
     * @param props - the message, the message-kind handlers, and open/close state.
     */
    function MessageRow(props) {
      var message = props.message
      var isUser = message.role === 'user'

      if (isUser) {
        return h(
          'div',
          { className: 'dsh-sc-msg dsh-sc-msgUser', 'data-dsh-sc': 'message-user' },
          (message.attachments || []).length > 0 ? h(AttachmentStrip, { attachments: message.attachments }) : null,
          (message.text || '').length > 0 ? h('div', { className: 'dsh-sc-bubbleUser' }, message.text) : null,
        )
      }

      var children = []
      if (Array.isArray(message.tools) && message.tools.length > 0) {
        children.push(
          h(ToolActivity, {
            key: 'tools',
            rows: message.tools,
            openId: props.openTool,
            onToggle: props.onToggleTool,
          }),
        )
      }
      var reasoning = typeof message.reasoning === 'string' ? message.reasoning : ''
      if (reasoning.length > 0) {
        children.push(
          h(ReasoningRow, {
            key: 'reasoning',
            text: reasoning,
            running: message.status === 'streaming',
            open: props.openReasoning === true,
            onToggle: props.onToggleReasoning,
          }),
        )
      }

      var body = message.text || ''
      if (body.length > 0) {
        children.push(
          h(ui.MarkdownText, {
            key: 'body',
            text: body,
            streaming: message.status === 'streaming',
            variant: 'compact',
            labels: MARKDOWN_LABELS,
          }),
        )
      } else if (message.status === 'streaming') {
        children.push(h('div', { key: 'waiting', className: 'dsh-sc-metaRow' }, h(ui.TextShimmer, { active: true }, '正在生成')))
      }

      if (message.status === 'error') {
        var failure = message.error || {}
        children.push(
          h(
            'div',
            { key: 'error', className: 'dsh-sc-metaRow dsh-sc-metaError' },
            h('span', { className: 'dsh-sc-alertIcon' }, renderIcon(ui.icons.warning, 14)),
            h('span', null, (failure.code ? failure.code + '：' : '') + (failure.message || '生成失败')),
          ),
        )
      } else if (message.status === 'aborted') {
        children.push(h('div', { key: 'aborted', className: 'dsh-sc-metaRow' }, '已停止'))
      } else if (message.usage && typeof message.usage.inputTokens === 'number') {
        children.push(
          h(
            'div',
            { key: 'usage', className: 'dsh-sc-metaRow' },
            '输入 ' + (message.usage.inputTokens || 0) + ' · 输出 ' + (message.usage.outputTokens || 0) + ' tokens',
          ),
        )
      }

      return h('div', { className: 'dsh-sc-msg', 'data-dsh-sc': 'message-assistant' }, children)
    }

/**
     * The model picker: an anchored card above the composer's chip.
     *
     * The card is deliberately a *card* and not the kit's menu: the catalog
     * needs room for groups, badges and context, and the reasoning effort is
     * not part of it — the effort lives in its own chip next to the model
     * chip, so picking a model and tuning its thinking are two gestures, not
     * a sideways submenu.
     *
     * The card hugs its content (max-content width, right-aligned to the
     * chip), closes on Escape, an outside pointer, or a pick.
     *
     * @param props - `tabState`, `open` and `onClose`.
     */
    function ModelPicker(props) {
      var state = useTabState(props.tabState)
      var catalog = state.catalog
      var groups = (catalog && catalog.groups) || []
      var failures = (catalog && catalog.failures) || []
      var current = modelEntry(catalog, state.provider, state.model)
      var cardRef = React.useRef(null)
      var anchorRef = React.useRef(null)

      /**
       * Adopt a model. The reasoning effort starts at the highest level the
       * model declares — the catalog lists efforts weakest first — and the
       * effort chip beside the selector can lower it afterwards.
       */
      var choose = (providerId, entry) => {
        var effort = ''
        if (entry.reasoning && entry.reasoning.efforts.length > 0) {
          effort = entry.reasoning.efforts[entry.reasoning.efforts.length - 1].id
        }
        var selection = { provider: providerId, model: entry.id, reasoningEffort: effort }
        rememberSelection(selection)
        props.tabState.set(selection)
        if (state.conversation !== null) {
          patchConversation(state.conversation.id, selection).catch(() => {
            // The next turn re-sends the selection, so a failed patch only
            // costs the "remembered across reload" part.
          })
        }
      }

      // Outside pointer or Escape closes the card, without swallowing either
      // for the rest of the page.
      React.useEffect(() => {
        if (props.open !== true) return undefined
        var onPointer = (event) => {
          var target = event.target
          for (var edge of [cardRef.current, anchorRef.current]) {
            if (edge !== null && (edge === target || edge.contains(target))) return
          }
          props.onClose()
        }
        var onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          props.onClose()
        }
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [props.open])

      var rows = []
      for (const group of groups) {
        rows.push(
          h(
            'div',
            { className: 'dsh-sc-pickerGroup', key: 'group:' + group.id, 'data-dsh-sc': 'model-group' },
            h('span', { className: 'dsh-sc-pickerGroupDot', 'aria-hidden': 'true' }),
            group.name || group.id,
          ),
        )
        for (const entry of group.models) {
          var active = state.provider === group.id && state.model === entry.id
          rows.push(
            h(
              'button',
              {
                type: 'button',
                key: 'model:' + group.id + '/' + entry.id,
                className: 'dsh-sc-pickerRow' + (active ? ' dsh-sc-pickerRowActive' : ''),
                'data-dsh-sc': 'model-row',
                onClick: () => {
                  choose(group.id, entry)
                  props.onClose()
                },
              },
              h(
                'span',
                { className: 'dsh-sc-rowMain' },
                h('span', { className: 'dsh-sc-pickerName' }, entry.name || entry.id),
                h(
                  'span',
                  { className: 'dsh-sc-pickerId' },
                  entry.id + (entry.contextWindow ? ' · 上下文 ' + Math.round(entry.contextWindow / 1000) + 'k' : ''),
                ),
              ),
              entry.image ? h('span', { className: 'dsh-sc-badge' }, '图片') : null,
              active ? h('span', { className: 'dsh-sc-pickerCheck' }, renderIcon(ui.icons.check, 14)) : null,
            ),
          )
        }
      }
      for (const failure of failures) {
        rows.push(h('div', { className: 'dsh-sc-pickerEmpty', key: 'failure:' + failure.id }, failure.name + '：' + failure.message))
      }
      if (rows.length === 0) {
        rows.push(h('div', { className: 'dsh-sc-pickerEmpty', key: 'none' }, '这台部署没有注册任何可用的模型供应商。'))
      }

      var chip = h(
        'button',
        {
          ref: anchorRef,
          type: 'button',
          className: 'dsh-sc-modelButton',
          title: '选择模型',
          'data-dsh-sc': 'model-button',
          onClick: () => props.tabState.set({ menu: props.open ? '' : 'models' }),
        },
        renderIcon(ui.icons.sparkle, 14),
        h('span', { className: 'dsh-sc-modelName' }, current !== null && current.name ? current.name : state.model || '选择模型'),
        h('span', { className: 'dsh-sc-titleChevron' }, renderIcon(ui.icons.chevronDown, 14)),
      )

      return h(
        React.Fragment,
        null,
        chip,
        props.open === true
          ? h(
              'div',
              {
                ref: cardRef,
                className: 'dsh-sc-picker',
                'data-dsh-sc': 'model-picker',
                onPointerDown: (event) => event.stopPropagation(),
              },
              h(
                'div',
                { className: 'dsh-sc-pickerHead' },
                h('span', { className: 'dsh-sc-pickerTitle' }, '选择模型'),
                h(IconButton, {
                  label: '刷新模型列表',
                  icon: ui.icons.refresh,
                  'data-dsh-sc': 'picker-refresh',
                  onClick: () => {
                    fetchCatalog()
                      .then((catalogValue) =>
                        props.tabState.set({ catalog: catalogValue, catalogError: '', catalogSearch: catalogValue.search === true }),
                      )
                      .catch((error) => props.tabState.set({ catalogError: String((error && error.message) || error) }))
                  },
                }),
              ),
              h('div', { className: 'dsh-sc-pickerBody' }, rows),
            )
          : null,
      )
    }

    /**
     * The reasoning-effort chip beside the model selector.
     *
     * Visible only when the chosen model declares efforts; picking one opens a
     * plain vertical list (the kit menu — no sideways submenu in a sidebar).
     *
     * @param props - `tabState`, `open` and `onClose`.
     */
    function EffortMenu(props) {
      var state = useTabState(props.tabState)
      var catalog = state.catalog
      var current = modelEntry(catalog, state.provider, state.model)
      if (current === null || !current.reasoning || current.reasoning.efforts.length === 0) return null

      var efforts = current.reasoning.efforts
      /** The shown level: the stored one, else the strongest (the default). */
      var effective = efforts.some((effort) => effort.id === state.reasoningEffort)
        ? state.reasoningEffort
        : efforts[efforts.length - 1].id
      var labelEntry = efforts.find((effort) => effort.id === effective)
      var label = labelEntry ? labelEntry.name || labelEntry.id : ''

      var anchor = h(
        'button',
        {
          type: 'button',
          className: 'dsh-sc-modelButton dsh-sc-effortButton',
          title: '推理等级',
          'data-dsh-sc': 'effort-button',
          onClick: () => props.tabState.set({ menu: props.open ? '' : 'efforts' }),
        },
        renderIcon(ui.icons.think, 14),
        h('span', { className: 'dsh-sc-modelName' }, label),
        h('span', { className: 'dsh-sc-titleChevron' }, renderIcon(ui.icons.chevronDown, 14)),
      )

      return h(ui.Menu, {
        open: props.open === true,
        anchor: anchor,
        className: 'dsh-sc-effortAnchor',
        listClassName: 'dsh-sc-menuList',
        items: efforts.map((effort) => ({ id: effort.id, label: effort.name || effort.id })),
        selectedId: effective,
        align: 'end',
        side: 'top',
        portal: true,
        compact: true,
        onClose: props.onClose,
        onSelect: (id) => {
          props.tabState.set({ reasoningEffort: id })
          rememberSelection({ provider: state.provider, model: state.model, reasoningEffort: id })
          if (state.conversation !== null) {
            patchConversation(state.conversation.id, { reasoningEffort: id }).catch(() => {})
          }
          props.onClose()
        },
      })
    }    /**
     * The conversation switcher: every stored conversation, plus new and delete.
     * @param props - `state`, `tabState`, `onClose` and `onOpenConversation`.
     */
    function ConversationMenu(props) {
      var state = useTabState(props.tabState)
      var items = []
      if (state.conversations.length === 0) items.push({ id: 'empty', label: '还没有会话', disabled: true })
      for (const row of state.conversations) {
        items.push({
          id: 'conversation:' + row.id,
          label: h(
            'span',
            { className: 'dsh-sc-menuRow' },
            h('span', { className: 'dsh-sc-menuMain' }, row.title || '新对话'),
            h('span', { className: 'dsh-sc-menuNote' }, formatTime(row.updatedAt)),
          ),
        })
      }
      items.push({ id: 'sep:actions', type: 'separator' })
      items.push({ id: 'action:new', label: '新建会话', icon: renderIcon(ui.icons.plus, 14) })
      if (state.conversation !== null) {
        items.push({ id: 'action:delete', label: '删除当前会话', icon: renderIcon(ui.icons.trash, 14), danger: true })
      }

      var title = state.conversation === null ? TAB_TITLE : state.conversation.title || '新对话'
      var anchor = h(
        'button',
        {
          type: 'button',
          className: 'dsh-sc-titleButton',
          title: '切换会话',
          'data-dsh-sc': 'conversation-button',
          onClick: () => props.tabState.set({ menu: props.open ? '' : 'conversations' }),
        },
        renderIcon(ui.icons.list, 14),
        h('span', { className: 'dsh-sc-titleText' }, title),
        h('span', { className: 'dsh-sc-titleChevron' }, renderIcon(ui.icons.chevronDown, 14)),
      )

      return h(ui.Menu, {
        open: props.open === true,
        anchor: anchor,
        className: 'dsh-sc-titleAnchor',
        listClassName: 'dsh-sc-menuList',
        items: items,
        selectedId: state.conversation === null ? '' : 'conversation:' + state.conversation.id,
        align: 'start',
        side: 'bottom',
        portal: true,
        compact: true,
        onClose: props.onClose,
        onSelect: async (id) => {
          props.onClose()
          if (id.indexOf('conversation:') === 0) {
            await props.onOpenConversation(id.slice('conversation:'.length))
            return
          }
          if (id === 'action:new') {
            await props.onOpenConversation('')
            return
          }
          if (id === 'action:delete' && state.conversation !== null) {
            try {
              await deleteConversation(state.conversation.id)
            } catch {
              // A conversation that is already gone is the desired end state.
            }
            var listed = await fetchConversations().catch(() => ({ conversations: [] }))
            var remaining = listed.conversations || []
            props.tabState.set({ conversations: remaining })
            await props.onOpenConversation(remaining.length > 0 ? remaining[0].id : '')
          }
        },
      })
    }

    /**
     * The tab body: header, transcript, composer, and the two dropdown menus.
     *
     * @param props - the slot props; `useTabInfo` comes from the sidebar seat.
     */
    function ChatBody(props) {
      var info = props.useTabInfo()
      var tabId = info.tab.id
      var state = stateOf(tabId)
      var current = useTabState(state)
      var scrollRef = React.useRef(null)
      var inputRef = React.useRef(null)
      var fileRef = React.useRef(null)
      var focused = React.useState(false)
      var inputFocused = focused[0]
      var setInputFocused = focused[1]
      var reasoning = React.useState({})
      var openReasoning = reasoning[0]
      var setOpenReasoning = reasoning[1]
      var toolRow = React.useState({})
      var openTool = toolRow[0]
      var setOpenTool = toolRow[1]

      // Attach once per tab: the host owns the transcripts, the tab only holds
      // the selection and the draft.
      React.useEffect(() => {
        openConversation(state, rememberedConversation())
        return () => {
          // The store outlives the component on purpose: reopening the tab in
          // the same page keeps the transcript on screen.
        }
      }, [state])

      // Follow the conversation while it grows, unless the user scrolled up.
      React.useEffect(() => {
        var node = scrollRef.current
        if (node === null) return
        if (current.atBottom) node.scrollTop = node.scrollHeight
      })

      var messages = current.conversation === null ? [] : current.conversation.messages || []
      var canSend = !current.streaming && (current.draft.trim().length > 0 || current.pending.length > 0)
      var closeMenu = () => state.set({ menu: '' })

      /** Add picked files to the composer. */
      var addFiles = async (files) => {
        var images = Array.from(files).filter((file) => IMAGE_TYPES.indexOf(file.type) >= 0)
        if (images.length === 0) {
          if (files.length > 0) state.set({ error: '只支持 PNG / JPEG / WebP / GIF 图片' })
          return
        }
        state.set({ uploading: current.uploading + images.length, error: '' })
        for (const file of images) {
          var previewUrl = URL.createObjectURL(file)
          try {
            var record = await uploadAttachment(file)
            var latest = state.get()
            state.set({
              pending: latest.pending.concat([Object.assign({}, record, { previewUrl: previewUrl })]),
              uploading: Math.max(0, latest.uploading - 1),
            })
          } catch (error) {
            URL.revokeObjectURL(previewUrl)
            var now = state.get()
            state.set({ uploading: Math.max(0, now.uploading - 1), error: '图片上传失败：' + String((error && error.message) || error) })
          }
        }
        if (inputRef.current !== null) inputRef.current.focus()
      }

      /** Remove one pending attachment. */
      var removePending = (id) => {
        var kept = []
        for (const item of state.get().pending) {
          if (item.id === id) {
            releasePreview(item)
            continue
          }
          kept.push(item)
        }
        state.set({ pending: kept })
      }

      /** Grow the textarea to its content, up to the stylesheet's cap. */
      var resize = () => {
        var node = inputRef.current
        if (node === null) return
        node.style.height = 'auto'
        node.style.height = Math.min(node.scrollHeight, 180) + 'px'
      }

      var alerts = []
      if (current.error) {
        alerts.push(
          h(
            'div',
            { className: 'dsh-sc-alert dsh-sc-alertError', key: 'error' },
            h('span', { className: 'dsh-sc-alertIcon' }, renderIcon(ui.icons.warning, 14)),
            h('span', null, current.error),
          ),
        )
      }
      if (current.notice) {
        alerts.push(
          h(
            'div',
            { className: 'dsh-sc-alert dsh-sc-alertNotice', key: 'notice' },
            h('span', { className: 'dsh-sc-alertIcon' }, renderIcon(ui.icons.warning, 14)),
            h('span', null, current.notice),
          ),
        )
      }

      var transcript =
        current.status === 'loading'
          ? h('div', { className: 'dsh-sc-empty' }, h(ui.TextShimmer, { active: true }, '正在载入'))
          : messages.length === 0
            ? h(
                'div',
                { className: 'dsh-sc-empty', 'data-dsh-sc': 'empty' },
                h('span', { className: 'dsh-sc-emptyGlyph' }, renderIcon(ui.icons.chat, 24)),
                h('div', { className: 'dsh-sc-emptyTitle' }, '开始一段新对话'),
                h(
                  'div',
                  { className: 'dsh-sc-emptyHint' },
                  '这个窗口不绑定工作目录；',
                  h('br'),
                  '图片会存进系统临时文件夹。',
                ),
              )
            : messages.map((message) =>
                h(MessageRow, {
                  key: message.id,
                  message: message,
                  openReasoning: openReasoning[message.id] === true,
                  onToggleReasoning: () =>
                    setOpenReasoning(Object.assign({}, openReasoning, { [message.id]: !(openReasoning[message.id] === true) })),
                  openTool: openTool[message.id] || '',
                  onToggleTool: (rowId) =>
                    setOpenTool(Object.assign({}, openTool, { [message.id]: openTool[message.id] === rowId ? '' : rowId })),
                }),
              )

      var composer = h(
        'div',
        {
          className: 'dsh-sc-composer',
          // The stock composer installs document-level drag listeners that
          // swallow file drops; stopping propagation here keeps a drop aimed at
          // this tab from being taken by the main chat input behind it.
          onDragOver: (event) => {
            event.preventDefault()
            event.stopPropagation()
          },
          onDrop: (event) => {
            event.preventDefault()
            event.stopPropagation()
            if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files)
          },
        },
        h(
          'div',
          { className: 'dsh-sc-box' + (inputFocused ? ' dsh-sc-boxFocused' : '') },
          current.pending.length > 0
            ? h(AttachmentStrip, { attachments: current.pending, onRemove: removePending })
            : null,
          h('textarea', {
            ref: inputRef,
            className: 'dsh-sc-input',
            'data-dsh-sc': 'composer-input',
            rows: 1,
            placeholder: '输入消息，Enter 发送，Shift+Enter 换行',
            value: current.draft,
            onFocus: () => setInputFocused(true),
            onBlur: () => setInputFocused(false),
            onChange: (event) => {
              state.set({ draft: event.target.value })
              resize()
            },
            onPaste: (event) => {
              var items = event.clipboardData ? event.clipboardData.items : null
              if (!items) return
              var files = []
              for (var index = 0; index < items.length; index += 1) {
                if (items[index].kind !== 'file') continue
                var file = items[index].getAsFile()
                if (file && IMAGE_TYPES.indexOf(file.type) >= 0) files.push(file)
              }
              if (files.length === 0) return
              event.preventDefault()
              addFiles(files)
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (!current.streaming) sendDraft(state)
            },
          }),
          h(
            'div',
            { className: 'dsh-sc-toolbar' },
            h(IconButton, {
              label: '添加图片（也可以直接粘贴或拖进来）',
              icon: ui.icons.paperclip,
              'data-dsh-sc': 'attach',
              disabled: current.streaming,
              onClick: () => fileRef.current && fileRef.current.click(),
            }),
            // A labelled chip, not an icon: the composer's own chips (model,
            // permission) are text, and "联网" needs no decoding.
            h(ui.Pill, {
              active: current.searchOn === true,
              className: 'dsh-sc-searchPill',
              'data-dsh-sc': 'search-toggle',
              title: !current.catalogSearch
                ? '本次部署没有挂载联网搜索能力'
                : current.searchOn
                  ? '联网搜索：已开启（点击关闭）'
                  : '联网搜索：已关闭（点击开启）',
              disabled: !current.catalogSearch,
              onClick: () => {
                var next = state.get().searchOn !== true
                state.set({ searchOn: next })
                var conversation = state.get().conversation
                if (conversation !== null) {
                  patchConversation(conversation.id, { search: next }).catch(() => {})
                }
              },
            }, renderIcon(ui.icons.search, 14), '联网'),
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: IMAGE_TYPES.join(','),
              multiple: true,
              style: { display: 'none' },
              onChange: (event) => {
                if (event.target.files) addFiles(event.target.files)
                event.target.value = ''
              },
            }),
            current.uploading > 0
              ? h('span', { className: 'dsh-sc-metaRow' }, h(ui.TextShimmer, { active: true }, '正在上传 ' + current.uploading + ' 张图片'))
              : null,
            h('span', { className: 'dsh-sc-toolbarSpacer' }),
            h(ModelPicker, { tabState: state, open: current.menu === 'models', onClose: closeMenu }),
            h(EffortMenu, { tabState: state, open: current.menu === 'efforts', onClose: closeMenu }),
            current.streaming
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-sc-send dsh-sc-stop',
                    title: '停止生成',
                    'aria-label': '停止生成',
                    'data-dsh-sc': 'stop',
                    onClick: () => {
                      var runId = state.get().runId
                      if (runId) stopRun(runId).catch(() => {})
                      state.set({ streaming: false })
                    },
                  },
                  renderIcon(ui.icons.stop, 14),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-sc-send',
                    title: '发送',
                    'aria-label': '发送',
                    'data-dsh-sc': 'send',
                    disabled: !canSend,
                    onClick: () => sendDraft(state),
                  },
                  renderIcon(ui.icons.send, 14),
                ),
          ),
        ),
      )

      return h(
        'div',
        { className: 'dsh-sc-root', 'data-dsh-sidebar-chat': 'body' },
        h(
          'div',
          { className: 'dsh-sc-header' },
          h(ConversationMenu, {
            tabState: state,
            open: current.menu === 'conversations',
            onClose: closeMenu,
            // `''` means "a new conversation": the menu's own new-conversation
            // row and the post-delete fallback both ask for one that way.
            onOpenConversation: async (id) => {
              closeMenu()
              if (id === '') await newConversation(state)
              else await openConversation(state, id)
              if (inputRef.current !== null) inputRef.current.focus()
            },
          }),
          h('span', { className: 'dsh-sc-headerSpacer' }),
          h(IconButton, {
            label: '新建会话',
            icon: ui.icons.plus,
            'data-dsh-sc': 'new-conversation',
            onClick: async () => {
              closeMenu()
              await newConversation(state)
              if (inputRef.current !== null) inputRef.current.focus()
            },
          }),
        ),
        alerts.length > 0 ? h('div', { className: 'dsh-sc-alerts' }, alerts) : null,
        h(
          'div',
          {
            className: 'dsh-sc-scroll',
            'data-dsh-sc': 'transcript',
            ref: scrollRef,
            onScroll: (event) => {
              var node = event.target
              var atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40
              if (atBottom !== current.atBottom) state.set({ atBottom: atBottom })
            },
          },
          transcript,
        ),
        composer,
      )
    }

    /**
     * The sidebar chip: the glyph plus the live conversation title.
     * @param props - the title seat's props.
     */
    function ChatTitle(props) {
      var info = props.useTabInfo()
      var state = useTabState(stateOf(info.tab.id))
      var title = state.conversation === null ? TAB_TITLE : state.conversation.title || TAB_TITLE
      return h(
        React.Fragment,
        null,
        h(
          'span',
          { 'aria-hidden': 'true', style: { display: 'inline-flex', marginRight: 4, verticalAlign: '-2px' } },
          renderIcon(ui.icons.chat, 14),
        ),
        title,
      )
    }

    /**
     * The main composer's chat button: one click from where people type to the
     * sidebar tab. It lives outside the sidebar seats, so it reaches the
     * navigation controller through the captured service rather than props.
     */
    function ComposerChatButton() {
      var button = h(
        'button',
        {
          type: 'button',
          className: 'dsh-sc-iconButton',
          title: '在侧边栏打开聊天',
          'aria-label': '在侧边栏打开聊天',
          'data-dsh-sc': 'open-sidebar-chat',
          onClick: () => openChatTab(),
        },
        renderIcon(ui.icons.chat, 16),
      )
      return h(ui.Tooltip, { label: '在侧边栏打开聊天', side: 'top' }, button)
    }

    /**
     * Bring the chat tab to the front, opening it when it is not there yet.
     * @param sessionId - the composer's session, when the seat supplies one.
     */
    function openChatTab(sessionId) {
      var right = navigation.right
      if (right === undefined || right === null) return
      try {
        // `openTabIn` names the session explicitly and queues until that
        // session's surface is mounted; `openTab` needs one already mounted.
        if (typeof right.openTabIn === 'function' && typeof sessionId === 'string' && sessionId !== '') {
          right.openTabIn(sessionId, KIND)
          return
        }
        right.openTab(KIND)
      } catch (error) {
        // "no session surface is mounted" is a race with the sidebar's own
        // mounting, not a failure worth showing: the guide entry still opens it.
        if (typeof console !== 'undefined') console.warn('[sidebar-chat] 打开页签失败：', error)
      }
    }

    /** The navigation face, captured while the sidebar service is mounted. */
    var navigation = { right: undefined }

    /**
     * Register the tab type and both of its seats.
     *
     * `inject` lists cordis *service* names. The tab type is registered through
     * `ctx.inject`, because the registry service is provided a moment after the
     * native seat declares its slot; the bodies go through `ctx.slots.inject`,
     * because the seats themselves are declared by that same package.
     *
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ensureStyles()


      // The composer button sits outside the sidebar, so it keeps its own
      // handle on the navigation controller instead of receiving it as a prop.
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register({ name: 'conversation.input.left', id: PLUGIN_ID, order: 21 }, ComposerChatButton),
          ),
        'dsh-sidebar-chat: composer button',
      )

      ctx.inject(['sidebarRight'], (injected) => {
        navigation.right = injected.get('sidebarRight')
        return () => {
          navigation.right = undefined
        }
      })

      ctx.inject(['sidebarRightTabs'], (injected) => {
        var tabs = injected.get('sidebarRightTabs')
        if (tabs === undefined || tabs === null) return undefined

        var disposeType = tabs.register({
          id: TYPE_ID,
          kind: KIND,
          priority: 'extension',
          // A turn in flight must survive the sidebar losing the seat (another
          // tab activated, the column collapsed) instead of being torn down.
          keepMounted: true,
          title: () => TAB_TITLE,
          guide: [
            {
              id: 'chat',
              order: 45,
              title: () => TAB_TITLE,
              description: () => '不绑定工作目录的轻量聊天：选模型、发文字和图片',
              icon: (iconProps) => renderIcon(ui.icons.chat, iconProps && iconProps.size ? iconProps.size : 16),
            },
          ],
        })

        var disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TYPE_ID,
              inject: (sessionId) => ({ sessionId: sessionId }),
            },
            ChatBody,
          ),
        )
        var disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, ChatTitle),
        )

        ctx.logger?.info?.(`[sidebar-chat] 侧边栏页签 ${KIND} 已注册（组件库${ui.usingKit ? '已' : '未'}加载）`)
        return () => {
          disposeTitle()
          disposeBody()
          disposeType()
        }
      })

      ctx.effect(
        () => () => {
          for (const url of blobUrls.values()) {
            Promise.resolve(url).then((value) => URL.revokeObjectURL(value)).catch(() => {})
          }
          blobUrls.clear()
        },
        'dsh-sidebar-chat: blob urls',
      )
    }

    module.exports = {
      name: PLUGIN_ID,
      inject: ['slots'],
      apply: apply,
      /** Exported for tests and for the guide entry's glyph reuse. */
      _internal: {
        stateOf: stateOf,
        TabState: TabState,
        KIND: KIND,
        TYPE_ID: TYPE_ID,
        ROUTE: ROUTE,
        usingKit: ui.usingKit,
        missingIcons: ui.missingIcons,
        iconNames: ICON_NAMES,
      },
    }

    return module.exports
  },
})
