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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, basename, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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

/**
 * Admission for the two local routes. `webServer`'s exact routes bypass the
 * Connection fence, and comparing Origin's host to the Host header is not
 * enough: under DNS rebinding both are the attacker's name, so that check
 * passes while a hostile page reaches a loopback server. Ask the Connection
 * service instead — it applies the Host/Origin fence and then requires a
 * request that carries this session's authenticated browser cookie.
 */
const refused = (scope, request, response) => {
  let rejection
  try {
    rejection = scope.connection.requestRejection(request)
  } catch {
    rejection = 403
  }
  if (rejection === undefined) return false
  sendJson(response, rejection, {
    ok: false,
    error: rejection === 401 ? 'not authenticated' : 'request refused',
  })
  return true
}

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

/** Persisted switch state; an unreadable file means "on", which is the pre-switch behaviour. */
async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    return typeof parsed?.enabled === 'boolean' ? parsed.enabled : true
  } catch {
    return true
  }
}

async function writeState(enabled) {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

export function apply(ctx, config = {}) {
  const serverName = typeof config.serverName === 'string' && config.serverName !== '' ? config.serverName : SERVER_NAME
  const located = locateServer(config)

  let enabled = true
  let dispose = null
  let ready = false
  let lastError = located === undefined ? `${PACKAGE} 未安装：请先安装 rea-agents（npm i rea-agents）` : ''

  const mount = () => {
    if (dispose !== null || located === undefined) return
    if (!ready) throw new Error('mcpManager 尚未就绪')
    dispose = managerRegister({
      transport: 'stdio',
      command: process.execPath,
      args: [located.script, 'mcp'],
      env: {},
      cwd: located.root,
      toolCallTimeoutMs: 120000,
      startupTimeoutMs: 30000,
      // REA's server needs longer than the 5 s default to confirm a clean
      // exit; a short budget makes the manager retain an incomplete-cleanup
      // record and refuse every later mount.
      closeTimeoutMs: 20000,
      reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 10 },
    })
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
  let managerRestart = async () => {}
  const connectedState = () => managerStatus()?.status?.state === 'connected'
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  /** Rebuild a stuck instance after a previous unclean close, then stop trying. */
  const recoverIfStuck = async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(3000)
      if (!enabled || connectedState()) return
    }
    if (!enabled) return
    await managerRestart()
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
    managerRestart = async () => {
      try {
        await scope.mcpManager.restart(serverName)
      } catch (error) {
        lastError = String(error?.message ?? error)
      }
    }
    ready = true
    void readState().then((on) => {
      enabled = on
      if (!on) return
      try {
        mount()
        lastError = ''
      } catch (error) {
        lastError = String(error?.message ?? error)
      }
    })
  })

  // Plugin unload withdraws the server, so its tools leave the context with it.
  ctx.effect(() => () => {
    unmount()
  })

  ctx.inject(['webServer', 'connection'], (scope) => {
    const status = async (request, response) => {
      if (refused(scope, request, response)) return
      if (located === undefined) {
        sendJson(response, 200, { ok: false, error: lastError })
        return
      }
      sendJson(response, 200, {
        ok: true,
        enabled,
        mounted: dispose !== null,
        serverName,
        script: basename(located.script),
        server: managerStatus(),
        diagnostics: { cwd: process.cwd(), pluginDir: PLUGIN_DIR, execPath: process.execPath },
        error: lastError === '' ? undefined : lastError,
      })
    }

    const toggle = async (request, response) => {
      if (refused(scope, request, response)) return
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
        if (next) mount()
        else unmount()
        enabled = next
        await writeState(next)
        lastError = ''
        sendJson(response, 200, {
          ok: true,
          enabled,
          mounted: dispose !== null,
          outcome: { application: 'applied', enabled },
        })
        // A server that closed uncleanly keeps its instance in a failed state;
        // a restart rebuilds it so the next enable is usable again.
        if (next) void recoverIfStuck()
      } catch (error) {
        const message = String(error?.message ?? error)
        lastError = message
        sendJson(response, 200, {
          ok: false,
          error: message,
          outcome: { application: 'failed', enabled },
        })
      }
    }

    const disposers = [
      scope.webServer.register({ kind: 'exact', path: '/dsh-rea/status', handler: status }),
      scope.webServer.register({ kind: 'exact', path: '/dsh-rea/toggle', handler: toggle }),
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
