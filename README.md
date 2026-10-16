# Tern Pi

**在 Tern 里用 Pi，保留 omp 的对话体验。**

这个插件把 Pi 接入 Tern 的原生界面：使用原版 omp 的消息排版、代码高亮和输入框，同时继续使用 Pi 的模型、工具、扩展和历史会话。你不需要为插件重新配置一套 AI 服务。

[安装](#安装) · [使用](#使用) · [常见问题](#常见问题) · [反馈问题](https://github.com/justdoswift/tern-bridge-pi/issues) · [Droid 版本](https://github.com/justdoswift/tern-bridge-droid)

## 能做什么

- **更清晰地阅读回复**：流式消息、Markdown、代码高亮、Diff，以及可展开的工具输出和思考内容。
- **直接粘贴图片**：按 `⌘V` 添加图片或截图，查看缩略图后随消息发送，不用找上传按钮。
- **继续已有工作**：搜索和恢复 Pi 历史会话，也可以新建、重命名、分叉或复制当前分支。
- **保留 Pi 的可扩展性**：使用扩展提供的选择、确认、输入和编辑对话框，以及通知和文本小组件。
- **看清运行状态**：当前步骤、上下文用量、运行标签绿点；TPS、缓存等扩展状态以小字号显示在思考强度右侧。

插件操作支持中文和 English，部分上游界面仍为英文。这是独立桥接插件，不是 Tern 的整套汉化包，也不运行 omp 的模型服务。

## 安装

先准备好：

- 支持原生程序界面的 [Tern](https://docs.stencil.so/tern/index.html)。
- 已安装、完成模型认证且能正常使用的 **Pi CLI**。
- **Bun 1.3.14+**、**Node.js 22.19+ 和 npm**，以及 Git、curl、Bash。

关闭已打开的 Pi 插件会话，在准备使用插件的机器上执行：

```sh
curl -fsSL https://raw.githubusercontent.com/justdoswift/tern-bridge-pi/main/install.sh | bash
```

脚本默认执行 `install`：检查依赖、下载 `main`、在临时目录构建完整运行包，再调用 Tern 安装。缺少依赖会提示，不会替你安装系统软件、修改 Shell 配置或执行登录。已有插件不会被默认覆盖，请使用下方的 `update`。

这条命令会执行远程代码；也可以先下载并审阅 [install.sh](https://github.com/justdoswift/tern-bridge-pi/blob/main/install.sh)，再运行 `bash install.sh`。

安装后**重启 Tern，再新建一个本机 zsh 终端窗格**。在该窗格输入：

```sh
pi
```

`Pi`、`PI` 和混合大小写也可以。插件会在当前窗格打开，使用当前工作目录；输入 `/quit` 返回终端。已有的同名 alias、function 或独立程序不会被覆盖。

> 当前验证平台为 macOS Apple Silicon。Linux 需要在目标机器构建，尚未实机验证；Windows 和远程窗格不在支持范围。安装包包含平台原生依赖，不能跨系统或架构直接复制使用。

## 使用

### 输入和快捷键

| 操作 | 快捷键 |
| --- | --- |
| 发送消息 | `Enter` |
| 换行 | `Shift+Enter` 或 `Alt+Enter` |
| 粘贴文字或图片（macOS） | `⌘V` |
| 展开 / 收起工具输出、思考与 skill 内容 | `Ctrl+O` |
| 停止任务 / 关闭当前面板 | `Esc` |
| 清空草稿并请求停止任务 | `Ctrl+C` |
| 退出插件、返回终端 | 连按两次 `Ctrl+C` |

按 `Enter` 后，输入框立即清空，消息以原版 omp 气泡显示“发送中”；Pi 回传后改为正式消息，不重复展示。模型响应速度仍取决于 Pi 和服务商。

未确认发送时会恢复原草稿（包括图片）。如果你已经开始写下一条，则保留新草稿；原消息可在输入框为空时按 `↑` 找回。图片粘贴后不会自动发送，是否能被模型处理取决于所选模型；任务运行期间写下的下一条草稿不会自动排队发送。

### 会话和设置

输入 `/` 打开菜单，不需要记住全部命令：

| 想做什么 | 命令 |
| --- | --- |
| 打开历史会话 / 新建会话 | `/sessions` / `/new` |
| 选择模型 / 思考强度 | `/model` / `/thinking` |
| 查看上下文用量 | `/context`，或点击输入框上方的用量条 |
| 重命名 / 从消息分叉 / 复制当前分支 | `/rename` / `/fork` / `/clone` |
| 压缩上下文 | `/compact` |
| 重新连接 / 切换界面语言 | `/retry` / `/language` |
| 查看操作 / 退出 | `/help` / `/quit` |

如果 Pi 扩展占用了同名命令，使用 `/bridge:名称`，例如 `/bridge:sessions`，即可打开插件自己的操作。

菜单会列出 Pi 提供的 skill，例如 `/skill:review`。选择后可继续填写要求，再按 `Enter` 发送。会话里默认显示紧凑的 skill 卡片和要求摘要，不铺开整篇说明；点击卡片标题或按 `Ctrl+O` 查看全文。折叠只影响显示，不删减模型收到的内容，也不修改已保存的历史。

**分叉和复制会话不会撤销文件修改。** 压缩上下文可能调用模型并消耗额度；重新连接不会自动重发上一条消息。

也可以按 **`⌘K`** 打开 Tern 命令面板，搜索 **Pi**，选择新建对话、恢复历史或在右侧分屏打开。

## 更新与卸载

更新前先退出已打开的 Pi 插件会话，无需手动进入仓库：

```sh
curl -fsSL https://raw.githubusercontent.com/justdoswift/tern-bridge-pi/main/install.sh | bash -s -- update
```

`update` 获取最新 `main`，构建成功后才通过 Tern 的 `--force` 替换插件；下载或构建失败不会动旧版。它也可以在尚未安装时安装。更新后重启 Tern，再新建终端窗格。开发用的链接安装不会被强行覆盖或自动解除链接。

卸载：

```sh
curl -fsSL https://raw.githubusercontent.com/justdoswift/tern-bridge-pi/main/install.sh | bash -s -- uninstall
```

卸载只要求有 Tern，不要求 Node、npm、Bun 或 Pi CLI。它等同于本地执行 `tern plugin remove tern-bridge-pi`；**仅移除插件，保留插件配置、Pi 账号与历史会话，也不卸载 Pi CLI**。先退出插件会话，卸载后重启 Tern 并新建终端窗格。

## 常见问题

**还能用官方 Pi 界面吗？**

可以，运行 `command pi`。`pi --version`、`pi --resume` 等带参数命令仍交给官方 CLI。插件不修改全局 Shell 配置或 Pi 可执行文件。

**输入 `pi` 没打开插件？**

确认已经重启 Tern，并且使用新建的本机 zsh 窗格。其他 Shell 或已有同名 alias/function 时，用 `⌘K` 命令面板打开。日常使用不需要 `tern serve` 或 `tern ctl`。

**模型、费用和会话由谁管理？**

仍由 Pi 管理，插件不自动切换模型、不接管登录，也不新建一套会话库。不要在桥接和官方 CLI 中同时操作同一个会话。

**为什么没有 TPS 或任务进度？**

TPS、缓存等状态由你的 Pi 扩展提供，插件不会自行估算。Pi 没有内置 TodoWrite；任务进度需要扩展返回结构化任务清单。没有对应扩展或数据时，不显示这些内容。

**所有 Pi 扩展都兼容吗？**

支持标准的选择、确认、输入、编辑、通知和文本小组件。自定义终端界面、header/footer 和按键监听不保证兼容；这类功能仍可在官方 Pi 界面使用。

<details>
<summary>找不到 Bun 或 Pi 时，如何指定路径？</summary>

在 Tern 配置目录下的 `plugin-data/tern-bridge-pi/preferences.json` 中设置：

```json
{
  "locale": "zh-CN",
  "bunPath": "/absolute/path/to/bun",
  "piPath": "/absolute/path/to/pi"
}
```

用 `command -v bun`、`whence -p pi` 在 zsh 中查找真实可执行文件。不要把插件的 `bin/pi` 填成 `piPath`；修改后新建终端窗格。

</details>

## English

Use Pi in Tern with the original omp conversation UI. Pi keeps control of authentication, models, tools, extensions and saved sessions; this bridge provides the interface.

Install with the curl command above; it requires Tern, an installed and authenticated Pi CLI, Bun 1.3.14+, Node.js 22.19+, npm, Git and Bash. The script builds `main` in a temporary directory, without installing system tools or changing shell profiles. Review [install.sh](https://github.com/justdoswift/tern-bridge-pi/blob/main/install.sh) before executing remote code. Use `bash -s -- update` to explicitly replace the package only after a successful build, or `bash -s -- uninstall` to remove it. Uninstall needs only Tern and preserves plugin data, accounts, sessions and the official CLI; `tern plugin remove tern-bridge-pi` also works offline. Linked development packages are never automatically unlinked.

Restart Tern, open a new local zsh pane and run `pi` (case-insensitive unless the name is already in use). Use `/` for actions, `Cmd+V` to paste images, `/quit` or two quick presses of `Ctrl+C` to exit, and `command pi` for the official CLI. macOS Apple Silicon is the verified platform; Linux remains unverified. Standard extension dialogs and text widgets are supported, not arbitrary custom terminal UI. Clipboard input is implemented, but the physical macOS clipboard path has not yet been verified end to end.

Press `Enter` for immediate composer clearing and a pending message bubble. Pi's own message replaces it when received. Unconfirmed sends restore the original draft and images unless you have started a new draft; in that case, keep writing and recall the original with `↑` from an empty composer. Nothing is automatically resent.

Skills such as `/skill:review` appear in the slash menu when Pi advertises them. Their loaded instructions stay collapsed in stock omp cards, with your arguments previewed; click the card header or press `Ctrl+O` to expand. Model inputs and saved history remain unchanged.

## 许可与致谢

插件自有代码采用 [MIT License](LICENSE)。感谢 Tern、omp 和 Pi；本项目是独立集成，不代表任何上游项目的官方产品或背书。

上游依赖保留各自许可证，见 [第三方许可](dist/THIRD_PARTY_NOTICES.txt)。Pi、Tern 和 omp 的名称及商标权仍属于各自权利人，MIT 不授予第三方商标权。
