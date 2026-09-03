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
      {/* The COUNT is ours — §7B's strip drops it, and "3/3" is the one thing this line can say at
          a glance that the label can't. The CHEVRON is the design's, and deliberately NEUTRAL:
          the dot and the label already carry status, so this one says only "this opens". */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: countC }}>{count}</span>
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: 'rotate(180deg)' }}><path d="M6 9l6 6 6-6" /></svg>
      </div>
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

  // §7B paints a connected relay with --pos on BOTH the dot and its status text. The dot was
  // --teal-500 (the accent, not the health colour) and the text --text-teal-dim (#46648A — a slate,
  // not a green at all), so a healthy relay never actually read as healthy.
  const rowDot = (s: RelayState) => {
    if (s.status === 'connected') return 'var(--positive)'
    if (s.status === 'failed') return 'var(--danger-500)'
    return 'var(--warn)' // connecting / closed → reconnecting
  }
  // Three states, three strings — the design spells the good one out ("Connected · 12s ago") and
  // leaves the other two as bare words. A failed relay no longer shows a stale last-seen clock:
  // the dot and the word are the whole story, and a time there read as if it were still alive.
  const rowText = (s: RelayState): { t: string; c: string } => {
    if (s.status === 'connected') return { t: `Connected · ${ago(s.lastHeartbeatOk)}`, c: 'var(--positive)' }
    if (s.status === 'failed') return { t: 'Failed', c: 'var(--danger-500)' }
    return { t: 'Reconnecting', c: 'var(--warn)' }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
      {/* §7B — ONE FLAT CARD. The V2 panel had a two-region build: a radial-gradient hero header
          with its own border-bottom, then a padded list. The design draws neither — a plain hairline
          box at 16px padding, with the health colour carried by the icon tile and the rows rather
          than by the container's border. */}
      <div style={{
        position: 'absolute', top: 8, left: 16, right: 16, zIndex: 201,
        borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)',
        boxShadow: 'var(--e3)', padding: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          {/* One glyph for both states — the design swaps only the tile's fill and ink, so healthy
              and degraded stay the same shape and the colour does the talking. */}
          <span style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 9, flexShrink: 0,
            background: healthy ? 'rgba(var(--positive-rgb),0.12)' : 'rgba(var(--warn-rgb),0.12)',
            color: healthy ? 'var(--positive)' : 'var(--warn)',
          }}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M5 12.5a7 7 0 0 1 14 0" /><path d="M8.5 15.5a4 4 0 0 1 7 0" /><path d="M12 18.5h.01" /></svg>
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{healthy ? 'Privately connected' : 'Still connected'}</div>
            {/* OUR sentence, at the design's type scale. §7B's own sub is "All 3 relays connected",
                which the rows below already say — and it drops "relayed blind", which is the claim
                this panel exists to make. The colour is --text-muted-dim (the design's --muted);
                it was --text-muted, which maps to the design's --text2, one step too bright. */}
            <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 1, lineHeight: 1.5, textWrap: 'pretty' }}>
              {healthy
                ? `Connected to ${connected} of ${total} relays. Your messages are relayed blind.`
                : `Connected to ${connected} of ${total} relays. Messages still send, delivery may be slower.`}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 12 }}>
          {states.map((s) => {
            const rt = rowText(s)
            return (
              <div key={s.url} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderRadius: 8 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: rowDot(s), flexShrink: 0 }} />
                <span style={{ flex: 1, fontFamily: MONO, fontSize: 11.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hostname(s.url)}</span>
                {/* Sans, not mono: the host is the machine-readable half of the row, the status is
                    prose about it, and the design sets them in different faces for that reason. */}
                <span style={{ fontSize: 11, fontWeight: 600, color: rt.c, flexShrink: 0 }}>{rt.t}</span>
              </div>
            )
          })}
        </div>
        {!healthy && (
          <div onClick={reconnectAll} style={{ textAlign: 'center', padding: 9, borderRadius: 10, border: '1px solid var(--border-strong)', color: 'var(--text-body-dim)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', marginTop: 10 }}>
            Reconnect all
          </div>
        )}
      </div>
    </>
  )
}
