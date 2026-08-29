// The panels the design canvas never covered — faucet, send, receive, ONS.
//
// NOT NEW DESIGN LANGUAGE. Every one of these is assembled from the v2 vocabulary the canvas did
// establish: the 14px card, the trough inset, the four button tones, StatusBlock for every terminal
// state, TxRow for every hash, and the teal/amber split for routine-versus-considered. If a shape
// exists in the designed screens it is reused rather than re-drawn, so the modal reads as one
// product whichever tab you are on.
//
// PRESENTATIONAL ONLY, like everything else under v2/: props in, markup out. No wallet, no network.
//
// THE NO-JARGON RULE APPLIES HERE TOO. The shipped versions of these panels leak in the same way
// the move flow did — "outputs", "indexer", "UTXO", "self-signed, no daemon", "npub", raw
// base units. The copy below says what happens to the user's money and nothing about how.

import type { ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { C, MONO, tealBorder } from './tokens'
import { Alert, Check, Clock, Copy, Eye, Lock, Shield, Spinner } from './icons'
import {
  Body, Button, DetailCard, DetailRow, Panel, PanelText,
  SubHeader, TextField, TxRow,
} from './primitives'
import { fmt6, formatCooldown } from './format'

const XTR = (n: bigint) => `${fmt6(n)} XTR`

/**
 * A section heading, drawn OUTSIDE the card it introduces.
 *
 * V3 lifts these out of the cards they used to sit inside, and the reason is rhythm rather than
 * taste: with the heading inside, every card began with a row of text that pushed its first real
 * row down, so a page of three cards read as nine bands. Outside, the heading is the label and the
 * card is the content, and the page has three things on it.
 */
export function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 6px', marginBottom: -4 }}>
      <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: C.primary }}>{title}</span>
      {action}
    </div>
  )
}

// ══ FAUCET ════════════════════════════════════════════════════════════════════

export type FaucetPhase = 'idle' | 'locked' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error' | 'cooldown' | 'plenty'


export interface FaucetPanelProps {
  phase: FaucetPhase
  /** Shown on `done` when the landed amount is known. */
  received?: bigint
  /** The claim's own words about what it is doing. Wins over the per-phase line below. */
  message?: string
  onClaim: () => void
  /**
   * Milliseconds left on the cooldown, for the countdown in 10g.
   *
   * OUR OWN THROTTLE, NOT THE FAUCET'S. Caravel declines to re-claim for 60s after a successful
   * one; the faucet server has its own rate limit and we do not know it. So this counts down to
   * when the CLAIM BUTTON returns, which is a fact about this app, and not to when the faucet will
   * certainly serve — which nobody here knows. Undefined falls back to a line with no number, so a
   * missing timer can never render a dangling "Next claim available in".
   */
  cooldownRemainingMs?: number
}

/**
 * The extras-row card.
 *
 * ONE SHELL FOR the @name entry — a tile, two lines, and one control on the right. The faucet had
 * this shape too until V3 gave it its own frame; anything that needs more than this is not an
 * entry point.
 */
function ExtraCard({ tile, title, sub, right, muted = false }: {
  tile: ReactNode; title: ReactNode; sub: ReactNode; right?: ReactNode; muted?: boolean
}) {
  return (
    <div style={{
      border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 'var(--r-lg)',
      padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12,
      opacity: muted ? 0.75 : 1,
    }}>
      <span style={{
        width: 34, height: 34, borderRadius: 'var(--r-md)', flexShrink: 0,
        background: 'var(--accent-wash)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, fontWeight: 600,
      }}>{tile}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 1, lineHeight: 1.45 }}>{sub}</div>
      </div>
      {right}
    </div>
  )
}

/** The card's own small button. Accent for the one action worth taking, quiet for everything else. */
function CardAction({ tone, onClick, children }: {
  tone: 'primary' | 'quiet' | 'dead'; onClick?: () => void; children: ReactNode
}) {
  const dead = tone === 'dead'
  return (
    <span
      role={dead ? undefined : 'button'} tabIndex={dead ? -1 : 0} aria-disabled={dead}
      onClick={dead ? undefined : onClick}
      onKeyDown={e => { if (!dead && e.key === 'Enter') onClick?.() }}
      style={{
        padding: '8px 14px', borderRadius: 9, fontSize: 12.5, fontWeight: 600,
        flexShrink: 0, userSelect: 'none', whiteSpace: 'nowrap',
        cursor: dead ? 'default' : 'pointer',
        background: tone === 'primary' ? 'var(--accent-400)' : 'transparent',
        color: tone === 'primary' ? '#FFFFFF' : dead ? C.mutedDim : C.primary,
        border: tone === 'primary' ? 'none' : `1px solid var(--border${dead ? '' : '-strong'})`,
      }}
    >{children}</span>
  )
}

const FAUCET_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12M12 15l-4-4M12 15l4-4" /><path d="M5 21h14" />
  </svg>
)

/**
 * The testnet faucet — V3 series 10, all phases in one card.
 *
 * A TEMPORARY HELPER, DRAWN QUIETLY. It exists only while Caravel runs on Esmeralda, and it sits
 * in the extras slot at the foot of the overview. One shell for every phase: the tile and the
 * title never move, and only the line and the right-hand slot change — so the card never appears
 * to become a different component while a claim runs.
 *
 * NO PHASE IS AN ERROR EXCEPT `error`. `lagging` is a claim that committed and a balance that is
 * behind; `cooldown` and `plenty` are the faucet declining, which is what a faucet is for. All
 * three keep the same quiet card as `idle` — the design draws no dimming and none is added.
 *
 * `message` is the live text the claim itself emits, and it wins over the per-phase line: the
 * machine's own words about what it is doing beat a generic caption.
 */
export function FaucetPanel({ phase, received, message, onClaim, cooldownRemainingMs }: FaucetPanelProps) {
  const spinning = phase === 'claiming' || phase === 'verifying' || phase === 'lagging'
  const counting = phase === 'cooldown' && cooldownRemainingMs !== undefined && cooldownRemainingMs > 0

  const line = (): string => {
    switch (phase) {
      case 'idle': return 'Claim free test funds to try Caravel.'
      // The wallet is locked. Calm and buttonless — the line is the explanation, so there is no
      // dead control needing one.
      case 'locked': return 'Unlock your wallet to claim.'
      case 'claiming': return 'Claiming'
      case 'verifying': return 'Confirming your claim on chain.'
      case 'done': return received !== undefined ? `${XTR(received)} received.` : 'Funds received.'
      // NOT AN ERROR. The claim committed; only the balance is behind.
      case 'lagging': return 'Taking longer than usual. Funds will arrive.'
      // "Nothing was claimed" is kept over the frame's shorter line: on the one phase where
      // something went wrong, whether it went wrong BEFORE or AFTER the money moved is the only
      // thing the reader actually wants to know.
      case 'error': return 'The faucet did not respond. Nothing was claimed.'
      // The fragment is completed by the countdown beside it, so it is only used when there IS one.
      case 'cooldown': return counting ? 'Next claim available in' : 'Just claimed. You can claim again shortly.'
      case 'plenty': return 'You already have plenty. Leave the rest for other testers.'
    }
  }

  const right = () => {
    if (spinning) {
      return <span style={{
        width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
        border: '2px solid var(--border)', borderTopColor: 'var(--accent-400)',
        animation: 'cv-spin 1s linear infinite',
      }} />
    }
    if (phase === 'done') {
      return (
        <span style={{
          width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
          background: 'rgba(var(--positive-rgb),0.12)', color: 'var(--positive)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}><Check size={11} color="currentColor" /></span>
      )
    }
    if (phase === 'error') return <FaucetAction tone="quiet" onClick={onClaim}>Retry</FaucetAction>
    if (counting) {
      return (
        <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.mutedDim, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {formatCooldown(cooldownRemainingMs!)}
        </span>
      )
    }
    // `plenty`, `locked` and a countdown-less `cooldown` offer nothing: the faucet is declining and
    // the line says so. A disabled button would be a control that cannot be used and does not need
    // to exist — the sentence beside it already carries the reason.
    if (phase === 'idle') return <FaucetAction tone="primary" onClick={onClaim}>Claim</FaucetAction>
    return null
  }

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
      padding: '14px 16px', boxShadow: 'var(--e1)', boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', gap: 12, minHeight: 44,
    }}>
      <span style={{
        width: 32, height: 32, borderRadius: 9, flexShrink: 0,
        background: 'var(--accent-wash)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{FAUCET_ICON}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.primary }}>Testnet faucet</div>
        <div style={{ fontSize: 12, color: C.mutedDim, marginTop: 1, lineHeight: 1.45, textWrap: 'pretty' }}>
          {message ?? line()}
        </div>
      </div>
      {right()}
    </div>
  )
}

/** The faucet card's small action — V3 sizing, distinct from the @name card's CardAction. */
function FaucetAction({ tone, onClick, children }: {
  tone: 'primary' | 'quiet'; onClick: () => void; children: ReactNode
}) {
  const primary = tone === 'primary'
  return (
    <span
      role="button" tabIndex={0} onClick={onClick} onKeyDown={e => e.key === 'Enter' && onClick()}
      className={primary ? undefined : 'cv-quiet-btn'}
      style={{
        padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
        flexShrink: 0, userSelect: 'none', whiteSpace: 'nowrap', cursor: 'pointer',
        background: primary ? 'var(--accent-400)' : 'var(--surface)',
        color: primary ? '#FFFFFF' : C.primary,
        border: primary ? '1px solid transparent' : '1px solid var(--border-strong)',
      }}
    >{children}</span>
  )
}

/**
 * The @name entry point, collapsed.
 *
 * `claimed` is a FACT ABOUT THE CHAIN, not about this session: the card has to be able to say "you
 * already have one" to somebody who registered months ago on another device, so the owning name is
 * looked up rather than remembered. See OnsRegisterPanel.
 */
export function NameCard({ claimedName, onClaim, loading }: {
  claimedName: string | null
  onClaim: () => void
  loading?: boolean
}) {
  if (claimedName) {
    return (
      <ExtraCard
        tile="@"
        title={`@${claimedName}`}
        sub="Registered to this wallet."
        right={
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px',
            borderRadius: 'var(--r-pill)', background: 'rgba(var(--positive-rgb),0.12)',
            color: 'var(--positive)', fontSize: 11.5, fontWeight: 600, flexShrink: 0,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: 'var(--r-pill)', background: 'var(--positive)' }} />
            Registered
          </span>
        }
      />
    )
  }
  return (
    <ExtraCard
      tile="@"
      title="Claim your @name"
      sub="One identity for payments and messages."
      right={loading ? <Spinner size={15} /> : <CardAction tone="quiet" onClick={onClaim}>Claim</CardAction>}
    />
  )
}


// ══ SEND ══════════════════════════════════════════════════════════════════════

/**
 * WHERE THE MONEY IS SPENT FROM. The destination is always the recipient's stealth address, so this
 * changes the sender's side only — which transaction is built, what the fee is, and crucially what
 * is publicly visible about the payment.
 */
export type SendSource = 'private' | 'public'

export type SendView =
  | {
      step: 'form'; recipient: string; amount: string; note: string
      available: bigint | null; canReview: boolean; error?: string
      /**
       * What is uncertain about `available` — and therefore about MAX.
       *
       * The total refuses to show a number on an incomplete scan; MAX drew from the same truncated
       * set and offered a figure without comment, so the same modal made two different claims about
       * the same balance. This is the second one owning up.
       */
      availabilityNote?: string
      source: SendSource
      /** Both balances are funded, so the choice is real. When false the toggle is not shown. */
      canChooseSource: boolean
    }
  | {
      step: 'review'; recipient: string; amountMicrotari: bigint; note: string
      source: SendSource
      feeMicrotari: bigint | null
      /**
       * The fee is a CEILING, not a measurement.
       *
       * The move flow prices itself before review, so it shows an exact figure. A send does its dry
       * run inside submission and has no prepare/submit split, so before confirming, a ceiling is
       * the only honest thing we can say — and saying it as though it were exact would be a
       * quieter kind of lie. The success screen then shows what was actually paid.
       */
      feeIsCeiling?: boolean
    }
  /** `recipient` is display-only — the V3 frame names who the payment is going to while it runs. */
  | { step: 'sending'; recipient: string; amountMicrotari: bigint; progress: string; source: SendSource }
  /**
   * BROADCAST AND COMMITTED — the balance has not caught up yet.
   *
   * The send used to jump from 'sending' straight to 'Sent' while a settle loop ran invisibly
   * underneath, so the screen said the payment was done and the balance behind it still showed the
   * old figure, for up to a minute, with nothing to explain the gap. The move flow has always shown
   * this window. Same shape, same honesty: the payment IS finished, only the index is behind.
   */
  | {
      step: 'settling'; recipient: string; amountMicrotari: bigint; feeMicrotari: bigint; txId: string
    }
  | {
      step: 'success'; recipient: string; amountMicrotari: bigint; feeMicrotari: bigint; txId: string
      /** The settle deadline passed. STILL A SUCCESS — different copy, same shape. */
      lagged?: boolean
    }
  | { step: 'error'; message: string }
  /** Broadcast but undecided. NOT a failure — the send may still land, so it must not read as one. */
  | { step: 'unconfirmed'; message: string; txId: string }

export interface SendPanelProps {
  view: SendView
  hidden: boolean
  onSource: (s: SendSource) => void
  onRecipient: (v: string) => void
  onAmount: (v: string) => void
  onNote: (v: string) => void
  onMax: () => void
  onReview: () => void
  onBack: () => void
  onConfirm: () => void
  onDone: () => void
  onRetry: () => void
  onCopyTx: (t: string) => void
  onViewActivity: () => void
  /** Dismisses the whole sheet. The panel draws its own ✕, so it needs the sheet's close. */
  onClose?: () => void
}

const shortAddr = (a: string) => (a.length > 26 ? `${a.slice(0, 14)}…${a.slice(-6)}` : a)

// ── The V3 sheet chrome ──────────────────────────────────────────────────────
//
// Send and Receive both render `bare` (see Sheet): no title bar, no divider, no outer padding. The
// V3 frames draw one card with the title INSIDE it at 21px and a 28px close box on the same line —
// and the five send-outcome frames draw no header at all, just a centred column. Neither shape
// fits a fixed sheet header, so the panel owns its chrome and the Sheet keeps only what it is
// actually good for: the backdrop, Esc, and refusing to close mid-broadcast.

export const CARD = { padding: 32 } as const
export const OUTCOME_CARD = { padding: '48px 32px', textAlign: 'center' as const }

export function SheetHeader({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ flex: 1, fontSize: 21, fontWeight: 600, letterSpacing: '-0.015em', color: C.primary }}>{title}</span>
      {onClose && (
        <button
          onClick={onClose} aria-label="Close" className="cv-icon-btn"
          style={{
            cursor: 'pointer', width: 28, height: 28, borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--surface)', color: C.mutedDim,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  )
}

/** A field label. Sentence case at 13px, per the V3 frames. */
export function Label({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 500, color: C.bodyDim }}>{children}</div>
}

/**
 * A send input.
 *
 * Its own shell rather than TextField's: TextField sits on the recessed trough with 13px radius,
 * which is the move flow's treatment and is not changing this pass. These sit on the CARD with a
 * strong hairline, per the V3 frames. `.cv-field` carries the focus ring the design specifies.
 */
function SendInput({ value, onChange, placeholder, mono, ariaLabel, invalid }: {
  value: string; onChange: (v: string) => void; placeholder: string
  mono?: boolean; ariaLabel: string; invalid?: boolean
}) {
  return (
    <input
      value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      spellCheck={false} aria-label={ariaLabel} className="cv-field"
      style={{
        width: '100%', boxSizing: 'border-box', marginTop: 8,
        border: invalid ? '1px solid var(--danger-500)' : '1px solid var(--border-strong)',
        borderRadius: 10, padding: '12px 14px', outline: 'none',
        fontFamily: mono ? MONO : 'inherit', fontSize: 13.5,
        color: C.primary, background: 'var(--surface)',
      }}
    />
  )
}

/**
 * "Spend from" — shown only when both balances can actually fund a payment.
 *
 * A toggle offering an option that cannot work is worse than no toggle, so when only one side is
 * funded the caller uses it silently and this never renders. EXPLICIT EITHER WAY: nothing here ever
 * falls back to the other balance on its own, and the review screen restates which one was used.
 */
function SourceToggle({ source, onSource }: { source: SendSource; onSource: (s: SendSource) => void }) {
  const opt = (kind: SendSource, label: string, Icon: typeof Shield) => {
    const on = kind === source
    return (
      <span role="radio" tabIndex={0} aria-checked={on}
        onClick={() => onSource(kind)} onKeyDown={e => e.key === 'Enter' && onSource(kind)}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          padding: '9px 6px', borderRadius: 8, cursor: 'pointer', userSelect: 'none',
          fontSize: 13, fontWeight: on ? 600 : 500,
          background: on ? 'var(--accent-400)' : 'transparent',
          color: on ? '#FFFFFF' : C.bodyDim,
        }}>
        <Icon size={12} color="currentColor" />{label}
      </span>
    )
  }
  return (
    <div style={{ marginTop: 24 }}>
      <Label>Spend from</Label>
      <div style={{
        display: 'flex', gap: 3, padding: 3, borderRadius: 10, marginTop: 8,
        background: 'var(--surface-void)', border: '1px solid var(--border)',
      }}>
        {opt('private', 'Private funds', Lock)}
        {opt('public', 'Public funds', Eye)}
      </div>
    </div>
  )
}

/**
 * What is actually true about this payment's privacy, per source.
 *
 * THE RECIPIENT'S SIDE IS PRIVATE EITHER WAY — value lands as a confidential output at their
 * stealth address regardless of where it came from. What changes is the SENDER's side: spending
 * from the public balance is a plain `withdraw` naming this account and a readable amount, so an
 * observer learns this account paid out that much. Both lines say which of those is happening.
 *
 * ── TWO STATES, ONE TREATMENT ────────────────────────────────────────────────
 *
 * Identical length, identical colour, identical weight — only the icon and the noun change. The
 * public line used to run three times longer and carry an amber emphasis, and that was a category
 * error: the user has just chosen "Public funds" from a toggle giving both options equal weight,
 * and answering that choice with a caution colour frames a deliberate, legitimate decision as a
 * near-miss. Public is a STATE, not a warning.
 *
 * IT IS STILL A DISCLOSURE. "Visible on chain" is the whole of what a public spend reveals about
 * the sender, said plainly. Nothing was softened to make it shorter — the long version's extra
 * clauses were reassurance and mechanism, not the fact itself.
 *
 * The design only draws the private line; the public one is ours, built to the same measure.
 */
function PrivacyNote({ source }: { source: SendSource }) {
  const isPrivate = source === 'private'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginTop: 24,
      justifyContent: 'center', textAlign: 'center',
    }}>
      {isPrivate
        ? <Shield size={12} color={C.mutedDim} />
        : <Eye size={12} color={C.mutedDim} />}
      <span style={{ fontSize: 12.5, color: C.mutedDim, lineHeight: 1.5, textWrap: 'pretty' }}>
        {isPrivate
          ? 'Private. The amount and your address stay hidden.'
          : 'Public. Your spend is visible on chain.'}
      </span>
    </div>
  )
}

/**
 * The amount field, as the V3 frames draw it: a label row carrying the available balance and a
 * Max link, a tall bordered box with the figure at 32px, and one line beneath for whatever
 * qualifies it.
 *
 * ONE COMPONENT FOR SEND AND FOR THE MOVE FLOW. The frames draw the same field in 2a, 4a and 5a,
 * and the two flows sat side by side with hand-kept copies of it for exactly as long as it took to
 * notice. What differs between them is the WORDS — "Available" versus "Available public" — which
 * is what `availableLabel` is for.
 *
 * `note` and `error` share one slot and the error wins, because they answer the same question and
 * an error is the more urgent answer. The move flow's fee-reserve remainder arrives as `note`.
 */
export function AmountBlock({ value, onChange, onMax, availableLabel, availableValue, note, error, readOnly, mt = 24 }: {
  value: string
  onChange: (v: string) => void
  onMax: () => void
  availableLabel: string
  availableValue: ReactNode
  note?: ReactNode
  error?: ReactNode
  readOnly?: boolean
  mt?: number
}) {
  return (
    <div style={{ marginTop: mt }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <Label>Amount</Label>
        <span style={{ fontSize: 12, color: C.mutedDim, whiteSpace: 'nowrap' }}>
          {availableLabel} <span style={{ fontFamily: MONO }}>{availableValue}</span>
          {' · '}
          <span role="button" tabIndex={0} onClick={onMax} onKeyDown={e => e.key === 'Enter' && onMax()}
            style={{ fontWeight: 500, color: 'var(--accent-ink)', cursor: 'pointer', userSelect: 'none' }}>Max</span>
        </span>
      </div>
      <div className="cv-field" style={{
        display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8,
        border: error ? '1px solid var(--danger-500)' : '1px solid var(--border-strong)',
        borderRadius: 12, padding: '18px 16px',
      }}>
        <input
          value={value} onChange={e => onChange(e.target.value)} readOnly={readOnly}
          inputMode="decimal" placeholder="0.00" aria-label="Amount in XTR"
          style={{
            flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', padding: 0,
            fontFamily: 'inherit', fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em',
            fontFeatureSettings: "'tnum'", color: C.primary,
          }}
        />
        <span style={{ fontSize: 14, fontWeight: 600, color: C.mutedDim, flexShrink: 0 }}>XTR</span>
      </div>
      {error
        ? <div style={{ fontSize: 12, color: C.dangerText, marginTop: 10, lineHeight: 1.5 }}>{error}</div>
        : note
          ? <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 10, lineHeight: 1.5 }}>{note}</div>
          : null}
    </div>
  )
}

/** The full-width action at the foot of a card. */
export function ActionButton({ tone, onClick, children, mt = 16 }: {
  tone: 'primary' | 'quiet' | 'disabled'; onClick?: () => void; children: ReactNode; mt?: number
}) {
  const dead = tone === 'disabled'
  return (
    <span
      role="button" tabIndex={dead ? -1 : 0} aria-disabled={dead}
      onClick={dead ? undefined : onClick}
      onKeyDown={e => { if (!dead && e.key === 'Enter') onClick?.() }}
      className={tone === 'quiet' ? 'cv-quiet-btn' : undefined}
      style={{
        display: 'block', textAlign: 'center', marginTop: mt, padding: 13,
        borderRadius: 10, fontSize: 14, fontWeight: 600,
        cursor: dead ? 'not-allowed' : 'pointer', userSelect: 'none',
        background: tone === 'primary' ? 'var(--accent-400)' : 'transparent',
        border: tone === 'primary' ? '1px solid transparent' : '1px solid var(--border-strong)',
        color: tone === 'primary' ? '#FFFFFF' : dead ? C.mutedDim : C.primary,
        opacity: dead ? 0.55 : 1,
      }}
    >{children}</span>
  )
}

/**
 * The shape all five terminal states share: a circled emblem, a headline, a line of prose, and
 * whatever that particular outcome can offer you next.
 */
export function Outcome({ emblem, title, sub, children }: {
  emblem: ReactNode; title: string; sub: ReactNode; children?: ReactNode
}) {
  return (
    <div style={OUTCOME_CARD}>
      {emblem}
      <div style={{ fontSize: 17, fontWeight: 600, color: C.primary, marginTop: 16 }}>{title}</div>
      <div style={{ fontSize: 13, color: C.mutedDim, marginTop: 6, lineHeight: 1.55, textWrap: 'pretty' }}>{sub}</div>
      {children}
    </div>
  )
}

/** The circled emblem. `tone` is the only thing that separates a success from a failure here. */
export function Emblem({ tone, children }: { tone: 'positive' | 'accent' | 'danger'; children: ReactNode }) {
  const skin = {
    positive: { bg: 'rgba(var(--positive-rgb),0.12)', ink: 'var(--positive)' },
    accent: { bg: 'var(--accent-wash)', ink: 'var(--accent-ink)' },
    danger: { bg: 'rgba(var(--danger-rgb),0.12)', ink: 'var(--danger-500)' },
  }[tone]
  return (
    <span style={{
      width: 40, height: 40, borderRadius: '50%', background: skin.bg, color: skin.ink,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    }}>{children}</span>
  )
}

/** A monospace receipt line — the fee actually paid, and the transaction it was paid on. */
function Receipt({ fee, txId, onCopy }: { fee: bigint; txId: string; onCopy: () => void }) {
  const short = txId.length > 14 ? `${txId.slice(0, 6)}…${txId.slice(-6)}` : txId
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      marginTop: 18, fontFamily: MONO, fontSize: 11, color: C.faint, flexWrap: 'wrap',
    }}>
      <span>fee {fmt6(fee)} XTR</span>
      <span aria-hidden="true">·</span>
      <span
        role="button" tabIndex={0} onClick={onCopy} onKeyDown={e => e.key === 'Enter' && onCopy()}
        aria-label="Copy transaction id"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
      >tx {short}<Copy size={11} color="currentColor" /></span>
    </div>
  )
}

export function SendPanel({ view, hidden, onSource, onRecipient, onAmount, onNote, onMax, onReview, onBack, onConfirm, onDone, onRetry, onCopyTx, onViewActivity, onClose }: SendPanelProps) {
  // ══ 2a · FORM ══════════════════════════════════════════════════════════════
  if (view.step === 'form') {
    return (
      <div style={CARD}>
        <SheetHeader title="Send" onClose={onClose} />

        <div style={{ marginTop: 28 }}>
          <Label>To</Label>
          <SendInput value={view.recipient} onChange={onRecipient} placeholder="@name or Ootle address" mono ariaLabel="Recipient" />
        </div>

        {view.canChooseSource && <SourceToggle source={view.source} onSource={onSource} />}

        <AmountBlock
          value={hidden ? '••••••' : view.amount} onChange={onAmount} readOnly={hidden}
          // NAMED ONLY WHEN THE TOGGLE IS NOT THERE TO NAME IT. With the segmented control directly
          // above showing Private or Public selected, repeating the word here is the same fact
          // twice; without it, this label is the only thing saying which balance the figure is.
          availableLabel={view.canChooseSource ? 'Available' : view.source === 'private' ? 'Private available' : 'Public available'}
          availableValue={hidden ? '••••••' : view.available !== null ? `${fmt6(view.available)} XTR` : '—'}
          onMax={onMax}
          error={view.error}
          // MAX owning up to a truncated scan — the total refuses to show a number on one, and MAX
          // draws from the same set.
          note={view.availabilityNote}
        />

        <div style={{ marginTop: 24 }}>
          <Label>Note <span style={{ fontWeight: 400, color: C.mutedDim }}>· optional, private</span></Label>
          <SendInput value={view.note} onChange={onNote} placeholder="Only you and the recipient can see this" ariaLabel="Note" />
        </div>

        <PrivacyNote source={view.source} />

        <ActionButton tone={view.canReview ? 'primary' : 'disabled'} onClick={view.canReview ? onReview : undefined}>
          Review payment
        </ActionButton>
      </div>
    )
  }

  // ══ 2b · REVIEW ════════════════════════════════════════════════════════════
  if (view.step === 'review') {
    const pricing = view.feeMicrotari === null
    const isPrivate = view.source === 'private'
    return (
      <div style={CARD}>
        <SheetHeader title="Review" onClose={onClose} />

        <div style={{ textAlign: 'center', marginTop: 28 }}>
          <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em', fontFeatureSettings: "'tnum'", color: C.primary }}>
            {fmt6(view.amountMicrotari)} <span style={{ fontSize: 16, fontWeight: 600, color: C.mutedDim }}>XTR</span>
          </div>
          <div style={{ fontSize: 13.5, color: C.bodyDim, marginTop: 8 }}>
            to <span style={{ fontFamily: MONO, fontWeight: 500, color: C.primary, fontSize: 12 }}>{shortAddr(view.recipient)}</span>
          </div>
        </div>

        <div style={{
          display: 'flex', flexDirection: 'column', gap: 11, fontSize: 13.5,
          marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ color: C.mutedDim }}>From</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500, color: C.primary }}>
              {isPrivate ? <Lock size={11} color="var(--accent-ink)" /> : <Eye size={11} color={C.mutedDim} />}
              {isPrivate ? 'Private funds' : 'Public funds'}
            </span>
          </div>
          {/* A CEILING IS NOT A MEASUREMENT. The private path dry-runs inside submission, so before
              confirming there is no exact figure to give — and presenting the ceiling as though
              there were would be a quieter kind of lie than showing no fee at all. The public path
              prices itself before review, so it states the fee flatly. The LABEL carries the
              difference; the note below spells it out. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ color: C.mutedDim }}>{view.feeIsCeiling ? 'Fee, at most' : 'Network fee'}</span>
            <span style={{ fontFamily: MONO, fontWeight: 500, color: C.primary }}>
              {pricing
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit', color: C.faint }}><Spinner size={12} />Pricing…</span>
                : `${fmt6(view.feeMicrotari!)} XTR`}
            </span>
          </div>
        </div>

        {view.feeIsCeiling && !pricing && (
          <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 12, textAlign: 'center' }}>
            The exact fee is known once it settles.
          </div>
        )}

        {view.note && (
          <div style={{
            marginTop: 16, padding: '12px 14px', borderRadius: 10,
            background: 'var(--surface-void)', border: '1px dashed var(--border-strong)',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: C.faintDim, marginBottom: 6 }}>PRIVATE NOTE</div>
            <div style={{ fontSize: 13, color: 'var(--text-note)', fontStyle: 'italic' }}>“{view.note}”</div>
          </div>
        )}

        <ActionButton tone={pricing ? 'disabled' : 'primary'} onClick={pricing ? undefined : onConfirm} mt={20}>Send</ActionButton>
        <ActionButton tone="quiet" onClick={onBack} mt={8}>Back</ActionButton>
      </div>
    )
  }

  // ══ 2c · SENDING ═══════════════════════════════════════════════════════════
  //
  // The one state the sheet will not close over — see WalletModalV2. Nothing here can call a
  // broadcast back, so there is no close control to offer.
  if (view.step === 'sending') {
    return (
      <div style={OUTCOME_CARD}>
        <Spinner size={28} ring={3} />
        <div style={{ fontSize: 17, fontWeight: 600, color: C.primary, marginTop: 18 }}>Sending</div>
        <div style={{ fontSize: 13, color: C.mutedDim, marginTop: 6 }}>
          {fmt6(view.amountMicrotari)} XTR to <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{shortAddr(view.recipient)}</span>
        </div>
        {/* The builder's own words about which step it is on. Kept below the headline rather than
            replacing it, so the screen does not appear to change state on every progress tick. */}
        <div style={{ fontSize: 12, color: C.faint, marginTop: 14, lineHeight: 1.5 }}>{view.progress}</div>
      </div>
    )
  }

  // ══ 2d · SETTLING ══════════════════════════════════════════════════════════
  //
  // NO AMOUNT, NO FEE, NO TX — a spinner and a caption, and that is the whole frame.
  //
  // The payment is FINISHED; what is behind is the index. This is the same window the move flow
  // shows and the same rule the balance hero follows while settling: the screen says what is
  // happening and stops there. Every figure it used to carry reappears intact on the success card
  // one state later, which is where the payment is actually reported.
  if (view.step === 'settling') {
    return (
      <div style={OUTCOME_CARD}>
        <Spinner size={28} ring={3} />
        <div style={{ fontSize: 17, fontWeight: 600, color: C.primary, marginTop: 18 }}>Settling</div>
        <div style={{ fontSize: 13, color: C.mutedDim, marginTop: 6 }}>This can take a moment.</div>
      </div>
    )
  }

  // ══ 2e · SENT ══════════════════════════════════════════════════════════════
  if (view.step === 'success') {
    return (
      <Outcome
        emblem={<Emblem tone="positive"><Check size={18} color="currentColor" /></Emblem>}
        title="Sent"
        sub={<>
          <span style={{ fontFamily: MONO }}>{fmt6(view.amountMicrotari)} XTR</span> to{' '}
          <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{shortAddr(view.recipient)}</span>
          {/* A passed settle deadline is STILL A SUCCESS. The payment committed; only the balance
              behind this card is behind, so the extra sentence explains the stale figure rather
              than casting doubt on the send. */}
          {view.lagged && <><br />Confirmed on the network — your balance hasn’t caught up yet. Nothing is at risk.</>}
        </>}
      >
        {/* THE OTHER HALF OF THE CEILING. Review could only promise "at most"; this is what was
            actually paid, and dropping it would leave a private send with no place that ever
            states its real fee. */}
        <Receipt fee={view.feeMicrotari} txId={view.txId} onCopy={() => onCopyTx(view.txId)} />
        <ActionButton tone="quiet" onClick={onDone} mt={24}>Done</ActionButton>
      </Outcome>
    )
  }

  // ══ 2f · UNCONFIRMED ═══════════════════════════════════════════════════════
  //
  // A NORMAL OUTCOME, NOT A FAILURE. Broadcast and undecided is ordinary on this network: the
  // payment may still land, nothing has failed, and nothing needs re-sending. It wears the ACCENT
  // wash and a clock. It must never take the danger tone — the red card is reserved for the one
  // case where nothing left the wallet, and this is not that case.
  if (view.step === 'unconfirmed') {
    return (
      <Outcome
        emblem={<Emblem tone="accent"><Clock size={17} color="currentColor" /></Emblem>}
        title="Sent, not yet confirmed"
        sub="The recipient may need to come online. It will confirm on its own."
      >
        {/* The one identifier an undecided payment has. It must stay reachable from here — this
            card is the last place the transaction is named before it becomes a row in Activity. */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          marginTop: 18, fontFamily: MONO, fontSize: 11, color: C.faint,
        }}>
          <span
            role="button" tabIndex={0} onClick={() => onCopyTx(view.txId)}
            onKeyDown={e => e.key === 'Enter' && onCopyTx(view.txId)}
            aria-label="Copy transaction id"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
          >tx {view.txId.length > 14 ? `${view.txId.slice(0, 6)}…${view.txId.slice(-6)}` : view.txId}<Copy size={11} color="currentColor" /></span>
        </div>
        <ActionButton tone="quiet" onClick={onDone} mt={24}>Done</ActionButton>
        <span
          role="button" tabIndex={0} onClick={onViewActivity} onKeyDown={e => e.key === 'Enter' && onViewActivity()}
          style={{
            display: 'block', marginTop: 12, fontSize: 12.5, fontWeight: 500,
            color: 'var(--accent-ink)', cursor: 'pointer', userSelect: 'none',
          }}
        >View in Activity</span>
      </Outcome>
    )
  }

  // ══ 2g · ERROR ═════════════════════════════════════════════════════════════
  return (
    <Outcome
      emblem={<Emblem tone="danger">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </Emblem>}
      title="Send failed"
      sub="Nothing left your wallet."
    >
      {/* THE NETWORK'S OWN WORDS, VERBATIM. The frame does not draw this, and it stays anyway: a
          paraphrased error is unreportable, and "Send failed" alone gives a user nothing to paste
          into an issue. Set small and quiet so it explains without alarming. */}
      <div style={{ marginTop: 18, textAlign: 'left' }}>
        <VerbatimBox>{view.message}</VerbatimBox>
      </div>
      <ActionButton tone="primary" onClick={onRetry} mt={16}>Try again</ActionButton>
      <span
        role="button" tabIndex={0} onClick={onDone} onKeyDown={e => e.key === 'Enter' && onDone()}
        style={{
          display: 'block', marginTop: 12, fontSize: 12.5, fontWeight: 500,
          color: C.mutedDim, cursor: 'pointer', userSelect: 'none',
        }}
      >Close</span>
    </Outcome>
  )
}

export function VerbatimBox({ children }: { children: ReactNode }) {
  return (
    <div style={{
      padding: '13px 15px', borderRadius: 'var(--r-md)', background: C.errorGround,
      border: '1px solid rgba(var(--danger-rgb),0.28)', fontFamily: MONO, fontSize: 11.5,
      lineHeight: 1.65, color: C.dangerText, overflowWrap: 'anywhere',
      userSelect: 'text', cursor: 'text', maxHeight: 180, overflowY: 'auto',
    }}>{children}</div>
  )
}

// ══ RECEIVE ═══════════════════════════════════════════════════════════════════

/**
 * Receive.
 *
 * ── TWO STATES, ONE CARD ─────────────────────────────────────────────────────
 *
 * `address` is null until the account is resolved after unlock, which is frame 3a; once it exists,
 * 3b. Nothing here derives anything — the address arrives from WalletContext, already resolved by
 * the same path the send review and the profile panel read. This file only draws it. The plate is
 * 180 square in both states so the card does not jump when the address lands.
 *
 * ── THE QR AND THE CLIPBOARD CARRY THE FULL ADDRESS ─────────────────────────
 *
 * The address is shown TRUNCATED, because 100-odd characters of base58 is not something anyone
 * reads and the design gives it one line. But truncation is a display concern and nothing else:
 * `QRCodeSVG` encodes `address` and the copy button copies `address`, both in full. A scannable
 * code or a clipboard holding an elided address would send funds nowhere recoverable, so the two
 * are deliberately fed from the value rather than from the label — and the full string stays in
 * `title` on the one span that elides it.
 *
 * The plate stays WHITE in both themes. A QR is read by contrast and its quiet zone has to be the
 * light side of it; a dark-grounded code in dark mode is a code most scanners refuse. This is one
 * of the few places where following the theme would break the thing the screen exists to do, so
 * the literal is correct rather than lazy.
 */
export function ReceivePanel({ address, copied, onCopy, onClose }: {
  address: string | null; copied: boolean; onCopy: () => void; onClose?: () => void
}) {
  const plate: React.CSSProperties = {
    width: 180, height: 180, borderRadius: 14, margin: '0 auto', boxSizing: 'border-box',
  }

  const header = <SheetHeader title="Receive" onClose={onClose} />

  // ══ 3a · PREPARING ═══════════════════════════════════════════════════════
  if (!address) {
    return (
      <div style={CARD}>
        {header}
        <div style={{ textAlign: 'center', padding: '44px 0 28px' }}>
          <div style={{
            ...plate, background: 'var(--surface-void)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Spinner size={24} ring={3} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, color: C.bodyDim, marginTop: 20 }}>
            Preparing your address
          </div>
        </div>
      </div>
    )
  }

  // ══ 3b · READY ═══════════════════════════════════════════════════════════
  return (
    <div style={CARD}>
      {header}
      <div style={{ textAlign: 'center', padding: '28px 0 0' }}>
        <div style={{ ...plate, background: '#FFFFFF', border: '1px solid var(--border)', padding: 14 }}>
          <QRCodeSVG value={address} size={152} bgColor="#FFFFFF" fgColor="#0A1322" level="M" />
        </div>
        {/* Display only — see the header. The full value is one hover away and one press away. */}
        <div title={address} style={{ fontFamily: MONO, fontSize: 12, color: C.bodyDim, marginTop: 18 }}>
          {shortAddr(address)}
        </div>
        <span
          role="button" tabIndex={0} onClick={onCopy} onKeyDown={e => e.key === 'Enter' && onCopy()}
          className="cv-quiet-btn"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 14,
            padding: '10px 20px', borderRadius: 10, fontSize: 13.5, fontWeight: 600,
            border: '1px solid var(--border-strong)', color: C.primary,
            cursor: 'pointer', userSelect: 'none',
          }}
        >
          <Copy size={13} color="currentColor" />{copied ? 'Copied' : 'Copy address'}
        </span>
        {/* Set to the same measure as the send form's privacy line — same size, same colour, same
            centred shield. The two sheets are a pair and should say their one true thing the same
            way. This is also where "shielded" last survived in the receive UI. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'center', marginTop: 18 }}>
          <Shield size={12} color={C.mutedDim} />
          <span style={{ fontSize: 12.5, color: C.mutedDim }}>Funds you receive arrive private by default.</span>
        </div>
      </div>
    </div>
  )
}

// ══ ONS — register a name ═════════════════════════════════════════════════════

export type OnsStatus = 'idle' | 'checking' | 'available' | 'taken' | 'estimating' | 'confirm' | 'registering' | 'done' | 'error'

export interface OnsPanelProps {
  status: OnsStatus
  name: string
  /** Policy problem with what has been typed — shown live, before any lookup. */
  policyError?: string
  message?: string
  feeMicrotari?: bigint
  txId?: string
  onName: (v: string) => void
  onCheck: () => void
  onRegister: () => void
  onConfirm: () => void
  onReset: () => void
  onCopyTx: (t: string) => void
}

/** A small positive dot, for a success headline. Lived in the faucet card until it was reskinned. */
const CheckDot = () => (
  <span style={{
    width: 18, height: 18, borderRadius: 'var(--r-pill)', flexShrink: 0,
    background: 'rgba(var(--positive-rgb),0.12)', color: 'var(--positive)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  }}><Check size={11} color="currentColor" /></span>
)

export function OnsPanel({ status, name, policyError, message, feeMicrotari, txId, onName, onCheck, onRegister, onConfirm, onReset, onCopyTx }: OnsPanelProps) {
  if (status === 'done') {
    return (
      <Panel tone="teal" titleColor={C.bright} title={<><CheckDot />@{name} is yours</>}>
        <PanelText color={C.tealLabel}>{message ?? 'People can now find you by name instead of an address.'}</PanelText>
        {txId && <div style={{ marginBottom: 12 }}><TxRow txId={txId} onCopy={() => onCopyTx(txId)} /></div>}
        <Button tone="neutral" onClick={onReset}>Register another</Button>
      </Panel>
    )
  }

  if (status === 'error') {
    return (
      <Panel tone="danger" titleColor={C.dangerText} title={<><Alert size={16} color={C.danger} />Couldn’t register that name</>}>
        <PanelText>{message ?? 'Something went wrong. Nothing was registered.'}</PanelText>
        <Button tone="neutral" onClick={onReset}>Try again</Button>
      </Panel>
    )
  }

  // Fee approved explicitly before anything is written — the same discipline as the move flow.
  if (status === 'confirm') {
    return (
      <Panel title={`Register @${name}`}>
        <PanelText>This writes your name to the network so people can pay you by it.</PanelText>
        <div style={{ marginBottom: 12 }}>
          <DetailCard><DetailRow label="Network fee" value={feeMicrotari !== undefined ? XTR(feeMicrotari) : '—'} last /></DetailCard>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button tone="neutral" flex={1} onClick={onReset}>Cancel</Button>
          <Button tone="primary" flex={2} onClick={onConfirm}>Register</Button>
        </div>
      </Panel>
    )
  }

  const busy = status === 'checking' || status === 'estimating' || status === 'registering'
  const busyLabel = status === 'checking' ? 'Checking…' : status === 'estimating' ? 'Checking the fee…' : 'Registering…'
  const tone = status === 'available' ? 'teal' : status === 'taken' ? 'amber' : 'neutral'

  return (
    <Panel tone={tone} title="Register a name" meta={status === 'available' ? 'available' : status === 'taken' ? 'taken' : undefined}
      metaColor={status === 'available' ? C.teal300 : status === 'taken' ? C.warn300 : undefined}>
      <PanelText>
        {status === 'available' ? `@${name} is free. Claim it before someone else does.`
          : status === 'taken' ? `@${name} is already registered. Try another.`
          : 'Pick a short name so people can pay you without copying an address.'}
      </PanelText>
      <div style={{ marginBottom: 12 }}>
        <TextField
          value={name} onChange={onName} placeholder="yourname" invalid={!!policyError} ariaLabel="Name to register"
          prefix={<span style={{ fontFamily: MONO, fontSize: 15, color: C.tealDim }}>@</span>}
        />
      </div>
      {policyError && <div style={{ fontSize: 12, color: C.dangerText, marginBottom: 12, lineHeight: 1.5 }}>{policyError}</div>}
      {busy ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 12, borderRadius: 'var(--r-md)', background: C.inset, border: tealBorder(0.22), color: C.teal300, fontSize: 14, fontWeight: 600 }}>
          <Spinner size={15} />{busyLabel}
        </div>
      ) : status === 'available' ? (
        <Button tone="primary" onClick={onRegister}>Register @{name}</Button>
      ) : (
        <Button tone={name && !policyError ? 'neutral' : 'disabled'} onClick={name && !policyError ? onCheck : undefined}>Check availability</Button>
      )}
    </Panel>
  )
}

// ══ ACTIVITY ══════════════════════════════════════════════════════════════════
//
// SAME CONTENT AND SAME BEHAVIOUR AS THE SHIPPED LIST, RESTYLED. The structure is not reinvented:
// rows still come from the two authoritative sources buildActivity() merges — wallet-modal sends
// and message-linked payments — never from the blind balance scan, because a private output carries
// no sender and the scan cannot tell an incoming payment from our own change.
//
// A RECEIVED ROW'S AMOUNT IS RESOLVED LAZILY, so it has its own little state machine and every one
// of those states is representable here: checking, resolved, already-spent, unreadable, and the
// indexer-lag case that may still resolve. The shipped list called these "Resolving", "Spent" and
// "Pending"; those are our words for our machinery, so they are said plainly instead.
//
// The hide toggle covers the amounts in this list too — the same gesture as the balance cards.

export type ActivityStatus =
  | 'confirmed' | 'sent' | 'failed' | 'unconfirmed'          // outflows
  | 'received' | 'checking' | 'spent' | 'unreadable' | 'pending'  // inflows

export interface ActivityRowView {
  id: string
  direction: 'out' | 'in'
  /** "Sent to otl_esm_1t…f4a2", "Received from npub1abcd…wxyz". Already shortened by the caller. */
  title: string
  note: string
  status: ActivityStatus
  /** null when the amount is not known here — another device's send, or still being checked. */
  amountMicrotari: bigint | null
}

/**
 * How each status is drawn.
 *
 * `signed` is the one that carries meaning rather than decoration: it says whether this row
 * represents value that actually moved. A failed send has an amount — the one that was attempted —
 * but nothing left the wallet, so it renders muted and WITHOUT a +/− rather than as an outflow that
 * happened. Inventing a sign there would be the same class of lie as inventing the figure.
 */
const STATUS: Record<ActivityStatus, {
  label: string
  ink: string
  wash: string
  signed: boolean
  settled: boolean
}> = {
  confirmed:   { label: 'Confirmed',   ink: 'var(--positive)',      wash: 'rgba(var(--positive-rgb),0.12)', signed: true,  settled: true },
  received:    { label: 'Received',    ink: 'var(--positive)',      wash: 'rgba(var(--positive-rgb),0.12)', signed: true,  settled: true },
  sent:        { label: 'Sent',        ink: 'var(--accent-ink)',    wash: 'var(--accent-wash)',             signed: true,  settled: true },
  checking:    { label: 'Checking',    ink: 'var(--accent-ink)',    wash: 'var(--accent-wash)',             signed: false, settled: false },
  // AMBER, NOT RED, for both. Broadcast-and-undecided and waiting-to-settle are ordinary outcomes
  // on this network: nothing failed, and nothing needs re-sending.
  unconfirmed: { label: 'Unconfirmed', ink: 'var(--warn)',          wash: 'rgba(var(--warn-rgb),0.12)',     signed: true,  settled: false },
  pending:     { label: 'Pending',     ink: 'var(--warn)',          wash: 'rgba(var(--warn-rgb),0.12)',     signed: true,  settled: false },
  failed:      { label: 'Failed',      ink: 'var(--danger-500)',    wash: 'rgba(var(--danger-rgb),0.12)',   signed: false, settled: false },
  spent:       { label: 'Spent',       ink: 'var(--text-muted-dim)', wash: 'var(--surface-void)',           signed: false, settled: false },
  unreadable:  { label: 'Unreadable',  ink: 'var(--text-muted-dim)', wash: 'var(--surface-void)',           signed: false, settled: false },
}

/**
 * Why the amount is a dash, per status.
 *
 * The dash is honest but mute, so the line under the title explains it — and explains it
 * DIFFERENTLY per case, because "still arriving" and "this wallet cannot read it" are not the same
 * news. Without this the note line simply repeated the status pill sitting beside it.
 */
const UNKNOWN_AMOUNT: Record<ActivityStatus, string> = {
  checking:    'Reading the amount',
  pending:     'Arrived — amount still resolving',
  unreadable:  'Arrived — amount not readable by this wallet',
  spent:       'Already spent',
  // An outflow with no amount is a send from another device: we know it happened, not its size.
  confirmed:   'Sent from another device',
  sent:        'Sent from another device',
  unconfirmed: 'Sent, not yet confirmed',
  failed:      'Nothing left your wallet',
  received:    'Amount not known here',
}

/** The glyph in the row's tile. Direction for the ordinary cases, state for the rest. */
function RowGlyph({ row }: { row: ActivityRowView }) {
  const st = STATUS[row.status]
  const stroke = st.ink
  const icon =
    row.status === 'failed'
      ? <path d="M18 6L6 18M6 6l12 12" />
    : row.status === 'checking' || row.status === 'pending' || row.status === 'unconfirmed'
      ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>
    : row.status === 'unreadable'
      ? <><circle cx="12" cy="12" r="9" /><path d="M12 16h.01M9.8 9.3a2.3 2.3 0 1 1 2.9 3.1V14" /></>
    : row.direction === 'in'
      ? <><path d="M17 7L7 17" /><path d="M15 17H7V9" /></>
      : <><path d="M7 17L17 7" /><path d="M9 7h8v8" /></>

  return (
    <span style={{
      width: 34, height: 34, borderRadius: 'var(--r-md)', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: st.wash, color: st.ink,
    }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
    </span>
  )
}

export function ActivityRowShell({ row, hidden }: { row: ActivityRowView; hidden: boolean }) {
  const st = STATUS[row.status]

  // A MISSING AMOUNT IS A DASH, NEVER A ZERO AND NEVER A GUESS. It is genuinely unknown here for a
  // send from another device and for an inflow still being resolved, and both are ordinary.
  //
  // THE ROW STILL RENDERS. An inbound payment whose amount could not be read is a payment that
  // arrived; dropping it would be the dishonest option, and inventing a figure worse still. The
  // dash says "something arrived, the amount is not known here" — and the line below says why,
  // rather than repeating the status pill back at the reader.
  const amount = () => {
    if (hidden) return '••••'
    if (row.amountMicrotari === null) return '—'
    const sign = st.signed ? (row.direction === 'in' ? '+' : '−') : ''
    return `${sign}${fmt6(row.amountMicrotari)}`
  }

  const amountColor =
    hidden ? C.bodyDim
    : row.amountMicrotari === null ? C.mutedDim
    : !st.signed ? C.mutedDim
    : row.direction === 'in' ? 'var(--positive)'
    : C.primary

  return (
    <div className="cv-activity-row" style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '11px 12px', borderRadius: 9,
    }}>
      <RowGlyph row={row} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.title}
        </div>
        <div style={{ fontSize: 12, color: C.mutedDim, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.note || (row.amountMicrotari === null && !hidden ? UNKNOWN_AMOUNT[row.status] : st.label)}
        </div>
      </div>
      {/* THE PILL IS FOR EXCEPTIONS ONLY.
          A settled send already says "Sent to otl_esm_1t…f4a2" on the title line, with an outward
          arrow in its tile and a signed amount on the right. A "Sent" pill between them is the
          fourth restatement of one fact, and when every row carries one the colour stops meaning
          anything — which is a real cost, because the rows that DO need it (unconfirmed, failed,
          still checking) are the ones a user is scanning for. So the ordinary outcomes drop it and
          the exceptional ones keep it, and now it reads as a flag rather than a decoration. */}
      {!st.settled && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', padding: '3px 9px', borderRadius: 'var(--r-pill)',
          background: st.wash, color: st.ink, fontSize: 10.5, fontWeight: 600, flexShrink: 0,
        }}>{st.label}</span>
      )}
      <span style={{
        fontFamily: MONO, fontSize: 12.5, fontWeight: 500, textAlign: 'right',
        flexShrink: 0, minWidth: 104, color: amountColor,
      }}>{amount()}</span>
    </div>
  )
}

/** Nothing has happened yet — said as a fact, with what will fill it. Never blank rows. */
export function ActivityEmpty({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{ textAlign: 'center', padding: compact ? '26px 20px' : '40px 24px' }}>
      <span style={{
        width: 40, height: 40, borderRadius: 12, background: 'var(--accent-wash)', color: 'var(--accent-ink)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12h4l3-8 4 16 3-8h4" />
        </svg>
      </span>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: C.primary, marginTop: 14 }}>No activity yet</div>
      <div style={{ fontSize: 12.5, color: C.mutedDim, marginTop: 4, lineHeight: 1.5, textWrap: 'pretty' }}>
        Your sends, receives, and shields will appear here.
      </div>
    </div>
  )
}

/**
 * The RECENT list, on the page.
 *
 * Three rows, newest first, whatever their kind — a shield and a receive sit together because they
 * are both things that happened to this wallet, and sorting by type would bury the most recent
 * event under a category. Fewer than three simply shows fewer; the empty case gets the same honest
 * card the full list does rather than padded blank rows.
 */
export function RecentActivity({ rows, onViewAll }: {
  rows: ReactNode[]; onViewAll: () => void
}) {
  const shown = rows.slice(0, 3)
  return (
    <>
      <SectionHead
        title="Recent activity"
        // Only offered when there is more than the page is showing — a "Show all" over three rows
        // of three would be a control that changes nothing.
        action={rows.length > shown.length && (
          <span role="button" tabIndex={0} onClick={onViewAll} onKeyDown={e => e.key === 'Enter' && onViewAll()}
            style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent-ink)', cursor: 'pointer', userSelect: 'none', flexShrink: 0 }}>
            Show all
          </span>
        )}
      />
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, padding: 5, boxShadow: 'var(--e1)',
      }}>
        {shown.length === 0 ? <ActivityEmpty compact /> : shown}
      </div>
    </>
  )
}

/** The FULL list, in an overlay. Same rows, no cap. */
export function ActivityPanel({ rows }: { rows: ReactNode[] }) {
  if (rows.length === 0) return <ActivityEmpty />
  return <div style={{ display: 'flex', flexDirection: 'column' }}>{rows}</div>
}


export { Body, SubHeader }
