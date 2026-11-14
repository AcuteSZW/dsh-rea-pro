# dsh-rea-pro

REA 的逆向工具集接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）的插件，并在输入框工具条上提供一个开关。新装默认关闭；需要时点一下开启，关掉后 REA 的 MCP 子进程随之退出，工具也不再占用上下文。

English: mounts [REA](https://github.com/morluto/rea)'s MCP server in DeepSeek Harness and adds a composer chip to switch it on for the sessions that need it; it starts off after install.

## 安装

```sh
dsh plugin --profile web add dsh-rea-pro
```

包还没发到 npm 之前，也可以直接从 GitHub 装：

```sh
dsh plugin --profile web add github:AcuteSZW/dsh-rea-pro
```

两种装法等价：装完重启 Harness 一次，工具条上会出现 `● REA 关`。也可以在产品界面里装：**插件 → 安装**，来源填包名或仓库地址。新装默认是关的，要用的时候点一下。

## 它能做什么

- 把 REA 的 stdio MCP 服务注册给 DSH，工具随插件生命周期出现和消失。
- 在输入框工具条（`完全权限 / 专家 / PUA` 那一排）加一个 `REA 开 / REA 关` chip，点击即切换。
- 开关状态保存在 `~/.dsh/rea-mcp-state.json`，重启后保持。

## 依赖

- DSH `>= 0.2.1`，且 profile 里挂了 `@deepseek-ai/dsh-web-app`（`mcp-manager` 由它提供）。
- [rea-agents](https://www.npmjs.com/package/rea-agents) `^6.8.0`：**第三方 npm 包**，作为本插件的依赖自动安装，不需要单独部署 REA 仓库。会话里那些工具就是它提供的（npm 发行版 `6.8.0` 的目录是 229 个工具），插件只负责把它挂进 DSH。

插件不安装或升级 Node、npm、分析引擎；REA 自己的 provider（Ghidra / IDA / JADX / Kuna 等）按 REA 文档配置，插件不代劳。

## 开关

chip 只有两个状态：`REA 开`、`REA 关`。关闭时 Host 侧注销服务器注册，MCP 子进程退出；开启时重新注册并拉起子进程。

REA 自己的启动就不快：在热机上从拉起子进程到 `connected`（255 个工具就绪）实测约 40–60 秒。所以点开之后 chip 立刻变成 `REA 开`，工具在服务器真正连上后才出现，界面会在这期间持续核对状态；只有 DSH 把这条服务器记成失败（关闭没清理干净、子进程起不来）时，chip 才会自动退回 `REA 关` 并把原因写进悬停提示。

REA 的子进程收尾较慢，插件给了 60 秒的关闭预算（`closeTimeoutMs`）。预算太短时 DSH 会把该服务器记成"cleanup 未完成"，之后所有重新挂载都会被拒绝——所以这个值不要调小。真遇到"cleanup 未完成"的提示，重启一次 DSH 即可恢复。

**新装默认关**：状态文件不存在时按"关"处理，装完第一次启动不会把 REA 的工具挂进会话，需要你在 chip 上点一下。点过之后状态存进 `~/.dsh/rea-mcp-state.json`，重启后保持。

状态接口（仅本机已认证的 Harness 页面可用）：

- `GET /dsh-rea/status` → `{ ok, enabled, mounted, serverName, script, server?, error? }`，`server` 是 DSH 侧该服务器的实时状态（`state` 为 `connected` 时带 `toolCount`）
- `POST /dsh-rea/toggle`，body `{ "enabled": true|false }`，要求 `Content-Type: application/json`

两条路由的准入交给 DSH 的 WebServer 认证策略：`register` 不带 `auth` 时默认为 `required`，由 DSH 的认证 Provider 在 `webserver/authorize` 里裁决——先过 Host/Origin 围栏，再要求请求带上本会话认证过的浏览器 Cookie。这样即使有站点把自己的域名解析到 `127.0.0.1`（DNS 重绑定），它既拿不到围栏放行，也拿不到 Cookie。插件自身不实现鉴权。

## 和别的 REA 插件共存

市场上还有其它接入 REA 的插件（例如 `czcdr/dsh-plugin-rea` 注册的服务器名是 `rea`，工具名形如 `mcp__rea__*`）。两个插件同装、且服务器名都取默认 `rea` 时，后装的会跟前一个抢同一个名字。本插件的服务器名可配，在 `cordis.patch.yml` 里改 `serverName` 即可：

```yaml
- name: dsh-rea-pro
  config:
    serverName: rea-pro   # 工具名随之变成 mcp__rea-pro__*
```

## 发版

改完插件后怎么升版本、发 npm、装回 profile、更新市场条目：见 [RELEASING.md](./RELEASING.md)。

## 排错

- chip 点不动（停在 `REA 关`）：读不到状态。先确认插件已加载（**插件 → 已安装**里有 `dsh-rea-pro`），再看 Harness 启动日志。
- chip 能点但工具没出现：点开后 REA 要 40–60 秒才连上，等一会儿再看；chip 若自动退回 `REA 关`，悬停提示会写明原因。提示"这次关闭没有清理干净"时，DSH 侧这条记录已卡死，重启 DSH 即可；其它情况多是 `rea-agents` 没装进 profile，或 REA 自身启动失败，用 REA 的 `doctor` 检查（`npx rea-agents doctor`）。
- `pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 退出、提示 `Ignored build scripts: frida`：这是 pnpm 拦下了 REA 依赖里 frida 的安装脚本，包本身已经装好、插件可用。要让 frida 相关能力也完整，在 profile 目录跑 `pnpm approve-builds` 选中 frida（或在 `pnpm-workspace.yaml` 的 `allowBuilds` 里加 `frida: true`）后重装、重启。
- 工具数量和期望不一致：npm 版 `rea-agents` 的目录是 229 个工具（`doctor` 里的 `mcp_tools`）；用自己仓库完整构建出来的副本可能更多。插件只负责挂载，工具集由 REA 决定。
- Windows 上 REA 报缺少原生模块：`rea-agents` 的发行包已带 Windows 原生件；若被裁剪，按 REA 文档重建 `native/windows`。

## 卸载

```sh
dsh plugin --profile web remove dsh-rea-pro
```

## 许可

MIT
