window.__ModuleLoader__.load({
  id: 'dsh-rea-pro',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The Host half answers /dsh-rea/status and /dsh-rea/toggle in-process, so
    // the chip never has to reach a Remote service itself.
    const STATUS_PATH = '/dsh-rea/status'
    const TOGGLE_PATH = '/dsh-rea/toggle'

    const english = (navigator.language || '').toLowerCase().startsWith('en')
    const text = english
      ? { on: 'REA on', off: 'REA off', turnOn: 'Click to turn REA MCP on', turnOff: 'Click to turn REA MCP off (stop injecting its tools)' }
      : { on: 'REA 开', off: 'REA 关', turnOn: '点击开启 REA MCP', turnOff: '点击关闭 REA MCP（不再向会话注入 REA 工具）' }

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
      const [view, setView] = React.useState({ enabled: false, known: false, busy: false, note: '' })

      // REA needs about 40 s before its tools are served, so the chip stays on
      // and the host reports `mounted` once the manager reaches `connected`.
      // If the host withdraws the server instead (an unclean close), it writes
      // the state back to off and this flips the label with the reason.
      const followMount = async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 3000))
          const payload = await request(STATUS_PATH).catch(() => null)
          if (payload === null || payload.ok !== true) continue
          if (payload.enabled !== true) {
            setView(v => ({ ...v, enabled: false, busy: false, known: true, note: payload.error || '' }))
            return
          }
          if (payload.mounted === true) {
            setView(v => ({ ...v, busy: false, note: '' }))
            return
          }
        }
        setView(v => ({ ...v, busy: false }))
      }

      React.useEffect(() => {
        let live = true
        readStatus(4)
          .then(payload => {
            if (!live) return
            if (payload.ok === true) {
              setView(v => ({ ...v, enabled: payload.enabled === true, known: true, note: payload.error || '' }))
              if (payload.enabled === true && payload.mounted !== true) void followMount()
            } else setView(v => ({ ...v, known: false, note: payload.error || 'status read failed' }))
          })
        return () => { live = false }
      }, [])

      const toggle = async (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (view.busy || !view.known) return
        const target = !view.enabled
        // Flip at once: the switch has only two states, so the label must not
        // sit on the old one while the host settles (unmount can take ~20 s).
        setView(v => ({ ...v, enabled: target, busy: true, note: '' }))
        try {
          const payload = await request(TOGGLE_PATH, { enabled: target })
          if (payload.ok !== true) {
            setView(v => ({ ...v, enabled: !target, busy: false, note: payload.error || 'toggle failed' }))
            return
          }
          setView(v => ({ ...v, busy: false, note: '' }))

          // The toggle response already carries the settled state, so the label
          // flips at once; a follow-up read only reconciles a later failure.
          if (payload.enabled === true || payload.enabled === false) {
            setView(v => ({ ...v, enabled: payload.enabled === true, known: true }))
          }
          const refreshed = await readStatus(1)
          if (refreshed.ok === true) {
            setView(v => ({ ...v, enabled: refreshed.enabled === true, known: true }))
          }
          if (payload.enabled === true) void followMount()
        } catch (error) {
          setView(v => ({ ...v, enabled: !target, busy: false, note: error.message || String(error) }))
        }
      }

      const label = view.enabled ? text.on : text.off
      const dot = view.enabled
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-border-l3)'

      return h('button', {
        type: 'button',
        onClick: toggle,
        title: view.note || (view.enabled ? text.turnOff : text.turnOn),
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
