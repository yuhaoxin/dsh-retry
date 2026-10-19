# dsh-retry

DeepSeek Harness 插件：重试上一条失败或被中断的助手回合，快捷键可在设置里修改。

行为对齐 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的重试语义（`/retry`、`app.retry`），但不复制其代码。

## 状态

插件尚未实现，当前只有可安装的 bundle 骨架。设计决策、待定项与实现任务记在仓库 issue tracker 上，地图 issue 标题为「Map: dsh-retry 重试与快捷键插件」（标签 `wayfinder:map`）；动手前先读它。

已经定下来的边界（依据见 `research/` 下的研究报告）：

- 默认快捷键计划为 `Alt+R`，只声明 desktop 三个平台。DSH 的键位注册表要求每个 `${runtime}:${platform}` 只给一个默认绑定，且无修饰键的组合（如 `F5`）在 `desktop:linux` 与 web 上会被校验拒绝，因此 `F5` 不能作为默认键。
- Web profile 只接受少数组合（`primary+Slash`、`primary+shift+Comma`、`primary+shift+Period` 等），`Alt+R` 在 Web 上无法绑定，默认不声明绑定。
- DSH 没有删除或改写会话历史的接口，`oh-my-pi` 那种"删掉失败回合再重放"的语义在 DSH 不能照搬；具体取舍见地图上的拷问票。

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

把 `desktop` 换成实际使用的 profile。也可以由已运行的 DSH 自带插件管理器安装同一个目录或包。安装后刷新窗口；改过 `index.js` 后需要重启 DSH 进程。

## 开发

不需要构建步骤：`client.js` 是直接提交进仓库的客户端模块，`index.js` 是 Host 代码。

```bash
node --test test/
```

## 许可

MIT
