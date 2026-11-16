/**
 * Host half: keeps a warm REA MCP server for this plugin's lifetime and
 * exposes a loopback switch for it.
 *
 * REA needs tens of seconds before its 255-tool catalog can be served (it
 * loads its providers first), and Harness itself then spends most of a minute
 * compiling the output contracts REA advertises. Forking that per toggle is
 * what made the switch feel broken, so the plugin now runs one resident
 * `rea mcp --http` process:
 *
 *   - at activation it starts that process, waits for its listener and primes
 *     one throwaway session, so the catalog is hot;
 *   - switching on registers a streamable-HTTP entry against that warm
 *     endpoint, which reaches `connected` in well under a second;
 *   - switching off only unregisters, so REA's tools leave the model's tool
 *     set at once and no child has to be torn down;
 *   - the process leaves once it has been idle after a close (60 s by default).
 *
 * Nothing here hardcodes a machine path. The server script and its working
 * directory are resolved from the installed `rea-agents` package, and the
 * interpreter is the Node that already runs Harness, so the same code works
 * on any machine and any install location.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join, basename, resolve as resolvePath } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEBUG_LOG = process.env.DSH_REA_DEBUG === '1' ? join(tmpdir(), 'dsh-rea-debug.log') : undefined
const debugLog = (...parts) => {
  if (DEBUG_LOG === undefined) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`)
  } catch { /* diagnostics only */ }
}

const SERVER_NAME = 'rea'
const PACKAGE = 'rea-agents'
const STATE_FILE = join(homedir(), '.dsh', 'rea-mcp-state.json')
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

const require = createRequire(import.meta.url)

/**
 * The REA tool families that make up the "core" tier: the tools a normal
 * binary-analysis session reaches for. Measured against rea-agents 6.9.0 they
 * cover 148 of the 253 served tools; the rest are stack-specific integrations
 * (frida, jadx, adb, pcap, browser, electron, ...).
 */
const CORE_FAMILIES = ['direct', 'enhanced', 'native', 'artifact', 'managed', 'session']

/** A directory is a REA package when it holds the manifest and the MCP launcher. */
const asServerRoot = (root) => {
  const script = join(root, 'scripts', 'rea.mjs')
  if (!existsSync(script)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (manifest?.name !== PACKAGE) return undefined
    // REA refuses to start on a Node it does not support; carry that range
    // along so the interpreter can be chosen before the process is spawned.
    const engines = typeof manifest?.engines?.node === 'string' ? manifest.engines.node : undefined
    return { script, root, engines }
  } catch {
    return undefined
  }
}

/**
 * Locate the REA package: its MCP script and the directory it expects to run in.
 * Order: explicit config, `REA_AGENTS_HOME`, the installed dependency, then a
 * checkout that contains this plugin (the usual development layout).
 */
function locateServer(config) {
  if (typeof config?.agentsPath === 'string' && config.agentsPath !== '') {
    const root = resolvePath(config.agentsPath)
    const found = asServerRoot(root)
    if (found !== undefined) return found
  }
  const fromEnv = typeof process.env.REA_AGENTS_HOME === 'string' ? process.env.REA_AGENTS_HOME.trim() : ''
  if (fromEnv !== '') {
    const found = asServerRoot(resolvePath(fromEnv))
    if (found !== undefined) return found
  }
  try {
    const script = require.resolve(`${PACKAGE}/scripts/rea.mjs`)
    // Go back through the package check so the engines range comes along; the
    // raw shape is only a last resort for a package that fails that check.
    return asServerRoot(dirname(dirname(script))) ?? { script, root: dirname(dirname(script)) }
  } catch { /* fall through */ }
  try {
    const manifest = require.resolve(`${PACKAGE}/package.json`)
    const found = asServerRoot(dirname(manifest))
    if (found !== undefined) return found
  } catch { /* fall through */ }
  return asServerRoot(dirname(PLUGIN_DIR))
}

const headerOf = (request, name) => {
  const value = request.headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

/** Lowercased media type without parameters, or '' when the header is absent. */
const mediaType = (request) => {
  const value = headerOf(request, 'content-type')
  return value.split(';')[0].trim().toLowerCase()
}

/** Nothing here needs more than this; a real toggle body is under 100 bytes. */
const MAX_BODY_BYTES = 2048

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

const readJson = (request, limit = MAX_BODY_BYTES) => new Promise((resolve) => {
  let text = ''
  let tooLarge = false
  request.on('data', (chunk) => {
    if (tooLarge) return
    text += chunk
    if (text.length > limit) {
      tooLarge = true
      text = ''
    }
  })
  request.on('end', () => {
    if (tooLarge) {
      resolve({ invalid: 'too large' })
      return
    }
    try {
      resolve(JSON.parse(text === '' ? '{}' : text))
    } catch {
      resolve({ invalid: 'not json' })
    }
  })
  request.on('error', () => resolve({ invalid: 'stream error' }))
})

/** Persisted switch state. No file yet means a fresh install: stay off until asked. */
async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    return typeof parsed?.enabled === 'boolean' ? parsed.enabled : false
  } catch {
    return false
  }
}

async function writeState(enabled) {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

const positiveOr = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)

const parseVersion = (text) => {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text))
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

const compareVersion = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b ? 1 : -1
  }
  return 0
}

/**
 * Does a Node version satisfy the `engines.node` range REA publishes
 * (`^22.23.4 || ^24.22.1 || >=26.12.1`)? Only the operators Node packages use
 * for this are handled; an unparsable range counts as satisfied so a stricter
 * spelling can never block a machine that would otherwise work.
 */
const satisfiesEngines = (version, range) => {
  const current = parseVersion(version)
  if (current === undefined) return false
  if (typeof range !== 'string' || range.trim() === '') return true
  return range.split('||').some((raw) => {
    const match = /^(>=|>|<=|<|~|\^)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim())
    if (match === null) return true
    const floor = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)]
    const order = compareVersion(current, floor)
    switch (match[1]) {
      case '>': return order > 0
      case '>=': return order >= 0
      case '<': return order < 0
      case '<=': return order <= 0
      // Caret and tilde differ only in where the upper bound sits.
      case '^': return order >= 0 && current[0] === floor[0]
      case '~': return order >= 0 && current[0] === floor[0] && current[1] === floor[1]
      default: return order === 0
    }
  })
}

/** Version a given node reports, or undefined when it cannot run at all. */
const nodeVersionOf = (execPath) => {
  try {
    const probe = spawnSync(execPath, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (probe.error !== undefined || probe.status !== 0) return undefined
    const text = String(probe.stdout ?? '').trim()
    return parseVersion(text) === undefined ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * Which REA tool families to serve. `tools: 'core'` narrows the catalog to
 * {@link CORE_FAMILIES}; `toolsFamilies` names the families explicitly; the
 * default (`all`) serves the complete catalog, letting an ambient
 * `REA_MCP_TOOL_FAMILIES` through untouched.
 */
const resolveToolFamilies = (config) => {
  const explicit = Array.isArray(config?.toolFamilies)
    ? config.toolFamilies.filter((value) => typeof value === 'string' && value !== '')
    : []
  if (explicit.length > 0) return explicit
  if (config?.tools === 'core') return [...CORE_FAMILIES]
  return undefined
}

/** Pick one JSON-RPC message out of a JSON body or an SSE stream. */
const parseRpcBody = (text, id) => {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    if (payload === '') continue
    try {
      const parsed = JSON.parse(payload)
      if (parsed?.id === id) return parsed
    } catch { /* another event */ }
  }
  return undefined
}

export function apply(ctx, config = {}) {
  const serverName = typeof config.serverName === 'string' && config.serverName !== '' ? config.serverName : SERVER_NAME
  const located = locateServer(config)

  // Budgets. Mounting, closing and stopping the process are deliberately
  // separate: a close no longer has to wait out a stdio child's own teardown
  // (the transport is HTTP and the child is ours), so the close budget can be
  // tight while the mount budget stays generous.
  const warmTimeoutMs = positiveOr(config.warmTimeoutMs, 90000)
  const primeTimeoutMs = positiveOr(config.primeTimeoutMs, 30000)
  const startupTimeoutMs = positiveOr(config.startupTimeoutMs, 30000)
  const closeTimeoutMs = positiveOr(config.closeTimeoutMs, 5000)
  const stopGraceMs = positiveOr(config.stopGraceMs, 5000)
  const idleExitMs = positiveOr(config.idleExitMs, 60000)
  const inlineWaitMs = positiveOr(config.inlineWaitMs, 4000)
  const prewarm = config.prewarm !== false
  const toolFamilies = resolveToolFamilies(config)
  // REA can advertise an outputSchema per tool. DSH compiles every advertised
  // output contract with Ajv before it registers anything, and REA's full set
  // is 4.6 MB: 255 compiles measured 35 s on this machine, which is most of the
  // old "40 seconds to mount". REA's own default is to omit them, so the
  // resident server keeps that default; `compact` is still available for callers
  // who want the contracts and can pay the compile.
  const outputSchemas = config.outputSchemas === 'compact' ? 'compact' : 'off'

  const expectedWarmMs = positiveOr(config.expectedWarmMs, 12000)
  const expectedPrimeMs = positiveOr(config.expectedPrimeMs, 4000)
  const expectedConnectMs = positiveOr(config.expectedConnectMs, 1500)

  let enabled = false
  let dispose = null
  let ready = false
  let interpreter
  let lastError = located === undefined ? `${PACKAGE} 未安装：请先安装 rea-agents（npm i rea-agents）` : ''

  /**
   * One resident server process. `ready` means it reported its listener and
   * (normally) finished priming, so a registration against it connects fast.
   */
  const daemon = {
    child: undefined,
    url: '',
    ready: false,
    primed: false,
    tools: undefined,
    spawnAt: 0,
    listenMs: undefined,
    stopping: false,
    trace: '',
    buffer: '',
  }

  // `stage` is the mount progress the chip renders; `attemptStartedAt` is when
  // the current enable sequence began, so `elapsedMs` can be shown against it.
  let stage = 'off'
  let attemptStartedAt = 0
  let attemptExpectedMs = 0
  let registerStartedAt = 0
  let lastMountMs = undefined
  let warming = undefined
  let enabling = undefined
  let idleTimer = undefined

  let managerRegister = () => {
    throw new Error('mcpManager 尚未就绪')
  }
  let managerStatus = () => undefined
  const connectedState = () => managerStatus()?.status?.state === 'connected'
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  const setStage = (next) => {
    stage = next
  }

  const expectedForEnable = () => {
    if (daemon.ready) return expectedConnectMs
    if (daemon.url !== '') return expectedPrimeMs + expectedConnectMs
    return expectedWarmMs + expectedConnectMs
  }

  const beginAttempt = () => {
    attemptStartedAt = Date.now()
    registerStartedAt = 0
    attemptExpectedMs = expectedForEnable()
  }

  /**
   * How long the registration step took. An attempt that had to warm first
   * spends most of its time there, and reporting that as the mount time would
   * overstate what the switch costs; the connect handshake is what we want.
   */
  const sinceRegister = () => Date.now() - (registerStartedAt === 0 ? attemptStartedAt : registerStartedAt)

  /** Tool families are read once at spawn time, so a change needs a fresh process. */
  const daemonEnv = () => {
    const env = { ...process.env }
    if (toolFamilies !== undefined) env.REA_MCP_TOOL_FAMILIES = toolFamilies.join(',')
    env.REA_MCP_OUTPUT_SCHEMA_PROFILE = outputSchemas
    return env
  }

  /**
   * Harness does not always run on a Node REA accepts: a bundled runtime, a
   * distro build or a version manager can all be older than REA's engines
   * range, and `process.execPath` would then hand over exactly that binary.
   * So the resident server's interpreter is resolved explicitly.
   */
  const interpreterCandidates = () => {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const list = []
    const push = (value) => {
      if (typeof value === 'string' && value !== '' && !list.includes(value)) list.push(value)
    }
    if (typeof config.nodePath === 'string' && config.nodePath !== '') push(resolvePath(config.nodePath))
    push(process.env.DSH_REA_NODE)
    push(process.execPath)
    for (const dir of String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
      if (dir !== '') push(join(dir, exe))
    }
    if (process.platform === 'win32') {
      for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
        const root = process.env[key]
        if (typeof root === 'string' && root !== '') push(join(root, 'nodejs', exe))
      }
    } else {
      push('/usr/local/bin/node')
      push('/usr/bin/node')
    }
    return list
  }

  const resolveInterpreter = () => {
    if (interpreter !== undefined) return interpreter
    const preferred = typeof config.nodePath === 'string' && config.nodePath !== '' ? resolvePath(config.nodePath) : ''
    for (const candidate of interpreterCandidates()) {
      if (!existsSync(candidate)) continue
      const version = nodeVersionOf(candidate)
      if (version === undefined) continue
      // An explicitly configured interpreter is taken at its word; every other
      // candidate has to satisfy REA's own engines range.
      if (candidate !== preferred && !satisfiesEngines(version, located?.engines)) {
        debugLog('skip node', candidate, version, located?.engines)
        continue
      }
      interpreter = { path: candidate, version }
      debugLog('interpreter', JSON.stringify(interpreter))
      return interpreter
    }
    const hostVersion = process.versions.node
    lastError = `找不到 REA 能用的 Node：REA 需要 ${located?.engines ?? '受支持的版本'}，而 DSH 跑在 ${hostVersion}。装一个受支持的 Node（或在插件配置里用 nodePath 指定）后重试`
    debugLog('no interpreter', hostVersion, located?.engines)
    return undefined
  }

  const noteDaemonLine = (line) => {
    const text = line.trim()
    if (text === '') return
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.url === 'string' && daemon.url === '') {
        daemon.url = parsed.url
        daemon.listenMs = Date.now() - daemon.spawnAt
        debugLog('daemon listening', parsed.url, `${daemon.listenMs}ms`)
        return
      }
      if (typeof parsed?.level === 'number' && parsed.level >= 50) {
        daemon.trace = String(parsed?.msg ?? parsed?.error ?? text)
      }
      return
    } catch { /* not a log line */ }
    daemon.trace = text.slice(0, 400)
  }

  const startDaemon = () => {
    if (daemon.child !== undefined || located === undefined || !ready) return
    const node = resolveInterpreter()
    if (node === undefined) return
    daemon.url = ''
    daemon.ready = false
    daemon.primed = false
    daemon.tools = undefined
    daemon.listenMs = undefined
    daemon.stopping = false
    daemon.buffer = ''
    daemon.spawnAt = Date.now()
    debugLog('daemon spawn', JSON.stringify({ exec: node.path, node: node.version, engines: located.engines, script: located.script, cwd: located.root, families: toolFamilies, outputSchemas }))
    const child = spawn(node.path, [located.script, 'mcp', '--http', '--port', '0'], {
      cwd: located.root,
      env: daemonEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    daemon.child = child
    const scan = (chunk) => {
      daemon.buffer += String(chunk)
      const lines = daemon.buffer.split('\n')
      daemon.buffer = lines.pop() ?? ''
      for (const line of lines) noteDaemonLine(line)
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.on('error', (error) => {
      lastError = `REA 服务进程启动失败：${error.message}`
      debugLog('daemon error', error.message)
    })
    child.on('exit', (code, signal) => {
      if (daemon.child !== child) return
      daemon.child = undefined
      daemon.url = ''
      daemon.ready = false
      daemon.primed = false
      debugLog('daemon exit', JSON.stringify({ code, signal, stopping: daemon.stopping }))
      if (daemon.stopping) return
      // The server went away without being asked. Say why: a refused start
      // (unsupported Node, missing native module) only ever surfaces here.
      const reason = `REA 服务进程退出（code ${code ?? signal}）${daemon.trace === '' ? '' : `：${daemon.trace}`}`
      if (dispose !== null) {
        // The tools it backs are dead, so withdraw instead of leaving a mute
        // mount behind.
        lastError = reason
        withdraw()
        return
      }
      if (daemon.trace !== '') lastError = reason
    })
  }

  const waitForListen = (budgetMs) => new Promise((resolve, reject) => {
    const until = Date.now() + budgetMs
    const tick = () => {
      if (daemon.url !== '') return resolve(daemon.url)
      if (daemon.child === undefined) return reject(new Error(lastError !== '' ? lastError : 'REA 服务进程已退出'))
      if (Date.now() > until) {
        return reject(new Error(`REA 服务进程 ${Math.round(budgetMs / 1000)} 秒内没有开始监听${daemon.trace === '' ? '' : `：${daemon.trace}`}`))
      }
      setTimeout(tick, 100)
    }
    tick()
  })

  /**
   * Open one throwaway MCP session against the listener and read its whole
   * tool list. REA builds that catalog lazily on the first session (~3 s) and
   * reuses it afterwards (~0.3 s), so paying for it here is what makes the
   * switch itself instant. Nothing registers; the session is closed again.
   */
  const primeSession = async (url) => {
    const versions = ['2025-11-25', '2025-06-18']
    let session
    let tools
    let negotiated
    let refusal = ''
    for (const version of versions) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'dsh-rea-pro', version: 'warmup' } },
        }),
        signal: AbortSignal.timeout(primeTimeoutMs),
      })
      const body = parseRpcBody(await response.text(), 1)
      if (response.ok && body?.result !== undefined) {
        session = response.headers.get('mcp-session-id') ?? undefined
        negotiated = body.result.protocolVersion
        break
      }
      refusal = `HTTP ${response.status} ${body?.error?.message ?? ''}`.trim()
    }
    if (session === undefined) throw new Error(`预热会话握手失败（${refusal === '' ? '没有响应' : refusal}）`)
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(primeTimeoutMs),
      })
      tools = 0
      let cursor
      for (let page = 0; page < 16; page += 1) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: cursor === undefined ? {} : { cursor },
          }),
          signal: AbortSignal.timeout(primeTimeoutMs),
        })
        const body = parseRpcBody(await response.text(), 2)
        tools += body?.result?.tools?.length ?? 0
        cursor = body?.result?.nextCursor ?? undefined
        if (cursor === undefined) break
      }
      return { tools, negotiated }
    } finally {
      try {
        await fetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': session },
          signal: AbortSignal.timeout(5000),
        })
      } catch { /* the session is throwaway */ }
    }
  }

  /** Start the resident server and make it comfortable to connect to. */
  const warmDaemon = () => {
    if (daemon.ready) return Promise.resolve(true)
    if (warming !== undefined) return warming
    warming = (async () => {
      try {
        startDaemon()
        if (daemon.url === '') {
          setStage('warming')
          await waitForListen(Math.max(warmTimeoutMs - (Date.now() - daemon.spawnAt), 5000))
        }
        setStage('initializing')
        try {
          const primed = await primeSession(daemon.url)
          daemon.tools = primed.tools
          daemon.primed = true
          debugLog('primed', JSON.stringify(primed), `${Date.now() - daemon.spawnAt}ms`)
        } catch (error) {
          // A cold catalog only costs the first mount some seconds; the
          // listener itself is usable, so keep the warm process.
          daemon.primed = false
          debugLog('prime failed', String(error?.message ?? error))
        }
        daemon.ready = true
        return true
      } catch (error) {
        lastError = friendly(error)
        return false
      } finally {
        warming = undefined
      }
    })()
    return warming
  }

  const stopDaemon = async () => {
    const child = daemon.child
    if (child === undefined) return
    daemon.stopping = true
    daemon.ready = false
    daemon.primed = false
    daemon.url = ''
    daemon.child = undefined
    debugLog('daemon stop')
    // Ask first, force only if asking was ignored: REA closes its provider
    // owners on a termination request where the platform delivers one.
    try {
      child.kill('SIGTERM')
    } catch { /* already gone */ }
    const exited = new Promise((resolve) => {
      if (child.exitCode !== undefined || child.signalCode !== undefined) return resolve(true)
      child.once('exit', () => resolve(true))
    })
    const forced = await Promise.race([
      exited.then(() => true),
      sleep(stopGraceMs).then(() => false),
    ])
    if (!forced) {
      try {
        child.kill('SIGKILL')
      } catch { /* already gone */ }
      await Promise.race([exited, sleep(2000)])
    }
    daemon.stopping = false
  }

  const cancelIdleExit = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }

  /** After a close the process stays for one idle window, then leaves. */
  const scheduleIdleExit = () => {
    cancelIdleExit()
    if (daemon.child === undefined) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (dispose !== null || enabled) return
      void stopDaemon().catch(() => {})
    }, idleExitMs)
    idleTimer.unref?.()
  }

  const mount = () => {
    if (dispose !== null || located === undefined) return
    if (!ready) throw new Error('mcpManager 尚未就绪')
    if (daemon.url === '') throw new Error('REA 服务进程尚未监听')
    debugLog('register', JSON.stringify({ url: daemon.url }))
    registerStartedAt = Date.now()
    dispose = managerRegister({
      transport: 'streamable-http',
      url: daemon.url,
      startupTimeoutMs,
      toolCallTimeoutMs: 120000,
      // Closing an HTTP session is the whole teardown: no child of the
      // manager's own has to be reaped, so this budget stays tight.
      closeTimeoutMs,
      reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 10 },
    })
    debugLog('registered', typeof dispose)
  }

  const unmount = () => {
    if (dispose === null) return
    try {
      dispose()
    } finally {
      dispose = null
    }
  }

  /** The mount is gone and the switch is off; remember it and arm the idle exit. */
  const withdraw = () => {
    stopWatcher()
    unmount()
    enabled = false
    stage = 'off'
    void writeState(false).catch(() => {})
    scheduleIdleExit()
  }

  let watcher
  const stopWatcher = () => {
    if (watcher !== undefined) clearInterval(watcher)
    watcher = undefined
  }

  /**
   * Watch a mounted registration for two outcomes only: `connected` (the tools
   * are really attached) and `failed` (the manager gave up, so the row cannot
   * be remounted in this Host process).
   */
  const startWatcher = () => {
    stopWatcher()
    let lastLogged = ''
    watcher = setInterval(() => {
      if (dispose === null) {
        stopWatcher()
        return
      }
      const entry = managerStatus()
      const state = entry?.status?.state
      const signature = `${state}/${entry?.status?.attempt ?? ''}/${entry?.status?.reason ?? ''}`
      if (signature !== lastLogged) {
        lastLogged = signature
        debugLog('manager status', JSON.stringify({ state, attempt: entry?.status?.attempt, reason: entry?.status?.reason, error: entry?.status?.lastError }))
      }
      if (state === 'connected') {
        lastError = ''
        if (stage !== 'connected') {
          stage = 'connected'
          lastMountMs = attemptStartedAt === 0 ? undefined : sinceRegister()
        }
        return
      }
      if (state !== 'failed') return
      const message = explain(entry.status)
      stopWatcher()
      lastError = message
      unmount()
      enabled = false
      stage = 'failed'
      void writeState(false).catch(() => {})
      scheduleIdleExit()
    }, 1000)
    watcher.unref?.()
  }

  /**
   * A manager record whose cleanup never settled cannot be remounted in this
   * Host process; say that plainly instead of letting the chip pretend.
   */
  const explain = (status, fallback) => {
    const reason = status?.reason
    const detail = status?.result?.cleanupError ?? status?.lastError ?? fallback
    if (reason === 'cleanup') return `这次关闭没有清理干净（${detail}）；重启 DSH 后可以再次挂载`
    if (reason === 'load') return `REA 启动失败：${detail}`
    return String(detail ?? 'REA 没有进入已连接状态')
  }

  const friendly = (error) => {
    const message = String(error?.message ?? error)
    if (message.includes('is incomplete; restart the Host')) {
      return '上一次关闭没有清理干净，管理器拒绝再次挂载；重启 DSH 后点开即可'
    }
    if (message.includes('already configured or registered')) {
      return '服务器名 "rea" 已被占用：检查 profile 里是否有另一条 rea-mcp 配置'
    }
    return message
  }

  const awaitConnected = async (budgetMs) => {
    const until = Date.now() + budgetMs
    while (Date.now() < until) {
      if (connectedState()) return true
      await sleep(100)
    }
    return connectedState()
  }

  /**
   * Switch on: reuse the warm process, register against it, and report as soon
   * as the manager says `connected` (a fraction of a second on a warm daemon).
   */
  const enable = () => {
    if (enabling !== undefined) return enabling
    enabling = (async () => {
      try {
        if (located === undefined) throw new Error(lastError !== '' ? lastError : `${PACKAGE} 未安装`)
        if (!await waitForReady(READY_BUDGET_MS)) throw new Error('mcpManager 尚未就绪，稍后重试')
        cancelIdleExit()
        beginAttempt()
        enabled = true
        await writeState(true)
        if (dispose === null) {
          if (!await warmDaemon()) throw new Error(lastError !== '' ? lastError : 'REA 服务进程未能就绪')
          // Nothing left but the handshake, so the expectation shrinks now.
          attemptExpectedMs = Math.round(Date.now() - attemptStartedAt) + expectedConnectMs
          setStage('registering')
          mount()
        }
        setStage('connecting')
        if (await awaitConnected(inlineWaitMs)) {
          stage = 'connected'
          lastMountMs = sinceRegister()
          lastError = ''
        } else {
          lastError = ''
        }
        startWatcher()
        return stage === 'connected'
      } catch (error) {
        lastError = friendly(error)
        stopWatcher()
        try {
          unmount()
        } catch { /* keep the reported failure */ }
        enabled = false
        stage = 'failed'
        await writeState(false).catch(() => {})
        return false
      } finally {
        enabling = undefined
      }
    })()
    return enabling
  }

  /** Switch off: drop the registration first, then let the process idle out. */
  const disable = async () => {
    // Let a mount that is still in flight settle, so a quick off/on pair cannot
    // leave the registration racing its own teardown.
    if (enabling !== undefined) {
      try {
        await enabling
      } catch { /* the failure is reported by the mount itself */ }
    }
    stopWatcher()
    cancelIdleExit()
    unmount()
    enabled = false
    lastError = ''
    stage = 'off'
    await writeState(false)
    scheduleIdleExit()
  }

  /** The manager's service is only reachable inside an inject frame. */
  const READY_BUDGET_MS = 10000
  const waitForReady = async (budgetMs) => {
    const until = Date.now() + budgetMs
    while (!ready && Date.now() < until) await sleep(200)
    return ready
  }

  ctx.inject(['mcpManager'], (scope) => {
    managerRegister = (entry) => scope.mcpManager.register(serverName, entry)
    managerStatus = () => {
      try {
        return scope.mcpManager.list().find((item) => item.name === serverName)
      } catch {
        return undefined
      }
    }
    ready = true
    void readState().then(async (on) => {
      if (!on) {
        // Off at start: still build the warm process, so the first click is
        // instant. Nothing registers, so no tool enters any request.
        if (prewarm) {
          beginAttempt()
          await warmDaemon()
          if (stage !== 'off') stage = 'off'
        }
        return
      }
      enabled = true
      beginAttempt()
      await enable()
    })
  })

  // Plugin unload withdraws the server and takes the resident process with it,
  // so its tools leave the context and no orphan keeps a listener open.
  ctx.effect(() => () => {
    stopWatcher()
    cancelIdleExit()
    unmount()
    void stopDaemon().catch(() => {})
  })

  // Admission is the WebServer's own job: a route registered without `auth`
  // defaults to 'required', and the authentication provider answers through the
  // `webserver/authorize` waterfall — the Host/Origin fence plus this session's
  // browser cookie. A cross-site page therefore cannot reach either route, and
  // the plugin has no auth code of its own to drift out of date.
  ctx.inject(['webServer'], (scope) => {
    const snapshot = () => {
      const mounted = dispose !== null && connectedState()
      const server = managerStatus()
      // The manager's own word wins over our bookkeeping: a registration that
      // already reports `connected` is reported as connected even if the mount
      // flow has not stored that stage yet.
      const reported = mounted && !['off', 'failed', 'connected'].includes(stage) ? 'connected' : stage
      const settled = reported === 'off' || reported === 'failed'
      const elapsed = reported === 'connected'
        ? (lastMountMs ?? 0)
        : (settled || attemptStartedAt === 0 ? 0 : Date.now() - attemptStartedAt)
      return {
        ok: true,
        enabled,
        // `mounted` means the tools are really attached: registered but still
        // connecting (or failed) is not a mounted server.
        mounted,
        registered: dispose !== null,
        // Progress the chip renders: which step the mount is on and how long
        // it has been there, against the expected total for this attempt.
        stage: reported,
        elapsedMs: Math.max(0, Math.round(elapsed)),
        expectedMs: Math.round(settled
          ? 0
          : (reported === 'connected' ? (lastMountMs ?? expectedConnectMs) : attemptExpectedMs)),
        tools: server?.status?.state === 'connected' ? server.status.toolCount : daemon.tools,
        serverName,
        script: basename(located.script),
        transport: 'streamable-http',
        daemon: {
          running: daemon.child !== undefined,
          ready: daemon.ready,
          primed: daemon.primed,
          pid: daemon.child?.pid,
          url: daemon.url === '' ? undefined : daemon.url,
          listenMs: daemon.listenMs,
          idleExitMs: idleExitMs,
          // Which Node the resident server runs on: Harness itself may sit on
          // an older one, so this is the field to check when a start is refused.
          node: interpreter?.path,
          nodeVersion: interpreter?.version,
          hostNodeVersion: process.versions.node,
        },
        toolFamilies: toolFamilies ?? 'all',
        outputSchemas,
        server,
        diagnostics: { cwd: process.cwd(), pluginDir: PLUGIN_DIR, execPath: process.execPath },
        error: lastError === '' ? undefined : lastError,
      }
    }

    const status = async (request, response) => {
      if (located === undefined) {
        sendJson(response, 200, { ok: false, error: lastError })
        return
      }
      sendJson(response, 200, snapshot())
    }

    const toggle = async (request, response) => {
      // A cross-site page cannot send this content type without a CORS
      // preflight, which the exact route never answers.
      if (mediaType(request) !== 'application/json') {
        sendJson(response, 415, { ok: false, error: 'expected application/json' })
        return
      }
      const body = await readJson(request)
      if (body.invalid !== undefined) {
        sendJson(response, 400, { ok: false, error: body.invalid })
        return
      }
      const next = body.enabled === true
      // The switch reports the requested direction immediately; the work below
      // settles it and the live stage carries the rest.
      enabled = next
      if (!next) {
        // Answer at once and let the unmount finish behind the response: a
        // switch that stands still for seconds reads as a hung switch, and the
        // chip already follows the stage from /dsh-rea/status.
        disable().catch((error) => {
          lastError = friendly(error)
        })
        sendJson(response, 200, {
          ...snapshot(),
          outcome: { application: 'applied', enabled: false },
        })
        return
      }
      // Same on the way up: the mount is reported through the live stage, so a
      // cold start never holds this request open for the whole warm-up.
      enable().catch((error) => {
        lastError = friendly(error)
        stage = 'failed'
      })
      debugLog('toggle on', JSON.stringify({ stage }))
      sendJson(response, 200, {
        ...snapshot(),
        outcome: { application: 'applied', enabled },
      })
    }

    const disposers = [
      scope.webServer.register({ kind: 'exact', path: '/dsh-rea/status', auth: 'required', handler: status }),
      scope.webServer.register({ kind: 'exact', path: '/dsh-rea/toggle', auth: 'required', handler: toggle }),
    ]
    return () => {
      for (const remove of disposers) {
        try {
          remove()
        } catch { /* already gone */ }
      }
    }
  })
}
