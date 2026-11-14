/**
 * Host half: mounts the REA MCP server for this plugin's own lifetime and
 * exposes a loopback switch for it.
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

/** A directory is a REA package when it holds the manifest and the MCP launcher. */
const asServerRoot = (root) => {
  const script = join(root, 'scripts', 'rea.mjs')
  if (!existsSync(script)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (manifest?.name !== PACKAGE) return undefined
  } catch {
    return undefined
  }
  return { script, root }
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
    return { script, root: dirname(dirname(script)) }
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

export function apply(ctx, config = {}) {
  const serverName = typeof config.serverName === 'string' && config.serverName !== '' ? config.serverName : SERVER_NAME
  const located = locateServer(config)

  let enabled = false
  let dispose = null
  let ready = false
  let lastError = located === undefined ? `${PACKAGE} 未安装：请先安装 rea-agents（npm i rea-agents）` : ''

  const mount = () => {
    if (dispose !== null || located === undefined) return
    if (!ready) throw new Error('mcpManager 尚未就绪')
    debugLog('mount', JSON.stringify({ exec: process.execPath, script: located.script, cwd: located.root }))
    dispose = managerRegister({
      transport: 'stdio',
      command: process.execPath,
      args: [located.script, 'mcp'],
      env: {},
      cwd: located.root,
      toolCallTimeoutMs: 120000,
      startupTimeoutMs: 30000,
      // A close that races REA's own start-up (an initialize still in flight
      // while the child is loading its 255 tools) can exceed the manager's
      // default budget; the manager then keeps an incomplete-cleanup record
      // and refuses every later mount until the Host restarts. The child
      // itself exits in milliseconds once it is idle, so a generous budget
      // costs nothing in the normal path and keeps a slow exit from poisoning
      // the switch.
      closeTimeoutMs: 60000,
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

  let managerRegister = () => {
    throw new Error('mcpManager 尚未就绪')
  }
  let managerStatus = () => undefined
  const connectedState = () => managerStatus()?.status?.state === 'connected'
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  /** The switch only reads as on when the server actually reached `connected`. */
  const READY_BUDGET_MS = 10000
  const SETTLE_POLL_MS = 4000

  const waitForReady = async (budgetMs) => {
    const until = Date.now() + budgetMs
    while (!ready && Date.now() < until) await sleep(200)
    return ready
  }

  /**
   * REA needs ~40 s to reach `connected` on a warm machine (its providers load
   * before the tool list is served), so the switch cannot wait inline. Instead
   * the registration is watched in the background: a record the manager marks
   * `failed` (an unclean close, a spawn error) is withdrawn and the remembered
   * state goes back to off, while a slow start is simply allowed to finish.
   */
  let watcher
  const stopWatcher = () => {
    if (watcher !== undefined) clearInterval(watcher)
    watcher = undefined
  }
  const startWatcher = () => {
    stopWatcher()
    watcher = setInterval(() => {
      if (dispose === null) {
        stopWatcher()
        return
      }
      const entry = managerStatus()
      debugLog('watch', JSON.stringify(entry))
      const state = entry?.status?.state
      if (state === 'connected') {
        lastError = ''
        return
      }
      if (state !== 'failed') return
      const message = explain(entry.status)
      stopWatcher()
      void (async () => {
        try {
          unmount()
        } catch { /* the record is dead either way */ }
        enabled = false
        lastError = message
        await writeState(false).catch(() => {})
      })()
    }, SETTLE_POLL_MS)
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

  // The manager's service is only reachable inside an inject frame, so the
  // registration is bound there and kept in a variable for later calls.
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
      if (!on) return
      try {
        mount()
        enabled = true
        lastError = ''
        startWatcher()
      } catch (error) {
        lastError = friendly(error)
        enabled = false
        await writeState(false)
      }
    })
  })

  // Plugin unload withdraws the server, so its tools leave the context with it.
  ctx.effect(() => () => {
    stopWatcher()
    unmount()
  })

  // Admission is the WebServer's own job: a route registered without `auth`
  // defaults to 'required', and the authentication provider answers through the
  // `webserver/authorize` waterfall — the Host/Origin fence plus this session's
  // browser cookie. A cross-site page therefore cannot reach either route, and
  // the plugin has no auth code of its own to drift out of date.
  ctx.inject(['webServer'], (scope) => {
    const status = async (request, response) => {
      if (located === undefined) {
        sendJson(response, 200, { ok: false, error: lastError })
        return
      }
      sendJson(response, 200, {
        ok: true,
        enabled,
        // `mounted` now means the tools are really attached: registered but
        // still connecting (or failed) is not a mounted server.
        mounted: dispose !== null && connectedState(),
        registered: dispose !== null,
        serverName,
        script: basename(located.script),
        server: managerStatus(),
        diagnostics: { cwd: process.cwd(), pluginDir: PLUGIN_DIR, execPath: process.execPath },
        error: lastError === '' ? undefined : lastError,
      })
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
      try {
        if (next) {
          if (located === undefined) throw new Error(lastError !== '' ? lastError : `${PACKAGE} 未安装`)
          // A page load can land before the inject frame binds the manager.
          if (!await waitForReady(READY_BUDGET_MS)) throw new Error('mcpManager 尚未就绪，稍后重试')
          mount()
          enabled = true
          await writeState(true)
          lastError = ''
          startWatcher()
          sendJson(response, 200, {
            ok: true,
            enabled,
            // Registered and starting: REA answers `connected` in about 40 s,
            // and the watcher withdraws it if the manager marks it failed.
            mounted: connectedState(),
            registered: true,
            outcome: { application: 'applied', enabled },
          })
          return
        }
        stopWatcher()
        unmount()
        enabled = false
        await writeState(false)
        lastError = ''
        sendJson(response, 200, {
          ok: true,
          enabled,
          mounted: false,
          outcome: { application: 'applied', enabled },
        })
      } catch (error) {
        const message = friendly(error)
        stopWatcher()
        lastError = message
        enabled = false
        try {
          unmount()
        } catch { /* keep the reported failure */ }
        await writeState(false).catch(() => {})
        sendJson(response, 200, {
          ok: false,
          error: message,
          enabled,
          mounted: false,
          outcome: { application: 'failed', enabled },
        })
      }
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
