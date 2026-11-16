window.__ModuleLoader__.load({
  id: 'dsh-rea-pro',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The Host half answers /dsh-rea/status and /dsh-rea/toggle in-process, so
    // the chip never has to reach a Remote service itself.
    const STATUS_PATH = '/dsh-rea/status'
    const TOGGLE_PATH = '/dsh-rea/toggle'

    // A mount on a warm server settles in well under a second; the poll only
    // exists so the counter keeps moving while a cold one is still starting.
    const POLL_MS = 700
    const POLL_LIMIT = 180

    const seconds = (ms) => Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000))

    const english = (navigator.language || '').toLowerCase().startsWith('en')
    const text = english
      ? {
          on: 'REA on',
          off: 'REA off',
          closing: 'REA closing',
          mounting: (elapsed, expected) => (expected > elapsed ? `REA ${elapsed}s / ~${expected}s` : `REA ${elapsed}s`),
          turnOn: 'Click to turn REA MCP on',
          turnOff: 'Click to turn REA MCP off (stop injecting its tools)',
          stage: {
            off: 'REA off',
            warming: 'starting the REA server',
            initializing: 'loading the REA tool catalog',
            registering: 'registering the REA server',
            connecting: 'connecting to the REA server',
            connected: 'REA tools available',
            failed: 'REA failed to mount',
          },
        }
      : {
          on: 'REA 开',
          off: 'REA 关',
          closing: '正在关闭',
          mounting: (elapsed, expected) => (expected > elapsed ? `正在挂载 ${elapsed}s / 约 ${expected}s` : `正在挂载 ${elapsed}s`),
          turnOn: '点击开启 REA MCP',
          turnOff: '点击关闭 REA MCP（不再向会话注入 REA 工具）',
          stage: {
            off: 'REA 已关闭',
            warming: '正在启动 REA 服务进程',
            initializing: '正在载入 REA 工具目录',
            registering: '正在注册 REA 服务器',
            connecting: '正在连接 REA 服务器',
            connected: 'REA 工具已就绪',
            failed: 'REA 挂载失败',
          },
        }

    const request = async (path, body) => {
      const response = await fetch(path, body === undefined
        ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      return payload
    }

    const readStatus = async (attempts) => {
      let last = { ok: false, error: 'status read failed' }
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const payload = await request(STATUS_PATH)
          if (payload.ok === true) return payload
          last = payload
        } catch (error) {
          last = { ok: false, error: error.message || String(error) }
        }
        // A page reload races the connection's own auth cookie, so the first
        // read can land unauthenticated; retry before declaring it unknown.
        await new Promise(resolve => setTimeout(resolve, 1200))
      }
      return last
    }

    function ReaChip() {
      const [view, setView] = React.useState({
        enabled: false, known: false, busy: false, note: '', stage: 'off', elapsedMs: 0, expectedMs: 0,
      })
      // Stops an in-flight poll loop once this chip unmounts.
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      // Absorb one Host snapshot: the switch state plus the mount progress the
      // Host reports (stage / elapsedMs / expectedMs).
      const absorb = (payload) => {
        const nextStage = typeof payload.stage === 'string' && payload.stage !== ''
          ? payload.stage
          : (payload.mounted === true ? 'connected' : (payload.enabled === true ? 'connecting' : 'off'))
        setView(v => ({
          ...v,
          enabled: payload.enabled === true,
          known: true,
          stage: nextStage,
          elapsedMs: Number.isFinite(payload.elapsedMs) ? payload.elapsedMs : 0,
          expectedMs: Number.isFinite(payload.expectedMs) ? payload.expectedMs : 0,
          note: payload.error || '',
        }))
      }

      // Poll until the mount settles (connected, or rolled back to off) so the
      // chip can show a moving counter instead of a silent 40-second wait.
      const follow = async () => {
        for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, POLL_MS))
          if (!alive.current) return
          const payload = await request(STATUS_PATH).catch(() => null)
          if (payload === null || payload.ok !== true) continue
          absorb(payload)
          if (payload.enabled !== true || payload.mounted === true) {
            setView(v => ({ ...v, busy: false }))
            return
          }
        }
        setView(v => ({ ...v, busy: false }))
      }

      React.useEffect(() => {
        readStatus(4)
          .then(payload => {
            if (!alive.current) return
            if (payload.ok === true) {
              absorb(payload)
              // Mounted already, or still mounting from an earlier click/tab.
              if (payload.enabled === true && payload.mounted !== true) {
                setView(v => ({ ...v, busy: true }))
                void follow()
              }
            } else setView(v => ({ ...v, known: false, note: payload.error || 'status read failed' }))
          })
      }, [])

      const toggle = async (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (view.busy || !view.known) return
        const target = !view.enabled
        // Flip at once: the switch has only two states, so the label must not
        // sit on the old one while the host settles.
        setView(v => ({
          ...v, enabled: target, busy: true, note: '',
          stage: target ? 'warming' : 'off', elapsedMs: 0, expectedMs: v.expectedMs,
        }))
        try {
          const payload = await request(TOGGLE_PATH, { enabled: target })
          if (payload.ok !== true) {
            setView(v => ({ ...v, enabled: !target, busy: false, note: payload.error || 'toggle failed' }))
            return
          }
          absorb(payload)
          if (payload.enabled === true && payload.mounted !== true) {
            // Still mounting behind the response: keep the counter running.
            void follow()
            return
          }
          setView(v => ({ ...v, busy: false, note: '' }))
        } catch (error) {
          setView(v => ({ ...v, enabled: !target, busy: false, note: error.message || String(error) }))
        }
      }

      const mounting = view.enabled && view.stage !== 'connected'
      const label = !view.enabled && view.busy
        ? text.closing
        : mounting
          ? text.mounting(seconds(view.elapsedMs), seconds(view.expectedMs))
          : view.enabled ? text.on : text.off
      const dot = view.enabled && view.stage === 'connected'
        ? 'var(--dsw-alias-brand-primary)'
        : mounting ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-border-l3)'
      const stageText = text.stage[view.stage] ?? text.stage[view.enabled ? 'connecting' : 'off']
      const hint = view.note !== '' ? view.note : `${stageText}｜${view.enabled ? text.turnOff : text.turnOn}`

      return h('button', {
        type: 'button',
        onClick: toggle,
        title: hint,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
          borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)', cursor: view.busy ? 'wait' : 'pointer', fontSize: 12,
        },
      },
      h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 } }),
      label)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'rea-toggle', order: 20,
        }, ReaChip))
      },
    }
  },
})
