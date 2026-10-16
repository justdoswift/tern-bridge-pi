# Changelog

## 0.1.0 — Unreleased

- Skill 消息改用原版 omp 折叠卡片，默认显示名称与附加要求摘要，点击或 Ctrl+O 展开全文；新消息和历史恢复采用相同展示，不改变原始消息、模型输入或图片。
- Render skill messages as stock omp collapsed cards with name and argument previews; expand by clicking or Ctrl+O. Live and restored messages preserve original content, model inputs and images.
- 回车后立即清空输入框并显示原版 omp 待发送消息气泡；Pi 回传后使用真实消息替换，不重复展示。未确认的发送保留文字、图片及粘贴内容，恢复时不覆盖新草稿；扩展状态更新不再被误判为任务完成。
- Clear the composer immediately and show a pending stock omp bubble; reconcile with Pi's actual message without duplicates. Recover unconfirmed text, images and pasted content without overwriting newer drafts; extension status updates no longer imply turn completion.
- 修复连续两次 Ctrl+C 无法退出；保留原版 omp 的双击退出行为，并停止当前任务、清理未发送草稿。
- TPS、缓存等扩展状态以小字号放到思考强度右侧，保留实时更新、主题颜色和完整悬停说明；文本小组件与输入框对齐。
- Tern 本机 zsh 入口支持 `Pi`、`PI` 及混合大小写，保留已有 alias、function 和独立同名程序；README 改为安装与日常使用指南。
- Restore double-Ctrl-C exit through the original omp handler, with task interruption and draft cleanup.
- Place compact extension statuses beside the thinking level, preserving updates, theme colors and full tooltips; align text widgets with the composer.
- Accept case variants of `pi` in local Tern zsh panes without replacing existing user commands; rewrite the README around installation and everyday use.
- 使用原版 omp UI 连接 Pi JSONL RPC：流式消息、工具/代码/Diff、模型与思考强度、会话选择/分叉/复制、上下文与扩展输入。
- 支持原生图片粘贴、真实工作步骤及标签活动点；仅确认的结构化扩展任务驱动任务清单。
- 提供中英文插件操作；本机 zsh 的无参数 `pi` 在当前 Tern 窗格打开，其他参数调用保持官方 CLI 行为。
- 保留 Pi 的认证、扩展和执行策略；不引入 Droid 模式、权限、备用模型或另一套会话数据库。

- Connect Pi JSONL RPC to original omp UI: streamed messages, tools/code/diffs, model/thinking choices, sessions/fork/clone, context and extension dialogs.
- Support native image paste, observed work steps and tab activity; only confirmed structured extension tasks drive the checklist.
- Add bilingual bridge actions and a pane-local bare `pi` launcher; argument-bearing calls retain official CLI behavior.
- Preserve Pi authentication, extensions and execution policy, without Droid modes, permission controls, fallback models or a second session store.
