# dsh-sidebar-chat

DSH（DeepSeek Harness）动态插件：**右侧栏里的一个聊天页签**。选模型、打字、贴图片，回车就发。

它的定位是「随手问一句」，所以刻意**不绑定工作目录**——没有会话、没有 agent 循环、没有工具，一次提问就是一次 `ctx.llm.stream()` 调用。图片**直接落在系统临时文件夹**，不进入任何项目目录，也不在会话工作区里留下副本。

<img src="assets/screenshot-1.png" width="330" alt="侧边栏聊天页签：用户消息靠右的品牌色气泡、助手的 markdown 正文、可折叠的思考过程、底部的模型胶囊与发送按钮"> <img src="assets/screenshot-2.png" width="330" alt="模型选择下拉：按供应商分组，标注「图片」能力与上下文长度，当前模型打勾，推理等级作为子菜单">

界面直接用 DSH 自己的组件库搭（`@deepseek-ai/dsh-client-ui-primitives`，平台内置模块，样式表本来就在页面里）：下拉菜单、Tooltip、图标、markdown 渲染、折叠行、图片灯箱全部是应用在用的那一套，配色和圆角走同一份 design token，所以浅色/深色主题与字号偏好是跟着应用走的，不是另做一套皮。

顶栏是「会话标题 ▾ ＋」；中间是消息流（用户消息靠右的品牌色气泡、助手 markdown 正文、思考过程折叠行、token 用量行）；底部输入框里是图片按钮 + 模型胶囊 + 发送/停止按钮，`Enter` 发送、`Shift+Enter` 换行，图片可直接粘贴或拖进来。

## 特性

| 特性 | 说明 |
|---|---|
| 原生右侧栏页签 | 注册为右侧栏自己的页签类型「聊天」，与文件 / 终端 / 浏览器 / 元素拾取并列，无第三方依赖 |
| 两个入口 | 右侧栏「＋」菜单里的「聊天」胶囊，以及主输入框左侧的聊天气泡按钮（一键唤到前台） |
| 与桌面端同款外观 | 用 DSH 内置组件库与 design token 渲染：同款下拉菜单 / Tooltip / 图标 / markdown / 折叠行 / 图片灯箱，跟随浅色与深色主题 |
| 模型可选 | 列表来自部署里真正可路由的供应商（`ctx.llm.listProviders/listModels/resolveModelInfo`），与主输入框的模型选择器同源；按供应商分组、标注「图片」与上下文长度、当前项打勾，推理等级是模型的子菜单 |
| 文字 + 图片 | 输入框、粘贴（`⌘V`）、拖拽、文件选择四种方式加图；图片先传到 host 存进临时文件夹，发送时才向框架换取可被模型读取的附件引用 |
| 联网搜索 | **默认开启**。输入框工具栏里是「🔍 联网」文字芯片（组件库的 Pill，开/关用它自己的 active 态），不是含糊的图标按钮。开启时模型可调用 `web_search`（**唯一工具，只读**）自己决定搜什么、必要时换词重搜；回答里给出来源链接，搜索活动连来源一起存进历史，重开页签还在 |
| 不绑定工作目录 | 不创建 DSH 会话、不设置 cwd、不读写会话工作区；只有 `llm` 与 `attachments` 两个框架能力被借用 |
| 文件存临时文件夹 | 原图逐字节写入 `<os.tmpdir()>/dsh-sidebar-chat/files/`，索引在同级 `index.json`；附件生命周期归操作系统，插件自己只做「超过 14 天未使用即清理」的兜底 |
| 历史持久化 | 会话与消息存在 `$DSH_HOME/dsh-sidebar-chat/conversations/`，一个会话一个 JSON，重启后仍在；可新建、切换、删除 |
| 流式输出 | 每回合一条 SSE 流：`start` / `delta` / `reasoning` / `usage` / `notice` / `done` / `error`；有停止按钮，关掉连接会一并中止模型调用 |
| 思考过程 | 模型的 reasoning 折叠显示，且**不回灌**到下一轮上下文（它是展示状态，不是对话内容） |
| 失败可见 | 供应商错误按稳定 code 分类并给出可操作提示（缺凭据 / 额度用尽 / 限流 / 上下文超限 / 模型不支持图片…）；一张读不出来的图片只会让自己标为「图片无效」，不会毒死整个会话 |
| 纯文本模型降级提示 | 选了不支持图片的模型又发了图，会在会话里明确提示「图片会被替换成占位文字」，而不是让模型假装没看见 |

## 安装

已装在 DeepSeek Harness 的 `desktop` profile（`~/.dsh/profiles/desktop`）上。重装或换机器：

```sh
node tools/install-into-profile.mjs --dry-run   # 先看要改什么
node tools/install-into-profile.mjs             # 幂等：软链 + link: 依赖 + bundle 挂载
node tools/install-into-profile.mjs --uninstall # 卸载（只删自己插入的那一行）
```

脚本做三件事，都不走 `dsh plugin add`（那会联网重解析整个 profile）：

1. 把包软链（或 `--copy` 复制）进 profile 的 `node_modules`；
2. 在 profile 的 `package.json` 里记一条 `link:` 依赖；
3. 在 profile 的 `cordis.patch.yml` 里插入 `sidebar-chat` 这一行 —— 这一层会被热重载，**存盘几秒后刷新页面即可，不用重启**。

包根目录另有一份 `cordis.patch.yml`，供 `dsh.profile.bundles` 那条安装路线使用。两条路线互斥：都会 insert 同一个条目 id，Loader 会报重复，脚本检测到包已在 bundles 里会直接拒绝执行。

刷新后：右侧栏「＋」菜单里会多一个「聊天」胶囊，主输入框左侧也会多一个聊天气泡按钮。

> 客户端半是「图谱同步」进页面的：包一旦进入模块图谱，**正在运行的页面会直接加载它，不必刷新**。host 半的改动则由 profile 的 `hmr` 行热重挂（见「开发」一节）。

## 数据放在哪

| 内容 | 位置 | 生命周期 |
|---|---|---|
| 你上传的图片 | `<os.tmpdir()>/dsh-sidebar-chat/files/<id>.<ext>` | 系统临时目录，操作系统负责清理；插件额外做 14 天未使用兜底清理 |
| 临时目录索引 | `<os.tmpdir()>/dsh-sidebar-chat/index.json` | 丢了会从文件重建（只丢元数据，不丢字节） |
| 会话与消息 | `$DSH_HOME/dsh-sidebar-chat/conversations/<id>.json` | 持久化，重启保留，直到你删除该会话 |

想确认实际路径：`curl -s http://127.0.0.1:19387/dsh-sidebar-chat/info`。

## 原理

```
┌─ 浏览器（右侧栏页签） ─────────────────────────────┐
│ lib/client.js                                      │
│   sidebarRightTabs.register(kind: 'sidebar-chat')  │
│   slots.register('sidebar.right.pane.tab', …)      │
│   fetch /dsh-sidebar-chat/*  +  SSE 读流           │
└───────────────────────┬────────────────────────────┘
                        │ 同源 fetch（loopback）
┌───────────────────────▼────────────────────────────┐
│ host 半 lib/index.js（Cordis 插件，webServer 路由）│
│   GET  /models            模型目录（含图片/推理能力）│
│   POST /attachments       原图 → 临时文件夹          │
│   GET  /attachments/:id   取回字节（页签显示用）     │
│   GET  /conversations     会话列表 / 详情 / 删除     │
│   POST /chat              SSE：一次模型调用          │
│   POST /stop              中止当前回合               │
│                                                     │
│   模块分工：                                        │
│     conversations.js  历史（$DSH_HOME，原子写）      │
│     temps.js          附件（os.tmpdir()，可重建索引）│
│     chat.js            transcript → messages → 事件  │
└───────────────────────┬────────────────────────────┘
                        │ ctx.llm.stream() / ctx.attachments.saveImages()
                        ▼
                 框架的 provider adapter → 模型
```

界面层还依赖一个平台事实：`@deepseek-ai/dsh-client-ui-primitives` 是**平台内置模块**（seed word），插件 bundle 可以直接 `require`，且它的样式表已经在页面里 —— 所以「和桌面端一致」不是照着截图调 CSS，而是复用同一批组件与 token。组件库缺失或改名时，`loadUi()` 会退回到一套等价的原生元素实现，页签仍然可用（样式由插件自己的 CSS 兜底）。

两个框架事实决定了上面这些设计：

* **模型调用**：`llm.stream(options)` 是同步方法、返回异步可迭代对象；供应商错误**不抛异常**，而是作为终止性的 `finish` chunk 出现（`reason.kind === 'error'`），所以 `chat.js` 把「抛出的异常」和「终止 chunk」归一到同一个 `error` 事件。
* **图片**：消息里的图片只能是**持久化附件引用**（`{type:'image', attachment: ref}`），provider adapter 只认这个。所以临时文件夹里的原图会在发送时交给 `ctx.attachments.saveImages()` 换取引用，并把引用写回消息，后续回合不必重复编码。写入临时目录用的是 `node:fs/promises`——`ctx.fs` 只写文本、且面向模型可控路径，不适合插件自己的二进制落盘。

## 开发

```sh
node --test test/          # 31 个用例：存储、消息装配、流事件、客户端注册与渲染
node tools/smoke.mjs       # 对着正在运行的 harness 跑真实链路（会自建自删一个会话）
```

两层测试：`test/core.test.mjs` 覆盖 host 半的纯逻辑（临时存储、会话存储、transcript→messages、流事件归一），`test/client.test.mjs` 用 `node:vm` + 桩 React（带 hook 与 effect 队列、可注入 fetch）跑一遍浏览器半：断言页签类型与两个 seat 的注册、把组件树真渲染出来（空态 / 带历史 / 模型菜单 / 会话菜单 / 组件库与降级两条路径），并对「新建会话必须新建而不是重开最近一个」「会话被别处删掉后仍能继续」这类行为做接口级断言。

`tools/smoke.mjs` 打的是真接口（17 项）：模型目录与搜索可用性、会话增删、图片上传与取回、带图回合（挑一个声明支持图片的模型）、纯文本模型的降级提示、**联网搜索整条链路**（模型发起搜索 → 来源返回 → 正文收尾 → 活动落盘）、停止按钮中止回合、以及「中止的回合仍然写入历史」。默认 `http://127.0.0.1:19387`，可用 `--base` / `--model` / `--text-model` 覆盖，`--keep` 保留测试会话，`--skip-search` 跳过联网检查（会消耗一次真实搜索）。

改 host 半想免重启，把 `lib` 加进 profile 的 hmr 监听根（`cordis.patch.yml` 的 `hmr` 行；注意那一行的 `config` 是**整体覆盖**，要连原有条目一起写）：

```yaml
- id: hmr
  config:
    root:
      - /Users/ravooo/Code/Github/dsh-sidebar-browser/lib
      - /Users/ravooo/Code/Github/dsh-sidebar-browser/resources
      - /Users/ravooo/Code/Github/dsh-sidebar-chat/lib
```

代价是热重挂会重置插件内存态（进行中的回合会断）。client 半的改动由模块系统按 revision 重取，刷新页面即可。

## 安全与边界

* 插件的路由挂在 harness web 服务器上，**不经过 `/api` 的 Host/Origin + 浏览器鉴权栅栏**（与同机其它第三方侧边栏插件一致）。同源页面之外的网页读不到响应（无 CORS 头），但**本机进程可以访问**——里面是你的聊天记录，介意的话用完 `--uninstall`。
* 附件只按不透明 id 取回，路由不接受调用方给的路径，不存在目录穿越面。
* 本插件不执行命令、不读写工作区、不注册任何模型可见的工具。

## 已知边界

* 页签类型是「页面型」，每个分栏最多一个聊天页签；同时开多个会话请用页签内的会话列表切换。
* 会话标题取自第一条消息（前 40 字），暂不支持手动重命名（host 路由支持 `PATCH /conversations/:id {title}`）。
* reasoning 不参与后续上下文：换模型继续同一个会话时，历史里只有正文。
* 系统临时目录被系统清空后，旧会话里的图片会显示「图片已过期」，文字历史不受影响。
* 非图片附件（PDF、文本等）暂不支持：框架侧它们只能以「文件句柄文本」形式给模型，对轻量聊天没有意义。

## License

MIT
