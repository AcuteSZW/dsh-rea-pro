# 发版指引（dsh-rea-pro）

这份文档记录的是**这台机器上已经跑通一遍的完整流程**，以后改完插件按顺序照做即可。命令里出现的路径都是实际路径，别照抄到别的机器上。

- 插件仓库：`E:\ai-agent\deepseek-harness-tools\rea\dsh-rea-plugin`（它自己就是一个 git 仓库，origin = `https://github.com/AcuteSZW/dsh-rea-pro.git`）
- npm 包：`dsh-rea-pro`（账号 `lucas-song`，2FA 已开，模式 `auth-and-writes`；发布凭据见第四节：**用 Bypass-2FA 的 Granular Access Token**，浏览器登录留下的 token 会很快过期）
- 本机 DSH profile：`C:\Users\songzhiwei\.dsh\profiles\web`
- 市场目录条目：仓库里的 `market/AcuteSZW__dsh-rea-pro.yml`（**已收录**，见第六节）

---

## 三种更新，先分清

| 你改了什么 | 走哪几步 | 市场条目 |
|---|---|---|
| 插件代码 / 行为（修 bug、加能力、改默认值） | 一 → 二 → 三 → 四 → 五 | **不用动**。条目指向仓库，站点自己去 npm 抓新版本号 |
| 描述 / 分类 / 仓库地址 | 先按上一行走完发布，再走第六节「收录之后改条目」 | 提 PR 改那个 yml |
| 发错版本，要止损 | 第七节 | 不用动 |

一句话：**日常发版只有一条路——升版本、push、publish、装回 profile 重启。**市场只在文案变了才碰。

---

## 一、改完代码后的自检（发布前必做）

1. 确认包内容没跑偏：

   ```
   cd /d E:\ai-agent\deepseek-harness-tools\rea\dsh-rea-plugin
   npm pack --dry-run
   ```

   期望 9 个文件：`LICENSE / README.md / client.js / cordis.patch.yml / icon.svg / index.js / locale/en.json / locale/zh.json / package.json`。
   `market/` 不在 `files` 里，不会进包；`LICENSE` 是 npm 自动带的。

2. 确认没有本机路径混进包：`index.js`、`client.js`、`cordis.patch.yml` 里不许出现 `E:\`、`C:\` 这类绝对路径。所有机器相关的东西（REA 脚本位置、工作目录、node 解释器）都必须在运行时解析。

3. 本地跑起来看开关：

   重启 DSH 后访问状态接口，确认 `state: connected`、`toolCount` 是预期值；再点一次 chip 关掉、再开一次，两轮都要成功。**关→开是重点**：`closeTimeoutMs: 20000` 就是为它设的，改小会重现"关一次就永久卡死"。

---

## 二、升版本号

```cmd
cd /d E:\ai-agent\deepseek-harness-tools\rea\dsh-rea-plugin
npm version patch    :: 修 bug 用 patch，新能力用 minor，破坏性改动用 major
```

`npm version` 会改 `package.json` 并打一个本地 tag（`v1.0.1`）。如果 tag 没自动打，手动补：

```cmd
git tag v1.0.1
```

---

## 三、提交并推送（这台机器的 git 有四个前提）

```cmd
cd /d E:\ai-agent\deepseek-harness-tools\rea\dsh-rea-plugin
git add -A
git -c user.name="AcuteSZW" -c user.email="53159377+AcuteSZW@users.noreply.github.com" commit -m "1.0.1: 一句话说明这次改了什么"
git push
git push origin v1.0.1
```

四个前提（都是这台机器实际撞过的）：

1. **全局 git 身份没配**，提交必须带 `-c user.name` / `-c user.email`。
2. **仓库报 dubious ownership**，任何 git 命令都可能需要 `-c safe.directory=<仓库绝对路径>`。
3. **到 github.com 的连接时通时断**，报 `Could not connect` 或 `Connection was reset` 就等一会儿重试，提交已在本地不会丢。
4. 外层 REA 检出（`...\rea`）已把 `dsh-rea-plugin/` 写进 `.git/info/exclude`，不要在那边误提交。

补充两条：

- **git 可能突然从 PATH 消失**（这台机器发生过一次，`Get-Command git` 无结果）。临时用 GitHub Desktop 自带的：
  `C:\Users\songzhiwei\AppData\Local\GitHubDesktop\app-3.6.11\resources\app\git\cmd\git.exe`（2.56.1）。版本号目录变了就在 `...\GitHubDesktop\` 下找最新的 `app-*\resources\app\git\cmd\git.exe`。
- **443 全断时不要硬撑**：`git push` 连续失败就别反复重试，等网络恢复再推；本地提交不会丢。真需要当场落远端，只能走 GitHub 网页/API 手改，属于应急手段，事后必须 `git fetch` + `git reset --hard origin/main` 对齐（发生过一次：本地 `3f0c913` 与远端 `3bbad01f` 内容相同、哈希不同，已对齐）。

---

## 四、发到 npm（这一步只能你本人在 cmd 窗口跑）

```cmd
cd /d E:\ai-agent\deepseek-harness-tools\rea\dsh-rea-plugin
npm publish --registry=https://registry.npmjs.org
```

要点：

- **`--registry=https://registry.npmjs.org` 不能省**。这台机器的默认源是 npmmirror，省了会发到镜像站，官方源上永远看不到。
- **凭据：用 Granular Access Token，不要依赖浏览器登录留下的 token。** 这条是 2026-11-12 实际踩出来的：前一天用 `npm login --auth-type=web` 登录过、也发布成功过，第二天再发就是

  ```
  npm error code E404
  npm error 404 Not Found - PUT https://registry.npmjs.org/dsh-rea-pro - Not found
  ```

  看起来像"包不存在"，其实是**认证失败被伪装成 404**（npm 对已存在的包做 PUT 时，没权限一律回 404 而不是 401/403，避免泄露包是否存在）。真相在 `.npmrc` 那条 token 上——拿它请求 `GET https://registry.npmjs.org/-/whoami` 会直接 401，说明登录产生的会话 token 已经过期，隔一夜就废。

  **判断口诀**：PUT 报 404 而不是 403 → 先怀疑 token 过期，别怀疑包名或权限设置。

  **正确做法（一次性配好，以后发布只敲一条命令）**：

  1. 打开 https://www.npmjs.com/settings/lucas-song/tokens → Generate New Token → **Granular Access Token**
  2. Packages：`All packages`（或只勾 `dsh-rea-pro`）；Permissions：`Read and write`
  3. **勾上 `Bypass 2FA`**（不勾的话每次发布仍要 OTP，会报 `E403 ... granular access token with bypass 2fa enabled is required`）
  4. 把 `.npmrc` 里这一行换成新 token（`npm_` 开头）：

     ```
     //registry.npmjs.org/:_authToken=npm_xxxxxxxx
     ```

  5. 验证凭据活着：

     ```cmd
     npm whoami --registry=https://registry.npmjs.org
     ```

     返回 `lucas-song` 才算好；401 就是 token 又不行了。

  临时应急（只发这一次、不想配 token）才用浏览器流程：发布会打印

  ```
  Authenticate your account at:
  https://www.npmjs.com/auth/cli/<一段 id>
  Press ENTER to open in the browser...
  ```

  按回车在浏览器确认即可，**不要用 `--otp=` 手输验证码**。但这条路径拿到的 token 很快过期，别指望它明天还能用。
- 发布成功的输出是 `+ dsh-rea-pro@<版本>` 加上一句 "Your package is being processed…"。
- 注意：助手执行环境里的 npm 配置被指到了沙箱内的另一份（`NPM_CONFIG_USERCONFIG`），不带 `--userconfig=C:\Users\songzhiwei\.npmrc` 跑会报 `ENEEDAUTH`。**发布优先在你自己的 cmd 里做**；只有在 `.npmrc` 里放了有效的 Bypass-2FA token 之后，助手才代得动这一步。
- 发布后 registry 有 CDN 延迟：`dist-tags` 可能还指着旧版本、`versions` 里也还没有新号，此时直接查 `https://registry.npmjs.org/dsh-rea-pro/<版本号>` 这个端点，能拿到就说明已经上架（再等一两分钟 `latest` 才会跟着翻）。

### 发布后必须验证（别信输出，看 registry）

```cmd
npm view dsh-rea-pro version --registry=https://registry.npmjs.org
```

- 刚发完的一两分钟内，`https://registry.npmjs.org/dsh-rea-pro` 里**只有 `0.0.0-stage`**（描述是 `Temporary package placeholder for staged publishing`）。这是 npm 给新版本建的占位，**不是失败**，等 1～2 分钟它会被真实版本替换。
- 变成你发的新版本号就算成功。
- 顺手确认国内镜像也同步了：`npm view dsh-rea-pro version --registry=https://registry.npmmirror.com`。

---

## 五、装回自己的 profile 验证（"陌生人安装"这条路径）

```cmd
cd /d C:\Users\songzhiwei\.dsh\profiles\web
pnpm add dsh-rea-pro@1.0.2
```

**用 `pnpm add <包>@<版本>`，不要用 `pnpm install`。** 这条是 2026-11-12 撞出来的：`pnpm install` 只按 lockfile 补齐，**不会升级已装的旧版本**，还会把手动覆盖进去的文件回滚成旧版（当时手拷的 1.0.1 被回滚成 1.0.0，`sameOrigin` 又冒出来了）。`pnpm add` 才会真的换版本，同时把 `package.json` 的版本号改掉、往 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 追加一条。

可能出现两件事，都属于已知情况：

1. **`ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: frida`** —— REA 的依赖链里有 `frida` 的安装脚本被 pnpm 挡了。包其实已经装好、插件可用；要完整能力就在 `pnpm-workspace.yaml` 的 `allowBuilds:` 下加 `frida: true` 再装一次（本机已加过）。退出码为 1 时先看是不是这一条，别以为装失败了。
2. **`minimumReleaseAge` 拦截** —— profile 有"最小发布年龄"策略，刚发的包会被拦。pnpm 一般会自动往 `minimumReleaseAgeExclude` 加一条 `dsh-rea-pro@<版本>` 并继续装；如果它变成硬报错，就手动把该版本加进 exclude 列表。

装完核对磁盘上的确实是新代码（别信输出）：

```cmd
findstr /C:"requestRejection" "C:\Users\songzhiwei\.dsh\profiles\web\node_modules\dsh-rea-pro\index.js"
```

再重启 DSH（当前实例是 `pnpm dsh web --no-open`）：

```cmd
:: 先杀掉旧实例
powershell -c "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dsh web --no-open|apps/cli/src/bin.ts web|rea.mjs mcp' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
Start-Process "C:\Program Files\nodejs\node.exe" -ArgumentList @('"C:\Program Files\nodejs\node_modules\pnpm\bin\pnpm.mjs"','dsh','web','--no-open') -WorkingDirectory "E:\ai-agent\deepseek-harness"
```

新实例的访问 token 在启动日志里（`%TEMP%\dsh-web-*.out.log` 末尾那行 `dsh web: http://127.0.0.1:3080/?token=...`）。然后查状态：

```
http://127.0.0.1:3080/dsh-rea/status?token=<token>
```

期望：`pluginDir` 指向 `...\profiles\web\node_modules\dsh-rea-pro`，`server.status.state` 为 `connected`，chip 显示 `REA 开`。

**别同时保留 link 依赖**：profile 里若既有 `link:E:/...dsh-rea-plugin` 又装了同名 npm 包，会出现两份代码、两个 patch 同名，开关会切不动。

---

## 六、插件市场（awesome-dsh-plugin）

**现状（2026-11-13 起）：已收录。** PR #14788 已合并（merge commit `5fa8e3fc`，合并人 `fkysly`），条目落在上游 `data/plugins/AcuteSZW__dsh-rea-pro.yml`，站点索引已刷新：

- 列表数据：`https://awesome-dsh-plugin.com/plugins.json`
- 详情页：`https://awesome-dsh-plugin.com/p/AcuteSZW/dsh-rea-pro/`

条目里的 `npm` / `version` / `stars` / `downloads` 一开始是 `null`，站点的回填任务抓到 npm 后会自己填，**不用管，更不要为这个提 PR**。

### 什么时候需要更新市场条目

只有**描述、分类、仓库地址**变了才需要更新。日常升版本不动市场：条目指向仓库，站点自己去 npm 抓最新版本号。

### 收录之后改条目（日常只有这一种）

1. 在 fork `AcuteSZW/awesome-dsh-plugin` 上**先从上游最新 `main` 拉一条新分支**（名字写清目的，如 `update-dsh-rea-pro-desc`）。
2. 改 `data/plugins/AcuteSZW__dsh-rea-pro.yml` 里要改的那一两行（英文/中文各一句，句号结尾）。
3. 提 PR 到上游 `main`，**一个 PR 只改这一个文件**，PR 描述写清「改了什么、为什么改」。
4. 等 `check` 与 `Submission gate` 双绿。门禁自己会重跑，**失败不要关掉重开 PR**。

### 描述怎么写（维护者当面审过）

- 讲清**做什么**，再**披露默认行为**。上游 2026-11-12 的提交 `2e469a87` 原话是 "describe merged entries by what they do and disclose defaults"。本条目现在写明「装好即默认开启；关掉后工具撤走、MCP 子进程退出」。
- **不要写具体工具数量**。原文写明 `if a description claims "46 tools", someone counts them`，审核会真去数（发行版实测 229，不是 253）。

### 首次收录步骤（已完成，仅留档）

1. Fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`。
2. 在 fork 里新增 `data/plugins/AcuteSZW__dsh-rea-pro.yml`，内容同下。
3. 提 PR 到上游 `main`，只加这一个文件，不要手改 `README.md`（CI 生成）。
4. PR 描述里写清楚：`dsh.bundle` 已声明、npm 包已发布、自己实测过安装与开关。

### 别踩的坑（都是实际撞过的）

| 坑 | 后果 |
|---|---|
| 复用旧分支提 PR（上游已前进） | diff 不再是单文件新增，门禁直接挂（#14117 就是这样废掉的，最后只能换新分支重开 #14788） |
| 手改 `README.md` / `README.zh.md` | 那是 CI 生成的，会被覆盖 |
| 同一个文件同时挂两个 PR | 必须关掉一个，并在被关的 PR 里留言说明换到哪条 |
| 文件名不是 `.yml`、或不在 `data/plugins/` 下 | 被静默跳过，CI 不报错但也不收录 |
| 描述里写工具数量 | 审核去数，对不上要返工 |

### 当前条目内容（改之前先跟这个对齐）

仓库里的 `market/AcuteSZW__dsh-rea-pro.yml` 就是 PR 要提交的文件，四处应保持一致（插件仓库、fork 分支、上游 `main`）：

```yaml
url: https://github.com/AcuteSZW/dsh-rea-pro
name: AcuteSZW/dsh-rea-pro
category: tools
description:
  en: Mounts REA's reverse-engineering MCP toolset in DeepSeek Harness behind a composer chip; it is on by default once installed, and switching it off withdraws the tools and stops the MCP child process so idle sessions pay no context for them.
  zh: 把 REA 的逆向工程 MCP 工具集接进 DeepSeek Harness，输入框工具条上一个开关，装好即默认开启；关掉后工具全部撤走、MCP 子进程退出，不需要它的会话就不花这份上下文。
```

### 三个硬门槛（会卡住 PR）

| 门槛 | 说明 |
|---|---|
| `dsh.bundle` | `package.json` 里声明了 `dsh.bundle.patch`，PR 自动校验 |
| 仓库满 1 天 | `scripts/check-submission.mjs` 里 `MIN_AGE_DAYS = 1`。**新仓库第一次会失败，但它会自动重跑并自愈**，不要关掉重开 PR |
| `dsh-plugin` topic | 仓库 Settings → About ⚙ → Topics 输入 `dsh-plugin` → **按回车变成标签** → 保存。漏了回车等于没填 |

其他会被 CI 拦的：文件名必须以 `.yml` 结尾、必须放在 `data/plugins/` 下、fork 不能过旧（一个 PR 只该 +1/-0）。

---

## 七、出问题怎么撤

- 标记某个版本有问题（推荐，别硬删）：

  ```
  npm deprecate dsh-rea-pro@1.0.1 "this version breaks the composer chip, use 1.0.0"
  ```

- 24 小时内可以彻底删版本：

  ```
  npm unpublish dsh-rea-pro@1.0.1 --force --registry=https://registry.npmjs.org
  ```

  超过 24 小时，只有包维护者能联系 npm support 删；能做的只有 deprecate + 发一个修好的新版本。
- GitHub 侧回滚：`git revert <commit>` 后正常走第三、四步。

---

## 八、一页清单

发布一次新版本，按这个顺序打勾：

- [ ] `npm pack --dry-run` 是 9 个文件
- [ ] 包里没有本机绝对路径
- [ ] 本地重启后 `connected`，chip 关→开两轮都通过
- [ ] `npm version patch`（版本号 + tag）
- [ ] `git commit`（带 `-c user.name/-c user.email`）、`git push`、`git push origin v<版本>`
- [ ] `npm whoami --registry=https://registry.npmjs.org` 返回 `lucas-song`（401 就先配 Bypass-2FA token，见第四节）
- [ ] `npm publish --registry=https://registry.npmjs.org`（PUT 报 404 而 whoami 401 → token 过期，不是包没了）
- [ ] `npm view dsh-rea-pro version` 返回新版本（先看到 `0.0.0-stage` 是正常的，等两分钟）
- [ ] profile 里 `pnpm add dsh-rea-pro@<新版本>`（不是 `pnpm install`；遇到 frida / 最小发布年龄按第五节处理）、重启、状态 `connected`
- [ ] 仓库仍带 `dsh-plugin` topic（偶尔复查一下）
- [ ] 只有描述/分类/地址变了才动市场 PR；改条目时从上游最新 `main` 拉新分支，一个 PR 只改那一个 yml
