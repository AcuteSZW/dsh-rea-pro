# dsh-rea-pro

REA 的逆向工具集接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）的插件，并在输入框工具条上提供一个开关。新装默认关闭；需要时点一下开启，关掉后 REA 的工具立刻离开上下文。

版本 1.0.5 起改成「常驻预热」：插件加载时就在后台起一个 REA 的 HTTP MCP 服务并把工具目录读热，点开只是把它注册给 DSH，实测 **0.4 秒**就能 `connected`（旧版每次现拉 stdio 子进程要 40 秒左右）。关掉只注销注册、子进程留一个空闲窗口再退；再点开要重新注册 255 个工具，这一段 0.4–9 秒不等，耗时在 DSH 的注册层。

English: mounts [REA](https://github.com/morluto/rea)'s MCP server in DeepSeek Harness and adds a composer chip to switch it on for the sessions that need it; it starts off after install. Since 1.0.5 the server is kept warm in a resident `rea mcp --http` process, so switching on connects in well under a second.

## 安装（装 npm 上的最新版）

插件已发布在 npm（[dsh-rea-pro](https://www.npmjs.com/package/dsh-rea-pro)），直接装到 DSH 的 `web` profile，不需要 `dsh` 命令、也不用先切目录（`--dir` 指定目标，`--registry` 钉住官方源避免镜像落后装到旧版）。

Windows：

```sh
pnpm --dir C:\Users\<用户名>\.dsh\profiles\web add dsh-rea-pro@latest --registry=https://registry.npmjs.org
```

macOS / Linux：

```sh
pnpm --dir ~/.dsh/profiles/web add dsh-rea-pro@latest --registry=https://registry.npmjs.org
```

装完重启 Harness 一次，输入框工具条上出现 `● REA 关`（新装默认关）。也可以在产品界面里装：**插件 → 安装**，来源填包名 `dsh-rea-pro`。

### 升级到最新版

同一个包已经装过时，`@latest` **不会**把它顶上去：manifest 里写的是 `^1.0.3` 这类范围，pnpm 判定“已满足”，只重算依赖树，版本原地不动（实测：`add dsh-rea-pro@latest` 与 `update --latest` 都停在 `1.0.3`）。要真升级，写明确版本号：

```sh
pnpm --dir C:\Users\<用户名>\.dsh\profiles\web add dsh-rea-pro@1.0.5 --registry=https://registry.npmjs.org
```

或者一条命令先取官方源的最新版本号再装（cmd，写进 .bat 时把 `%v` 改成 `%%v`）：

```bat
for /f %v in ('npm view dsh-rea-pro version --registry=https://registry.npmjs.org') do pnpm --dir C:\Users\<用户名>\.dsh\profiles\web add dsh-rea-pro@%v --registry=https://registry.npmjs.org
```

> 升级后如果 chip 消失、`/dsh-rea/status` 变成 404，说明插件在 profile 的 `dsh.profile.bundles` 里没有登记激活项（裸 `pnpm add` 只改依赖，不动激活列表）。用 `dsh plugin --profile web remove dsh-rea-pro` 再 `add` 一次即可重新登记，然后重启 Harness。

### 核对装到的是哪一版

```sh
npm view dsh-rea-pro version --registry=https://registry.npmjs.org          # 官方源最新版
pnpm --dir C:\Users\<用户名>\.dsh\profiles\web list dsh-rea-pro --depth 0    # profile 里实际装的版本
```

两者一致即为最新版。也可以直接看 `~/.dsh/profiles/web/node_modules/dsh-rea-pro/package.json` 里的 `version`，或 `~/.dsh/profiles/web/node_modules/dsh-rea-pro/index.js` 里是否有 `primeSession` / `streamable-http`（1.0.5 起才有；1.0.4 是 `waitForReady` / `startWatcher` 的 stdio 版）。

### 兜底：直连 GitHub

npm 装不通时（网络或镜像问题），退回到仓库装，内容同最新 tag：

```sh
dsh plugin --profile web add github:AcuteSZW/dsh-rea-pro
```

## 它能做什么

- 在后台维护一个常驻的 REA MCP 服务（`rea mcp --http`），开关打开时把它注册给 DSH，工具随开关出现和消失。
- 在输入框工具条（`完全权限 / 专家 / PUA` 那一排）加一个 `REA 开 / REA 关` chip，点击即切换；挂载期间显示 `正在挂载 3s / 约 13s`。
- 开关状态保存在 `~/.dsh/rea-mcp-state.json`，重启后保持。

## 依赖

- DSH `>= 0.2.1`，且 profile 里挂了 `@deepseek-ai/dsh-web-app`（`mcp-manager` 由它提供）。
- [rea-agents](https://www.npmjs.com/package/rea-agents) `^6.8.0`：**第三方 npm 包**，作为本插件的依赖自动安装，不需要单独部署 REA 仓库。会话里那些工具就是它提供的（当前发行版 `6.9.0` 的目录是 255 个工具，`6.8.0` 是 229 个），插件只负责把它挂进 DSH。

插件不安装或升级 Node、npm、分析引擎；REA 自己的 provider（Ghidra / IDA / JADX / Kuna 等）按 REA 文档配置，插件不代劳。

## 开关与常驻进程

chip 只有两个状态：`REA 开`、`REA 关`；挂载过程中显示 `正在挂载 <已用>s / 约 <预计>s`，悬停显示当前阶段（启动服务进程 / 载入工具目录 / 注册 / 连接）。

为什么快：REA 的工具目录是**按需**建的，第一个会话要 3 秒左右才吐出 255 个工具，之后同进程内只要 0.3 秒。所以插件在 activate 时（不论开关是开是关）就起一个 `rea mcp --http --port 0` 常驻进程，等它监听后先用一个一次性会话把目录读热，再让开关去注册。实测：

| 步骤 | 耗时 |
| --- | --- |
| 常驻进程拉起 → 开始监听 | ~5.5 s（后台，不挡界面） |
| 预热会话读满目录 | ~3.5 s（后台） |
| 点开 → `connected`（进程已预热，首次挂载） | **0.4 s** |
| 关掉 → 工具消失 | <20 ms |
| 关掉后再点开（重新注册 255 个工具） | 0.4–9 s，取决于 DSH 注册层的当时状态（见下） |
| 进程退出后再点开（冷启动） | ~7–9 s 加注册那一段 |

- **关掉**：只注销注册（工具立刻从上下文消失），进程留 `idleExitMs`（默认 60 秒）空闲再退出。进程不会重启，但再点开要重新把 255 个工具注册进 DSH；本机实测这一段是 0.4–9 秒：REA 侧握手 15–195 ms、列目录 84 ms（361 KB），耗时全在 DSH 逐条 `ctx.tools.register` 上，插件侧无法再压缩。
- **启动时开关是「开」**：插件自己预热并挂载，全程约 9 秒，chip 会显示进度。
- **子进程不在了**（被手动杀掉、崩溃）：插件注销该注册并把开关退回「关」，悬停提示写明退出码；再点一次会重新拉起。

关闭预算（`closeTimeoutMs`）从 60 秒降到 5 秒：现在关的是 HTTP 会话，不需要再等一个 stdio 子进程收尾，也就不会再落到「cleanup 未完成，必须重启 DSH」。

## 配置项

写在 `cordis.patch.yml` 的 `config` 下，都有默认值：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `serverName` | `rea` | 服务器名（工具名 `mcp__rea__*`），与其它 REA 插件冲突时改这里 |
| `agentsPath` | 自动 | 指定 `rea-agents` 的安装目录 |
| `nodePath` | 自动 | 指定跑 REA 的 node。默认自动挑（见下），REA 要的是 `^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1` |
| `tools` | `all` | `all` 服务完整目录（253–255 个工具）；`core` 只服务常用组（148 个：`direct / enhanced / native / artifact / managed / session`） |
| `toolFamilies` | 未设 | 直接点名要哪些 family（覆盖 `tools`），例如 `[direct, pcap]` |
| `outputSchemas` | `off` | 是否让 REA 广播每个工具的 `outputSchema`。`off` 是 REA 自己的默认；改 `compact` 会让 DSH 为每个工具编译一次 Ajv 校验，255 个实测多花约 35 秒 |
| `prewarm` | `true` | 关掉后不在 activate 时预热，第一次点开走冷启动 |
| `idleExitMs` | `60000` | 关闭后常驻进程的空闲存活时间 |
| `warmTimeoutMs` | `90000` | 等常驻进程监听的预算 |
| `startupTimeoutMs` | `30000` | 注册后等 DSH 连上 + 首次工具同步的预算 |
| `closeTimeoutMs` | `5000` | 注销时等的预算 |

工具白名单只能按 REA 的 tool family 切：REA 本身只支持 `REA_MCP_TOOL_FAMILIES` 这一级作用域，DSH 的 mcp-client 也没有 per-tool allowlist，所以没有单工具粒度的 include/exclude。

**为什么默认关 outputSchema**：DSH 在注册任何 MCP 工具前，会先用 Ajv 编译每个工具广播的 output schema。REA 全量 255 个工具的 output schema 有 4.6 MB，本机实测编译 34.7 秒——这就是过去「点开到连上 40 秒」里剩下的那一段（REA 自身启动只占十几秒）。关掉后目录从 4.6 MB 降到 361 KB，注册到 connected 约 0.5 秒。REA 服务端的结构化校验不受影响，只是 DSH 侧不再按 schema 校验返回值。

**用哪个 node**：DSH 宿主自己跑在哪个 node 不一定满足 REA 的要求（随包 runtime、发行版包、版本管理器都可能偏旧），所以插件不复用宿主进程的 node，而是按这个顺序挑第一个满足 REA `engines.node` 的：`nodePath` 配置 → `DSH_REA_NODE` 环境变量 → 宿主自身 → `PATH` 里的 node → 常见安装位置（Windows `%ProgramFiles%\nodejs\node.exe`，macOS/Linux `/usr/local/bin/node`、`/usr/bin/node`）。显式配了 `nodePath` 就不做版本校验。挑中的路径与版本在 `status` 的 `daemon.node` / `daemon.nodeVersion` 里能看到，宿主自己的版本是 `daemon.hostNodeVersion`。

**新装默认关**：状态文件不存在时按「关」处理，装完第一次启动不会把 REA 的工具挂进会话，需要你在 chip 上点一下。点过之后状态存进 `~/.dsh/rea-mcp-state.json`，重启后保持。

状态接口（仅本机已认证的 Harness 页面可用）：

- `GET /dsh-rea/status` → `{ ok, enabled, mounted, registered, stage, elapsedMs, expectedMs, tools, daemon, toolFamilies, outputSchemas, serverName, script, server?, error? }`，`stage` 取值 `off / warming / initializing / registering / connecting / connected / failed`，`server` 是 DSH 侧该服务器的实时状态（`state` 为 `connected` 时带 `toolCount`）；`elapsedMs` 在挂载过程中是本次尝试已用的时间，连上之后则是「注册到连上」的那一段（不含预热）
- `POST /dsh-rea/toggle`，body `{ "enabled": true|false }`，要求 `Content-Type: application/json`；立刻带着当前 `stage` 返回，挂载进度继续由 `status` 汇报（客户端每 700 ms 轮询一次），请求不会被预热或挂载拖住

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
- chip 显示 `正在挂载 …` 很久不动：看 `GET /dsh-rea/status` 的 `stage` 和 `daemon`。`warming` 卡住多半是常驻进程起不来（`daemon.running=false`、`error` 有原因）；`connecting` 卡住说明注册成功但 DSH 没连上。常见原因是 `rea-agents` 没装进 profile，或 REA 自身启动失败，用 REA 的 `doctor` 检查（`npx rea-agents doctor`）。
- 提示「找不到 REA 能用的 Node」，或 `error` 里带 `REA requires Node.js 22.x …`：DSH 宿主跑的那个 node 不在 REA 支持范围（`status` 的 `daemon.hostNodeVersion` 就是它）。装一个受支持的 Node，或把 `nodePath` 指过去；插件不会再拿宿主的 node 硬跑。
- chip 自动退回 `REA 关`、提示「REA 服务进程意外退出」：常驻进程崩了（退出码在提示里）。再点一次开关即可重新拉起；反复崩就先按上一条查 REA 自身。
- 想让常驻进程少占资源：`prewarm: false`（点开走冷启动 ~9 秒），或把 `idleExitMs` 调小。
- `pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 退出、提示 `Ignored build scripts: frida`：这是 pnpm 拦下了 REA 依赖里 frida 的安装脚本，包本身已经装好、插件可用。要让 frida 相关能力也完整，在 profile 目录跑 `pnpm approve-builds` 选中 frida（或在 `pnpm-workspace.yaml` 的 `allowBuilds` 里加 `frida: true`）后重装、重启。
- 工具数量和期望不一致：以 profile 里实际装的 `rea-agents` 版本为准，`doctor` 的 `mcp_tools` 会写清楚（`6.8.0` 是 229 个，`6.9.0` 是 255 个）；用自己仓库完整构建出来的副本可能更多。插件只负责挂载，工具集由 REA 决定；`tools: core` 时是 148 个（按 family 计）。
- Windows 上 REA 报缺少原生模块：`rea-agents` 的发行包已带 Windows 原生件；若被裁剪，按 REA 文档重建 `native/windows`。

## 卸载

```sh
dsh plugin --profile web remove dsh-rea-pro
```

## 许可

MIT
