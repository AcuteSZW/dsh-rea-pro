# dsh-rea-pro

REA 的逆向工具集接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）的插件，并在输入框工具条上提供一个开关。不需要 REA 时点一下关掉，REA 的 MCP 子进程随之退出，工具也不再占用上下文。

English: mounts [REA](https://github.com/morluto/rea)'s MCP server in DeepSeek Harness and adds a composer chip to switch it off when a session does not need it.

## 安装

```sh
dsh plugin --profile web add dsh-rea-pro
```

包还没发到 npm 之前，也可以直接从 GitHub 装：

```sh
dsh plugin --profile web add github:AcuteSZW/dsh-rea-pro
```

两种装法等价：装完重启 Harness 一次，工具条上会出现 `● REA 开`。也可以在产品界面里装：**插件 → 安装**，来源填包名或仓库地址。

## 它能做什么

- 把 REA 的 stdio MCP 服务注册给 DSH，工具随插件生命周期出现和消失。
- 在输入框工具条（`完全权限 / 专家 / PUA` 那一排）加一个 `REA 开 / REA 关` chip，点击即切换。
- 开关状态保存在 `~/.dsh/rea-mcp-state.json`，重启后保持。

## 依赖

- DSH `>= 0.2.1`，且 profile 里挂了 `@deepseek-ai/dsh-web-app`（`mcp-manager` 由它提供）。
- [rea-agents](https://www.npmjs.com/package/rea-agents) `^6.8.0`，作为本插件的依赖自动安装，不需要单独部署 REA 仓库。

插件不安装或升级 Node、npm、分析引擎；REA 自己的 provider（Ghidra / IDA / JADX / Kuna 等）按 REA 文档配置，插件不代劳。

## 开关

chip 显示三态：`REA 开`、`REA 关`、`REA …`（切换进行中）。关闭时 Host 侧注销服务器注册，MCP 子进程退出；开启时重新注册并拉起子进程，通常几秒内可用。

REA 的子进程收尾较慢，插件给了 20 秒的关闭预算（`closeTimeoutMs`）。预算太短时 DSH 会把该服务器记成"cleanup 未完成"，之后所有重新挂载都会被拒绝——所以这个值不要调小。

状态接口（同源，仅本机页面可用）：

- `GET /dsh-rea/status` → `{ ok, enabled, mounted, serverName, script, server?, error? }`，`server` 是 DSH 侧该服务器的实时状态（`state` 为 `connected` 时带 `toolCount`）
- `POST /dsh-rea/toggle`，body `{ "enabled": true|false }`

## 发版

改完插件后怎么升版本、发 npm、装回 profile、更新市场条目：见 [RELEASING.md](./RELEASING.md)。

## 排错

- chip 显示 `REA ?`：读不到状态。先确认插件已加载（**插件 → 已安装**里有 `dsh-rea-pro`），再看 Harness 启动日志。
- chip 能点但工具没出现：多半是 `rea-agents` 没装进 profile，或 REA 自身启动失败；用 REA 的 `doctor` 检查（`npx rea-agents doctor`）。
- `pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 退出、提示 `Ignored build scripts: frida`：这是 pnpm 拦下了 REA 依赖里 frida 的安装脚本，包本身已经装好、插件可用。要让 frida 相关能力也完整，在 profile 目录跑 `pnpm approve-builds` 选中 frida（或在 `pnpm-workspace.yaml` 的 `allowBuilds` 里加 `frida: true`）后重装、重启。
- 工具数量和期望不一致：npm 版 `rea-agents` 的目录是 229 个工具（`doctor` 里的 `mcp_tools`）；用自己仓库完整构建出来的副本可能更多。插件只负责挂载，工具集由 REA 决定。
- Windows 上 REA 报缺少原生模块：`rea-agents` 的发行包已带 Windows 原生件；若被裁剪，按 REA 文档重建 `native/windows`。

## 卸载

```sh
dsh plugin --profile web remove dsh-rea-pro
```

## 许可

MIT
