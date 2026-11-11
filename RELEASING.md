# 发版指引（dsh-rea-pro）

这份文档记录的是**这台机器上已经跑通一遍的完整流程**，以后改完插件按顺序照做即可。命令里出现的路径都是实际路径，别照抄到别的机器上。

- 插件仓库：`E:\ai-agent\deepseek-harness-tools\rea\dsh-rea-plugin`（它自己就是一个 git 仓库，origin = `https://github.com/AcuteSZW/dsh-rea-pro.git`）
- npm 包：`dsh-rea-pro`（账号 `lucas-song`，2FA 已开，模式 `auth-and-writes`）
- 本机 DSH profile：`C:\Users\songzhiwei\.dsh\profiles\web`
- 市场目录条目：仓库里的 `market/AcuteSZW__dsh-rea-pro.yml`

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

---

## 四、发到 npm（这一步只能你本人在 cmd 窗口跑）

```cmd
cd /d E:\ai-agent\deepseek-harness-tools\rea\dsh-rea-plugin
npm publish --registry=https://registry.npmjs.org
```

要点：

- **`--registry=https://registry.npmjs.org` 不能省**。这台机器的默认源是 npmmirror，省了会发到镜像站，官方源上永远看不到。
- 账号开了 2FA（`auth-and-writes`），发布会提示：

  ```
  Authenticate your account at:
  https://www.npmjs.com/auth/cli/<一段 id>
  Press ENTER to open in the browser...
  ```

  按回车会打开浏览器，在已登录的账号下确认一次即可。**不要用 `--otp=` 手输验证码**，这种浏览器确认的流程更省事。
- 发布成功的输出是 `+ dsh-rea-pro@<版本>` 加上一句 "Your package is being processed…"。
- 注意：我的执行环境里 `NPM_CONFIG_USERCONFIG` 被指到了沙箱内的另一份配置，在那里跑 `npm publish` 会报 `ENEEDAUTH`。**发布永远在你自己的 cmd 里做**，不要让我代发。

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
pnpm install
```

可能出现两件事，都属于已知情况：

1. **`ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: frida`** —— REA 的依赖链里有 `frida` 的安装脚本被 pnpm 挡了。包其实已经装好、插件可用；要完整能力就在 `pnpm-workspace.yaml` 的 `allowBuilds:` 下加 `frida: true` 再装一次（本机已加过）。退出码为 1 时先看是不是这一条，别以为装失败了。
2. **`minimumReleaseAge` 拦截** —— profile 有"最小发布年龄"策略，刚发的包会被拦。pnpm 一般会自动往 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里加一条 `dsh-rea-pro@<版本>` 并继续装；如果它变成硬报错，就手动把该版本加进 exclude 列表。

装完重启 DSH（当前实例是 `pnpm dsh web --no-open`）：

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

### 什么时候需要更新市场条目

只有**描述、分类、仓库地址**变了才需要更新。日常升版本不用动市场，条目指向仓库，市场会自动显示最新版本。

### 编辑条目

改仓库里的 `market/AcuteSZW__dsh-rea-pro.yml`，它就是 PR 要提交的文件内容（单行英文/中文描述，句号结尾）：

```yaml
url: https://github.com/AcuteSZW/dsh-rea-pro
name: AcuteSZW/dsh-rea-pro
category: tools
description:
  en: 一句话英文描述，句号结尾。
  zh: 一句话中文描述，以句号结尾。
```

不要写具体工具数量（比如"229 个工具"）。那边原文写明 `if a description claims "46 tools", someone counts them`，审核会真的去数。

### 提交 PR

1. 打开 `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`，点 Fork。
2. 在 fork 仓库新增文件 `data/plugins/AcuteSZW__dsh-rea-pro.yml`，内容同上。
3. 提 PR 到上游 `main`。**只加这一个文件**，不要手改 `README.md`（那是 CI 生成的）。
4. PR 描述里写清楚：`dsh.bundle` 已声明、npm 包已发布、自己实测过安装与开关。

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
- [ ] 自己在 cmd 里 `npm publish --registry=https://registry.npmjs.org`，浏览器里确认一次 2FA
- [ ] `npm view dsh-rea-pro version` 返回新版本（先看到 `0.0.0-stage` 是正常的，等两分钟）
- [ ] profile 里 `pnpm install`（遇到 frida / 最小发布年龄按第五节处理）、重启、状态 `connected`
- [ ] 仓库仍带 `dsh-plugin` topic（偶尔复查一下）
- [ ] 只有描述/分类变了才动市场 PR
