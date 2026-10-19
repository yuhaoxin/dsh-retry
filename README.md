# dsh-retry

DeepSeek Harness 插件：重试上一条失败或被中断的助手回合，快捷键可在设置里修改。

行为对齐 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的重试语义（`/retry`、`app.retry`），不复制其代码。

## 用法

- 命令：`/retry`，出现在命令面板与斜杠列表里。
- 快捷键：默认 `Alt+R`。改键有两个入口：插件页（「插件」→「已安装」→ `dsh-retry` 详情页的配置区）列出本插件动作的当前键位、是否被改过、冲突与非法原因，并提供录制 / 手输组合 / 恢复默认 / 解除绑定；「设置」→「通用」→「快捷键」是全局键位表。改完立即生效，冲突会即时提示。
- 没有可重试的回合时返回 `Nothing to retry.`，不产生任何副作用。

## 重试做了什么

DSH 没有重放上一轮的接口，也没有「不新增消息就唤醒回合」的入口。本插件的重试是：向当前会话注入一条说明重试意图的用户消息并唤醒 agent，模型在新回合重新生成。

- 该消息的来源标记为 `cordis-host-runner`，客户端把它渲染成 **turn-trigger 卡片**，不是冒充真人输入的用户气泡。
- 判定只看最后一条 `turn/end` 的结束原因：`error`（请求失败）、`aborted`（被中止）、`interrupted`（崩溃恢复）可重试；`completed`、`blocked`、`max-tokens`、`forked` 不可重试；回合仍在进行时不可重试。
- 命令返回成功只表示消息已进入 inbox，模型请求是异步执行的。

### 与 oh-my-pi 的差异

| 方面 | oh-my-pi | 本插件 |
| --- | --- | --- |
| 失败回合的助手消息 | 从活动上下文删除后重放 | 不能删除；DSH 的 surface 历史只追加 |
| 中断留下的半截输出 | 可清理持久化分支 | 仍会进入重试请求，模型能看到 |
| 键位配置 | 只能改 `keybindings.yml`，无冲突提示 | 设置界面里改，带冲突提示 |
| 默认键 | `F5` + `Alt+R` | 只有 `Alt+R`（DSH 每个 profile 只允许一个默认绑定） |

## 键位限制

- 默认只声明 desktop 三个平台。Web profile 的键位白名单只接受 `primary+Slash`、`primary+shift+Comma`、`primary+shift+Period` 等少数组合，`Alt+R` 在 Web 上无法绑定，因此不声明 Web 默认值。
- `F5` 不能作为默认键：无修饰键的组合在 `desktop:linux` 与全部 Web profile 上会被注册表以 `modifier-required` 拒绝，而注册表对已声明的每个平台逐个校验。需要 `F5` 时可在设置里自行改键（仅 desktop macOS/Windows 允许无修饰键组合）。
- 终端区不抢键：动作只在 `page` 与 `editable` 区域生效。

## 安装

从 GitHub 安装：

```bash
dsh plugin --profile desktop add github:yuhaoxin/dsh-retry
```

从本地目录安装（开发时）：

```bash
git clone https://github.com/yuhaoxin/dsh-retry.git
cd dsh-retry
dsh plugin --profile desktop add "$PWD"
```

把 `desktop` 换成实际使用的 profile。也可以由已运行的 DSH 自带插件管理器安装同一个目录或包。安装后刷新窗口；改过 `index.js` 或 `src/host/**` 后需要重启 DSH 进程。

改动 `client.js`（含设置页）后同样要刷新窗口：已打开的页面持有加载时的模块图快照，服务端虽已下发新 bundle，页面不会自行重建。

Host 半身不依赖任何 `@deepseek-ai/*` 包：插件以 `link:` 形态安装时，运行时只在插件自己 `peerDependencies` 列出包名时才把解析重定向到安装副本，而本插件不声明 peer（避免版本门禁阻断安装）。user 消息按会话层校验契约在本地构造，见 `src/host/user-message.js`。

## 开发

不需要构建步骤：`client.js` 是直接提交进仓库的客户端模块，`index.js` 与 `src/host/**` 是 Host 代码。

```bash
node --test test/
```

## 已知限制

- 重试不删除历史：中断留下的半截助手输出仍会进入重试请求。
- 无重试次数上限，也没有防连击；连续按会连续追加消息。
- 只在主视图持有的会话上生效；没有主会话时按键返回提示而不触发。
- Web 端没有默认键位，只能通过命令面板触发。
- 没有「重放失败工具调用批次」的能力（oh-my-pi 的第二层语义）。
- **已归档的会话无法重试**：这类会话的 `turn/end` 恒为 `blocked`（`agent/pre-step` 对归档会话返回 reject），命令会返回 `Nothing to retry.`。这是 DSH 语义，不是本插件的判定缺陷。

## 许可

MIT
