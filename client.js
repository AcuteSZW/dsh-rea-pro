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
      ? { on: 'REA on', off: 'REA off', busy: 'REA …', unknown: 'REA ?', offHint: 'Click to turn REA MCP off (stop injecting its tools)', onHint: 'Click to turn REA MCP on' }
      : { on: 'REA 开', off: 'REA 关', busy: 'REA …', unknown: 'REA ?', offHint: '点击关闭 REA MCP（不再向会话注入 REA 工具）', onHint: '点击开启 REA MCP' }

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

      React.useEffect(() => {
        let live = true
        readStatus(4)
          .then(payload => {
            if (!live) return
            if (payload.ok === true) setView(v => ({ ...v, enabled: payload.enabled === true, known: true, note: payload.error || '' }))
            else setView(v => ({ ...v, known: false, note: payload.error || 'status read failed' }))
          })
        return () => { live = false }
      }, [])

      const toggle = async (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (view.busy || !view.known) return
        setView(v => ({ ...v, busy: true, note: '' }))
        try {
          const payload = await request(TOGGLE_PATH, { enabled: !view.enabled })
          if (payload.ok !== true) {
            setView(v => ({ ...v, busy: false, note: payload.error || 'toggle failed' }))
            return
          }
          setView(v => ({ ...v, busy: false, note: '' }))

          // The Host settles its registration asynchronously, so the label
          // follows a fresh read rather than the toggle response.
          const refreshed = await readStatus(2)
          if (refreshed.ok === true) {
            setView(v => ({ ...v, enabled: refreshed.enabled === true, known: true }))
          }
        } catch (error) {
          setView(v => ({ ...v, busy: false, note: error.message || String(error) }))
        }
      }

      const label = view.busy
        ? text.busy
        : !view.known ? text.unknown : view.enabled ? text.on : text.off
      const dot = !view.known
        ? 'var(--dsw-alias-state-warning-primary)'
        : view.enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l3)'

      return h('button', {
        type: 'button',
        onClick: toggle,
        title: view.note || (view.enabled ? text.offHint : text.onHint),
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
