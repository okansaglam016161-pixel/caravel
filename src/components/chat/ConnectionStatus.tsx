//   Ambient connection indicator + relay-health panel — transcribed element-for-element from the
//   design file "Caravel Chat Shell (Build).dc.html" (Connection indicator + Relay health panel),
//   wired to REAL data: messagingStatus for the indicator, getRelayStates() for the panel (polled
//   ~1s while open only), reconnectAll() for the degraded "Reconnect all" action.

import { useEffect, useState } from 'react'
import type { MessagingConnectionStatus, RelayState } from '../../messaging/types'

const MONO = 'var(--font-mono)'

function hostname(url: string): string {
  return url.replace(/^wss?:\/\//, '').replace(/\/$/, '')
}
function ago(t: number | null): string {
  if (t === null) return '—'
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s ago`
  return `${Math.round(secs / 60)}m ago`
}

// ── Ambient indicator (compact resting form in the sidebar top zone) ──
export function ConnectionIndicator({ status, connected, total, onClick }: {
  status: MessagingConnectionStatus
  connected: number
  total: number
  onClick: () => void
}) {
  const count = `${connected}/${total}`
  // V3 draws this as a DASHED strip on the page ground rather than a solid card: it is an ambient
  // status line inside the list, not an item in it, and a dashed edge says "not a row you can open"
  // without needing a different colour. The design only draws the degraded state; the other three
  // keep their semantic hue, because a strip that looked the same whether you were connected or
  // offline would be worse than no strip.
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: '7px 12px', borderRadius: 9, background: 'var(--surface-base)', cursor: 'pointer',
  }
  const dot = (bg: string, anim: string) => (
    <span style={{ width: 6, height: 6, borderRadius: '50%', background: bg, animation: anim, flexShrink: 0 }} />
  )
  const spinner = (
    <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid var(--border-strong)', borderTopColor: 'var(--text-muted-dim)', animation: 'cv-spin 0.8s linear infinite', flexShrink: 0 }} />
  )
  let border: string, lead: React.ReactNode, label: string, labelC: string, countC: string
  if (status === 'connected') {
    border = 'var(--border-strong)'; lead = dot('var(--positive)', 'cv-breathe 3s ease-in-out infinite')
    label = 'Private & connected'; labelC = 'var(--text-body-dim)'; countC = 'var(--text-muted-dim)'
  } else if (status === 'connecting') {
    border = 'var(--border-strong)'; lead = spinner
    label = 'Connecting…'; labelC = 'var(--text-body-dim)'; countC = 'var(--text-muted-dim)'
  } else if (status === 'degraded') {
    const down = total - connected
    border = 'var(--warn)'; lead = dot('var(--warn)', 'cv-pulse 1.8s ease-in-out infinite')
    label = `Still connected, ${down} relay${down === 1 ? '' : 's'} down`; labelC = 'var(--text-body-dim)'; countC = 'var(--warn)'
  } else {
    border = 'var(--danger-500)'; lead = dot('var(--danger-500)', 'cv-pulse 1.4s ease-in-out infinite')
    label = 'Offline, reconnecting'; labelC = 'var(--danger-300)'; countC = 'var(--danger-300)'
  }
  return (
    <div onClick={onClick} style={{ ...base, border: `1px dashed ${border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {lead}
        <span style={{ fontSize: 11.5, color: labelC, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </div>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: countC, flexShrink: 0 }}>{count}</span>
    </div>
  )
}

// ── Relay-health panel (opens from the indicator) ──
export function RelayHealthPanel({ getRelayStates, reconnectAll, onClose }: {
  getRelayStates: () => RelayState[]
  reconnectAll: () => void
  onClose: () => void
}) {
  const [states, setStates] = useState<RelayState[]>(() => getRelayStates())
  // Poll ~1s while open only (per-relay state isn't pushed); interval clears on unmount.
  useEffect(() => {
    const iv = setInterval(() => setStates(getRelayStates()), 1000)
    return () => clearInterval(iv)
  }, [getRelayStates])

  const total = states.length
  const connected = states.filter(s => s.status === 'connected').length
  const healthy = total > 0 && connected === total

  const rowDot = (s: RelayState) => {
    if (s.status === 'connected') return 'var(--teal-500)'
    if (s.status === 'failed') return 'var(--danger-500)'
    return 'var(--warn)' // connecting / closed → reconnecting
  }
  const rowText = (s: RelayState): { t: string; c: string } => {
    if (s.status === 'connected') return { t: ago(s.lastHeartbeatOk), c: 'var(--text-teal-dim)' }
    if (s.status === 'failed') return { t: s.lastHeartbeatOk ? ago(s.lastHeartbeatOk) : 'failed', c: 'var(--danger-300)' }
    return { t: 'reconnecting', c: 'var(--warn-300)' }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 150 }} />
      <div style={{
        position: 'absolute', top: 8, left: 16, right: 16, zIndex: 151,
        borderRadius: 16, background: 'var(--surface)',
        border: `1px solid ${healthy ? 'rgba(var(--teal-500-rgb),0.22)' : 'rgba(var(--warn-rgb),0.26)'}`,
        boxShadow: 'var(--e3)', overflow: 'hidden',
      }}>
        {/* header */}
        <div style={{ padding: '18px 18px 16px', background: `radial-gradient(300px 140px at 50% 0%, rgba(var(--${healthy ? 'teal-500' : 'warn'}-rgb),0.1), rgba(var(--${healthy ? 'teal-500' : 'warn'}-rgb),0))`, borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 8, background: `rgba(var(--${healthy ? 'teal-500' : 'warn'}-rgb),0.14)`, border: `1px solid rgba(var(--${healthy ? 'teal-500' : 'warn'}-rgb),0.3)` }}>
              {healthy
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>}
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-bright)' }}>{healthy ? 'Privately connected' : 'Still connected'}</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {healthy
              ? `Connected to ${connected} of ${total} relays. Your messages are relayed blind.`
              : `Connected to ${connected} of ${total} relays. Messages still send, delivery may be slower.`}
          </div>
        </div>
        {/* per-relay list */}
        <div style={{ padding: 8 }}>
          {states.map((s) => {
            const rt = rowText(s)
            return (
              <div key={s.url} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 12px', borderRadius: 10 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: rowDot(s), flexShrink: 0 }} />
                <span style={{ flex: 1, fontFamily: MONO, fontSize: 12, color: s.status === 'connected' ? 'var(--text-body-dim)' : rt.c, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hostname(s.url)}</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: rt.c, flexShrink: 0 }}>{rt.t}</span>
              </div>
            )
          })}
          {!healthy && (
            <div onClick={reconnectAll} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, margin: '6px 4px 2px', padding: '11px', borderRadius: 11, background: 'var(--surface-raised)', border: '1px solid rgba(var(--teal-500-rgb),0.24)', color: 'var(--text-bright)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal-500)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" /></svg>Reconnect all
            </div>
          )}
        </div>
      </div>
    </>
  )
}
