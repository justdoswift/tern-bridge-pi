# tern-bridge-pi

让 **Pi** 在 Tern 中使用原版 omp UI：复用 `@oh-my-pi/pi-tui` 的 Composer、助手消息、工具卡片、图片附件、欢迎卡、会话选择器和扩展对话框。插件通过 Pi 的 JSONL RPC 绑定数据与操作，不抓取官方 TUI、不使用 WebView、不复制上游 UI 源码，也不运行 omp 的模型循环。

上游原生 surface 的默认标题固定为 `omp`；桥接只替换 surface-open 的标题元数据为 Pi，并保留原组件生成的消息、布局和输入协议，不修改上游依赖源码。

## 环境与安装

- 启用原生程序界面的 Tern；Bun 1.3.14+；已安装并完成认证的 Pi CLI。
- 开发需要 Node.js 22.19+ 和 npm。运行依赖固定为 `@oh-my-pi/pi-tui` 18.11.0；Pi 仍使用本机安装版本。
- 自动命令入口针对 macOS/Linux 本机 zsh。Windows、远程窗格及其他 Shell 不注入入口。安装包包含平台原生模块，须在目标系统和架构重新构建；不能把 macOS arm64 包当成跨平台包。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run package
tern plugin install --force ./artifacts/package/tern-bridge-pi
```

`--force` 同时适用于首次安装和覆盖更新。更新前先退出已打开的 Pi 桥接会话；然后让 Tern 重载插件，并新开本机终端窗格。不要安装项目根目录或复制开发用的 `node_modules`；干净包内的 `dist/node_modules` 是运行时必需依赖，不能删除。

不需要 `tern serve` 或 `tern ctl`；它们属于开发验证流程。

## 启动

在 Tern 的新建本机 zsh 窗格直接输入：

```sh
pi
```

无参数、交互式启动在当前窗格打开桥接，使用实际工作目录。`/quit` 返回终端。所有带参数命令（包括 `pi --version`、`pi --mode rpc`、`pi --resume`）、管道和非交互调用仍原样交给官方 Pi CLI。要打开官方交互界面，使用 `command pi`；要按插件配置的 `piPath` 绕过桥接，使用 `TERN_PI_BRIDGE_BYPASS=1 pi`。

入口只在插件创建的窗格内安装 zsh 函数，不修改全局 PATH、Shell 配置、Pi 可执行文件或 Pi 的配置。保留原 `ZDOTDIR`、启动顺序和已有 `pi` alias/function；已有自定义命令时可使用命令面板。

macOS 默认按 **⌘K** 打开 Tern 命令面板，搜索 **Pi**，选择新建、恢复历史会话或右侧分屏。恢复历史使用 Pi 会话文件和保存的工作目录，不只是重新提供上下文。

插件偏好保存在 Tern 的 `plugin-data/tern-bridge-pi/preferences.json`：

```json
{"locale":"zh-CN","bunPath":"bun","piPath":"/absolute/path/to/pi"}
```

省略路径时使用实际 PATH 中的程序；`piPath` 不能指回本插件的 `bin/pi`。支持 `zh-CN` / `en-US`，也可在界面使用 `/language`。插件文案双语；上游原组件的英文、作者内容和扩展返回文本保持原样。

## 界面与操作

- 原版消息、Markdown、语法高亮代码、工具输出和 Diff；预览仅使用 Pi 已返回的数据，不读取本机文件补内容。
- 底栏只有真实模型、思考强度、发送/停止和上下文用量入口；没有 Droid 的 Auto/Spec、自主权限、工作目录、会话/更多按钮或输入/输出 Token 数。
- 模型和可用思考级别来自 Pi；不硬编码模型、不自动换模型、不提升权限。Pi 的认证、扩展、技能、MCP、工具、信任和重试策略仍由 Pi 控制。
- 活动工作栏显示实际工具意图、当前流式回复、思考、压缩或重试；观察计时不冒充历史执行耗时。执行时标签页显示绿点，等待输入、空闲和出错时隐藏。
- 点击上下文条或 `/context` 查看 Pi 报告的总用量和容量。未知值（包括刚压缩后的估计）在详情中显示未知，底栏暂时隐藏用量条，避免把缺失数据画成持续“处理中”。不把累计 Token 当成当前上下文，不伪造分类、85% 阈值或预留空间。
- Pi 没有内置 TodoWrite。只有扩展工具成功返回结构化 `details.todos`（`content` 和 `pending` / `in_progress` / `completed`）时显示原生任务环与清单；不从工具参数、自然语言或普通 widget 推断任务。
- 原生支持扩展的 select、confirm、input、editor，以及通知、状态、文本 widget、窗口标题和输入框内容。字面值、重复选项、取消和超时不改写。Pi 自定义终端组件、按键监听或自定义 header/footer 不是 RPC 原生 UI，不能承诺兼容。

输入 `/` 打开命令菜单：

`/sessions`、`/new`、`/resume [会话文件]`、`/model`、`/thinking`、`/rename`、`/fork`、`/clone`、`/compact [要求]`、`/context`、`/retry`、`/language`、`/help`、`/quit`。

每项始终有 `/bridge:名称` 入口。Pi 发现的扩展、prompt template、skill 命令优先于同名简写；未知的官方 TUI 命令不会静默作为提示词发送。分叉从真实用户消息 ID 创建分支；clone 复制当前分支，均不撤销文件。压缩可能请求模型并消耗额度。重新连接只读取会话，不自动重发消息。

### 输入与图片

- Enter 发送，Shift+Enter / Alt+Enter 换行；使用原组件的光标、中文输入、撤销、补全和滚动。
- macOS **⌘V** 直接粘贴图片或文字；图片显示原生缩略图附件，不加上传按钮。不支持图片的模型会明确阻止发送，不剥离图片或偷偷换模型。
- 附有图片时，包含 `/` 的文字仍作为图片消息发送，不误执行本地命令。草稿和附件仅在 Pi 确认接受对应消息后清空；失败、迟到剪贴板结果和取消会话切换不会串入另一会话。
- Ctrl+O 展开/收起工具和思考；Esc 关闭面板、取消扩展输入或请求停止；Ctrl+Alt+Shift+O 打开会话，Ctrl+Alt+Shift+N 新建会话，不覆盖 Tern 的 Cmd+O / Cmd+N。
- 运行期间可写草稿，但桥接不偷偷排队。Stop 先清空 Pi 队列再 abort；`agent_end` 不视为结束，等 Pi 的 `agent_settled` 后才恢复发送。

## 数据边界

Pi 是唯一执行器和会话写入者。桥接只读官方 JSONL 会话目录以列出历史，按实际当前分支恢复消息；不读取 omp 账号或会话库，不接管 Pi 认证。`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 和显式 session-dir 保持 Pi 的语义。插件数据目录仅保存偏好和保守的进程会话锁，不创建第二套正文数据库。

连接或协议失败显式报告，不记录原始 stdout/stderr、密钥、提示词、正文或模型载荷，不自动重放。锁可以防止桥接实例同时写同一会话，但无法约束从外部启动的官方 CLI。Pi RPC 的扩展事件没有统一的会话标识；桥接隔离子进程、请求、切换和对话框生命周期，但不能识别绕过 Pi 自身生命周期的失控旧扩展事件。

卸载：退出客户端后运行 `tern plugin remove tern-bridge-pi`，再新建窗格。不会删除 Pi 历史。开发链接使用 `tern plugin link ./artifacts/package/tern-bridge-pi`，取消链接使用 `tern plugin unlink tern-bridge-pi`。

## English

An independent Pi-to-Tern bridge using the original omp UI components, not another chat renderer. Pi owns authentication, providers, extensions, tools and session execution. This is not affiliated with Pi or omp.

Build and install with the commands above; reload Tern and open a new local zsh pane, then run bare `pi`. Argument-bearing invocations and pipelines pass through unchanged. `command pi` opens the official CLI. The command palette also provides new/resume/split actions. No global shell configuration or executable is modified.

Use `/` for session actions. `/bridge:*` names always address local actions; discovered Pi commands retain conflicting short aliases. Only Pi's real models and thinking levels appear in the footer. Paste images with Cmd+V; accepted-message acknowledgements, not optimistic submission, clear drafts. Stop clears queues before aborting. Fork/clone do not restore files; compaction can spend model quota.

Context details show Pi's aggregate estimate, including unknown values, not invented categories or thresholds. Structured task results may drive the native checklist; arbitrary widget prose does not. Standard RPC extension dialogs and text widgets are supported, not arbitrary custom terminal UI. Plugin-owned copy supports Chinese and English; upstream component text and author/extension content are not translated. No raw protocol or private-content logging is enabled. Linux and other platform builds require their own runtime verification.

## 验证范围 / Verification

已在 macOS arm64、Tern 0.8.3、Bun 1.3.14 下验证。真实 Pi 1.2.0 的离线、隔离配置验证覆盖模型/思考元数据、历史与工作目录、上下文、重命名、新建、复制和分叉，未发送模型请求。45 项行为测试通过；实际 Tern 界面使用独立协议夹具检查原组件、代码着色、扩展输入/取消、会话恢复、图片附件与不支持图片的错误保留、失败后不重放、语言与窄窗格、工作状态、`pi` 同窗格启动及 Droid 共存。命令入口还验证参数/退出码透传、官方 CLI 绕过、原 ZDOTDIR 与 alias/function 保留。

未访问或改动真实系统剪贴板；图片验证使用合成文件和原生附件组件，不代表物理 macOS 剪贴板的端到端验收。未调用真实付费模型、验证模型回答质量或实机验证 Linux；未安装到作者正常 Tern 配置或发布插件。The checks use isolated configuration and synthetic content; real-provider inference, the physical clipboard path and Linux remain unverified.
