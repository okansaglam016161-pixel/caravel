//   The V3 entry chrome — shared by unlock, create and restore.
//
//   All three flows draw the same card, the same field, the same buttons and the same word grid;
//   they differ only in what they ask for. Before this they each carried their own copy of that
//   vocabulary, which is how the three screens a user meets FIRST ended up with three slightly
//   different input borders. The style objects live next door in entryStyles.ts; the pieces that
//   need markup live here.
//
//   THEME HANDOFF PRESERVED. Nothing here is a literal except the logo tile's mark, which is the
//   light mark on an accent ground in both themes by design. Everything else reads role tokens, so
//   a visitor who chose dark on the landing page meets a dark unlock screen — see hooks/useTheme.
//
//   THE LOCKUP IS A LINK HOME. That makes this module depend on the router, which is new and worth
//   saying out loud: every screen built from these pieces renders under /app, inside the same
//   BrowserRouter the landing page uses, so the hook has a router to find. See Lockup.

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MONO } from './entryStyles'

/** The page ground. Flat, per V3 — the radial lift it replaced predates the foundation. */
export const entryShell: CSSProperties = {
  minHeight: '100vh',
  background: 'var(--surface-void)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  padding: '40px 24px',
}

/**
 * The card. `wide` is the 400px variant the two 24-word screens need; everything else is 360.
 * `centred` is the welcome/unlock shape, which also takes the taller 40px padding.
 */
export function EntryCard({ children, wide = false, centred = false, pad, style }: {
  children: ReactNode; wide?: boolean; centred?: boolean; pad?: string | number; style?: CSSProperties
}) {
  return (
    <div style={{
      width: '100%', maxWidth: wide ? 400 : 360, boxSizing: 'border-box',
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 18, padding: pad ?? (centred ? '40px 32px' : 32),
      boxShadow: 'var(--e1)',
      ...(centred ? { textAlign: 'center' as const } : {}),
      ...style,
    }}>{children}</div>
  )
}

/**
 * The mark on its accent tile, and the way back to the landing page. One lockup, both themes — the
 * light mark on a blue ground.
 *
 * THE ROUTE HOME FROM THE GATES, matching the spine's logo inside the app. These are the two
 * screens a visitor meets first, and until now arriving at either was a one-way door: someone who
 * clicked through from the landing page to look, and was met by a password prompt, had the browser
 * back button and nothing else.
 *
 * NOTHING TO UNWIND WHEN IT FIRES. The spine's version has to say it navigates without locking;
 * here there is no session to keep or drop — these screens render precisely because there is no
 * unlocked wallet. It is a plain navigate.
 *
 * A <button> rather than a <Link>, as in the spine: Enter, Space and the focus ring come from the
 * element. The <img> stays decorative — the accessible name belongs on the control, not on the
 * picture inside it.
 *
 * Rendered by the welcome step of create and by unlock. RestoreFlow draws no lockup, so it needs
 * nothing here; its way back is the Back control it already has.
 */
export function Lockup() {
  const navigate = useNavigate()
  return (
    <button
      onClick={() => navigate('/')}
      title="Caravel — home"
      aria-label="Caravel — home"
      className="cv-accent-tile"
      style={{
        width: 44, height: 44, borderRadius: 13, background: 'var(--accent-400)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, border: 'none', cursor: 'pointer',
      }}
    >
      <img src="/logo-light.png" alt="" aria-hidden="true" style={{ height: 23, width: 'auto', display: 'block' }} />
    </button>
  )
}

/** A card heading. `big` is the 21px form heading; the default is the 19px centred one. */
export function EntryTitle({ children, big = false, mt = 0 }: { children: ReactNode; big?: boolean; mt?: number }) {
  return (
    <h2 style={{
      margin: 0, marginTop: mt, fontSize: big ? 21 : 19, fontWeight: 600,
      letterSpacing: '-0.015em', color: 'var(--text-primary)',
    }}>{children}</h2>
  )
}

export function EntryBlurb({ children, mt = 6 }: { children: ReactNode; mt?: number }) {
  return (
    <div style={{ fontSize: 13, color: 'var(--text-muted-dim)', marginTop: mt, lineHeight: 1.55, textWrap: 'pretty' }}>
      {children}
    </div>
  )
}

/**
 * A labelled text input, with the foundation's focus ring via `.cv-field`.
 *
 * PASSWORD FIELDS GET AN EYE. The frames draw a plain `type=password`, and the toggle is kept
 * anyway — it is what the PasswordField this replaced offered, and every gate that takes a
 * password either asks for it TWICE (create, restore) or is the one screen standing between a
 * person and their own money (unlock). A typo you cannot see costs a round trip on all three.
 * Showing your own password to yourself on a pre-auth screen reveals nothing to anyone else.
 */
export function EntryField({ label, value, onChange, onKeyDown, placeholder, type = 'text', invalid, autoFocus, ariaLabel, mt = 0 }: {
  label?: string
  value: string
  onChange: (v: string) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  placeholder?: string
  type?: 'text' | 'password'
  invalid?: boolean
  autoFocus?: boolean
  ariaLabel?: string
  mt?: number
}) {
  const [show, setShow] = useState(false)
  const isPassword = type === 'password'

  return (
    <div style={{ marginTop: mt }}>
      {label && <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-body-dim)' }}>{label}</div>}
      <div className="cv-field" style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: label ? 8 : 0,
        border: `1px solid ${invalid ? 'var(--danger-500)' : 'var(--border-strong)'}`,
        borderRadius: 10, padding: '12px 14px', background: 'var(--surface)',
      }}>
        <input
          type={isPassword && !show ? 'password' : 'text'} value={value} autoFocus={autoFocus}
          onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
          placeholder={placeholder} aria-label={ariaLabel ?? label}
          style={{
            flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', padding: 0,
            fontFamily: MONO, fontSize: 13.5, color: 'var(--text-primary)',
          }}
        />
        {isPassword && (
          <span
            role="button" tabIndex={0} aria-label={show ? 'Hide password' : 'Show password'}
            onClick={() => setShow(v => !v)} onKeyDown={e => e.key === 'Enter' && setShow(v => !v)}
            style={{ cursor: 'pointer', flexShrink: 0, display: 'flex' }}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
              {!show && <path d="M4 4l16 16" />}
            </svg>
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The full-width action.
 *
 * The disabled treatment is the design's own — a filled `--border` ground with muted ink, not an
 * opacity fade. It reads as "not yet" rather than as a broken button, which matters on the confirm
 * screen where being disabled is the normal state for most of the time you are on it.
 */
export function EntryButton({ tone, onClick, children, mt, disabled = false, type }: {
  tone: 'primary' | 'quiet'
  onClick?: () => void
  children: ReactNode
  mt: number
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  const primary = tone === 'primary'
  return (
    <button
      type={type ?? 'button'}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={!primary && !disabled ? 'cv-quiet-btn' : undefined}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        width: '100%', boxSizing: 'border-box', marginTop: mt,
        padding: primary ? 13 : 12, borderRadius: 10,
        fontSize: primary ? 14 : 13.5, fontWeight: 600, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: disabled ? 'var(--border)' : primary ? 'var(--accent-400)' : 'transparent',
        border: disabled ? '1px solid transparent' : primary ? '1px solid transparent' : '1px solid var(--border-strong)',
        color: disabled ? 'var(--text-muted-dim)' : primary ? '#FFFFFF' : 'var(--text-primary)',
      }}
    >{children}</button>
  )
}

/** A quiet text link — "I have a recovery phrase", "Back", "Restore from recovery phrase". */
export function EntryLink({ onClick, children, mt = 14, tone = 'accent' }: {
  onClick: () => void; children: ReactNode; mt?: number; tone?: 'accent' | 'muted'
}) {
  return (
    <div
      role="button" tabIndex={0} onClick={onClick} onKeyDown={e => e.key === 'Enter' && onClick()}
      style={{
        marginTop: mt, textAlign: 'center', fontSize: 13, fontWeight: 500,
        color: tone === 'accent' ? 'var(--accent-ink)' : 'var(--text-muted-dim)',
        cursor: 'pointer', userSelect: 'none',
      }}
    >{children}</div>
  )
}

/**
 * One numbered word of a phrase — read-only. The restore grid builds its own, editable.
 *
 * ── IT MUST BE A FLEX BOX, NOT AN INLINE ONE ─────────────────────────────────
 *
 * This rendered as a bare `<span>` once, which is `display: inline`, and the seed grid came out as
 * an overlapping staircase. Vertical padding and borders on an inline box PAINT but do not
 * contribute to the line box's height, so every chip drew ~29px tall inside a row sized to a ~13px
 * line and bled over the row beneath it.
 *
 * A direct grid item would have been blockified and hidden the fault — which is exactly what made
 * it confusing: the same markup was correct in the profile panel's reveal, where the chips ARE the
 * grid items, and wrong here, where a wrapper span for `user-select` sat in between and took the
 * blockification for itself. So the display is now explicit and the wrapper is gone: `selectable`
 * puts `user-select` on the chip, which is the element that should carry it anyway.
 *
 * `minWidth: 0` on the flex child is what lets the ellipsis work at all — a flex item's default
 * `min-width: auto` refuses to shrink below its content, so `overflow: hidden` never engages.
 */
export function WordChip({ n, word, tone = 'plain', selectable = false }: {
  n: number; word: ReactNode; tone?: 'plain' | 'bad'; selectable?: boolean
}) {
  const bad = tone === 'bad'
  return (
    <span style={{
      display: 'flex', alignItems: 'baseline', gap: 6, boxSizing: 'border-box',
      padding: '7px 10px', borderRadius: 8, minWidth: 0,
      background: 'var(--surface-void)',
      border: `1px solid ${bad ? 'var(--danger-500)' : 'var(--border)'}`,
      fontFamily: MONO, fontSize: 11,
      color: bad ? 'var(--danger-300)' : 'var(--text-primary)',
      userSelect: selectable ? 'all' : undefined,
    }}>
      <span style={{ flexShrink: 0, color: bad ? 'var(--danger-300)' : 'var(--text-muted-dim)' }}>{n}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{word}</span>
    </span>
  )
}

/** The three-column phrase grid. */
export function WordGrid({ children, mt = 20 }: { children: ReactNode; mt?: number }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginTop: mt,
      // `minmax(0, 1fr)` rather than `1fr`: a bare 1fr track has an `auto` minimum, so one long
      // word would push its column wider than its share and knock the other two out of alignment.
      // `stretch` keeps every chip in a row the same height as the tallest.
      alignItems: 'stretch',
    }}>
      {children}
    </div>
  )
}

/**
 * The custody line.
 *
 * THE ONE SENTENCE THAT HAS TO SURVIVE ANY RESKIN OF THIS SCREEN. "Keep them safe" alone lets
 * someone assume a fallback exists; a recovery phrase is not a password support can reset, and
 * there is no one to ask. Said flatly, as a fact rather than a warning — which is why it can sit
 * in the same quiet grey as everything else and still land.
 *
 * Identical to the wording on the profile panel's reveal. The two screens show the same 24 words
 * and must say the same thing about them.
 */
export function CustodyLine({ mt = 16 }: { mt?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: mt, justifyContent: 'center' }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
        <path d="M12 2l8 3.5v5.2c0 5-3.4 9.6-8 11.3-4.6-1.7-8-6.3-8-11.3V5.5z" />
      </svg>
      <span style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', lineHeight: 1.5, textWrap: 'pretty' }}>
        Keep them safe and offline. Never share them. Caravel cannot recover them for you.
      </span>
    </div>
  )
}

/** An inline error under a field, or a form-level one. */
export function EntryError({ children, mt = 8 }: { children: ReactNode; mt?: number }) {
  return <div style={{ fontSize: 12.5, color: 'var(--danger-500)', marginTop: mt, lineHeight: 1.5 }}>{children}</div>
}

/** The spinner every busy state uses. */
export function EntrySpinner({ size = 28, ring = 3 }: { size?: number; ring?: number }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      border: `${ring}px solid var(--border)`, borderTopColor: 'var(--accent-400)',
      animation: 'cv-spin 1s linear infinite',
    }} />
  )
}
