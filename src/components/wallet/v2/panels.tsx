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
import { C, MONO, tealBorder, tealFill, warnBorder, warnFill } from './tokens'
import { Alert, Check, Clock, Copy, Eye, Shield, Spinner } from './icons'
import {
  AmountField, Body, Button, DetailCard, DetailRow, FieldLabel, Panel, PanelText,
  SettleBar, StatusBlock, SubHeader, TextField, TxRow,
} from './primitives'
import { fmt6 } from './format'

const XTR = (n: bigint) => `${fmt6(n)} XTR`

// ══ FAUCET ════════════════════════════════════════════════════════════════════

export type FaucetPhase = 'idle' | 'locked' | 'claiming' | 'verifying' | 'done' | 'lagging' | 'error' | 'cooldown' | 'plenty'

export interface FaucetPanelProps {
  phase: FaucetPhase
  /** Shown on `done` — what actually landed. */
  received?: bigint
  /** Shown on `plenty` — why the claim is discouraged. */
  balance?: bigint
  message?: string
  onClaim: () => void
  onRefresh: () => void
}

/**
 * The extras-row card.
 *
 * ONE SHELL FOR BOTH the faucet and the @name entry, because the design draws them as a matched
 * pair sitting side by side. A tile, two lines, and one control on the right — anything that needs
 * more than that is not an entry point.
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
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12M12 15l-4-4M12 15l4-4" /><path d="M5 21h14" />
  </svg>
)

/**
 * The testnet faucet.
 *
 * A TEMPORARY CARD, DRAWN QUIETLY. It exists only while Caravel runs on Esmeralda, and the design
 * asks for something that sits still rather than advertising itself. It is also the whole reason
 * the extras slot is a slot: removing the faucet should be deleting a file and one line, not
 * unpicking a layout. See crypto/faucet.ts for what else goes with it.
 *
 * `message` is the live text the claim itself emits, and it wins over the per-phase line below —
 * the machine's own words about what it is doing beat a generic caption.
 */
export function FaucetPanel({ phase, received, balance, message, onClaim, onRefresh }: FaucetPanelProps) {
  const spinning = phase === 'claiming' || phase === 'verifying' || phase === 'lagging'

  const line = (): string => {
    switch (phase) {
      case 'idle': return 'Claim free test funds to try Caravel.'
      case 'locked': return 'Unlock your wallet to claim.'
      case 'claiming': return 'Requesting funds from the faucet.'
      case 'verifying': return 'Confirming your claim on chain.'
      case 'done': return received !== undefined ? `${XTR(received)} received.` : 'Funds received.'
      // NOT AN ERROR. The claim committed; only the balance is behind.
      case 'lagging': return 'Taking longer than usual. Your funds will arrive.'
      case 'error': return 'The faucet did not respond. Nothing was claimed.'
      // No countdown: the wallet does not track one, and inventing "3h 12m" would be a fiction.
      case 'cooldown': return 'Just claimed. You can claim again shortly.'
      case 'plenty': return balance !== undefined
        ? `You have plenty to explore with for now (${fmt6(balance)} XTR).`
        : 'You have plenty to explore with for now.'
    }
  }

  const right = () => {
    if (spinning) return <Spinner size={15} />
    if (phase === 'done') {
      return (
        <span style={{
          width: 26, height: 26, borderRadius: 'var(--r-pill)', flexShrink: 0,
          background: 'rgba(var(--positive-rgb),0.12)', color: 'var(--positive)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}><Check size={13} color="currentColor" /></span>
      )
    }
    if (phase === 'error') return <CardAction tone="quiet" onClick={onClaim}>Retry</CardAction>
    if (phase === 'locked') return <CardAction tone="dead">Locked</CardAction>
    if (phase === 'cooldown') return <CardAction tone="dead">Wait</CardAction>
    if (phase === 'plenty') return <CardAction tone="quiet" onClick={onRefresh}>Refresh</CardAction>
    return <CardAction tone="primary" onClick={onClaim}>Claim</CardAction>
  }

  return (
    <ExtraCard
      tile={FAUCET_ICON}
      title="Testnet faucet"
      sub={message ?? line()}
      right={right()}
      muted={phase === 'cooldown' || phase === 'plenty' || phase === 'locked'}
    />
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
  | { step: 'sending'; amountMicrotari: bigint; progress: string; source: SendSource }
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
}

const shortAddr = (a: string) => (a.length > 26 ? `${a.slice(0, 14)}…${a.slice(-6)}` : a)

/**
 * "Spend from" — shown only when both balances can actually fund a payment.
 *
 * A toggle offering an option that cannot work is worse than no toggle, so when only one side is
 * funded the caller uses it silently and this never renders.
 */
function SourceToggle({ source, onSource }: { source: SendSource; onSource: (s: SendSource) => void }) {
  const opt = (kind: SendSource, label: string, Icon: typeof Shield) => {
    const on = kind === source
    return (
      <span role="radio" tabIndex={0} aria-checked={on}
        onClick={() => onSource(kind)} onKeyDown={e => e.key === 'Enter' && onSource(kind)}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '8px 4px', borderRadius: 8, cursor: 'pointer', userSelect: 'none',
          fontSize: 12.5, fontWeight: 600,
          background: on ? 'var(--accent-400)' : 'transparent',
          color: on ? '#FFFFFF' : 'var(--text-body-dim)',
        }}>
        <Icon size={11} color="currentColor" />{label}
      </span>
    )
  }
  return (
    <div>
      <FieldLabel>SPEND FROM</FieldLabel>
      <div style={{
        display: 'flex', gap: 3, padding: 3, borderRadius: 'var(--r-md)',
        background: 'var(--surface-void)', border: '1px solid var(--border)',
      }}>
        {opt('private', 'Shielded funds', Shield)}
        {opt('public', 'Unshielded funds', Eye)}
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
 * observer learns this account paid out that much. Claiming otherwise would be the one dishonest
 * thing this screen could do, so the public case says it plainly rather than reusing the private
 * copy.
 */
function PrivacyNote({ source }: { source: SendSource }) {
  const isPrivate = source === 'private'
  return (
    <div style={{
      display: 'flex', gap: 9, padding: '11px 13px', borderRadius: 'var(--r-md)', fontSize: 12, lineHeight: 1.5,
      background: isPrivate ? tealFill(0.05) : warnFill(0.05),
      border: isPrivate ? '1px solid var(--border-strong)' : warnBorder(0.28),
      color: isPrivate ? C.teal300 : C.mutedDim,
    }}>
      {isPrivate ? <Shield size={14} color={C.teal} /> : <Eye size={14} color={C.warn} />}
      {isPrivate
        ? 'Shielded. The amount and your address stay hidden.'
        : <span>They receive this privately — but <strong style={{ color: C.warn300, fontWeight: 600 }}>your spend is visible on-chain</strong>, because it comes out of your unshielded balance.</span>}
    </div>
  )
}

export function SendPanel({ view, hidden, onSource, onRecipient, onAmount, onNote, onMax, onReview, onBack, onConfirm, onDone, onRetry, onCopyTx, onViewActivity }: SendPanelProps) {
  if (view.step === 'form') {
    const isPrivate = view.source === 'private'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <FieldLabel>TO</FieldLabel>
          <TextField value={view.recipient} onChange={onRecipient} placeholder="otl_esm_… or @name" ariaLabel="Recipient" />
        </div>
        {view.canChooseSource && <SourceToggle source={view.source} onSource={onSource} />}
        <AmountField
          value={view.amount} onChange={onAmount} onMax={onMax}
          accent={isPrivate ? 'teal' : 'neutral'}
          availableLabel={view.canChooseSource ? (isPrivate ? 'Shielded available' : 'Unshielded available') : 'Available'}
          availableValue={hidden ? '••••••' : view.available !== null ? fmt6(view.available) : '—'}
          note={view.availabilityNote}
          error={view.error}
        />
        <div>
          <FieldLabel>PRIVATE NOTE · OPTIONAL</FieldLabel>
          <TextField value={view.note} onChange={onNote} placeholder="Only your recipient sees this" mono={false} multiline ariaLabel="Note" />
        </div>
        <PrivacyNote source={view.source} />
        <Button tone={view.canReview ? 'primary' : 'disabled'} onClick={view.canReview ? onReview : undefined}>Review payment</Button>
      </div>
    )
  }

  if (view.step === 'review') {
    const pricing = view.feeMicrotari === null
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <DetailCard>
          <DetailRow label="To" value={shortAddr(view.recipient)} valueColor={C.body} />
          <DetailRow label="From" value={view.source === 'private' ? 'Shielded balance' : 'Unshielded balance'}
            valueColor={view.source === 'private' ? C.teal300 : C.bodyDim} />
          <DetailRow label="Amount" value={XTR(view.amountMicrotari)} valueColor={C.bright} />
          <DetailRow label={view.feeIsCeiling ? 'Fee, at most' : 'Network fee'} last value={pricing
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spinner size={12} /><span style={{ fontFamily: 'inherit', fontSize: 12.5, color: C.faint }}>Pricing…</span></span>
            : XTR(view.feeMicrotari!)} />
        </DetailCard>
        {/* A CEILING IS NOT A MEASUREMENT. The shielded path dry-runs inside submission, so before
            confirming there is no exact figure to give — and presenting the ceiling as though there
            were would be a quieter kind of lie than showing no fee at all. */}
        {view.feeIsCeiling && !pricing && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: -6, lineHeight: 1.5 }}>
            Shielded sends show a fee ceiling. The exact fee is known once it settles.
          </div>
        )}
        <PrivacyNote source={view.source} />
        {view.note && (
          <div style={{ padding: '12px 14px', borderRadius: 'var(--r-md)', background: C.trough, border: '1px dashed var(--border-strong)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: C.tealDim, marginBottom: 6 }}>PRIVATE NOTE</div>
            <div style={{ fontSize: 13, color: 'var(--text-note)', fontStyle: 'italic' }}>“{view.note}”</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <Button tone="neutral" flex={1} onClick={onBack}>Back</Button>
          <Button tone={pricing ? 'disabled' : 'primary'} flex={2} onClick={pricing ? undefined : onConfirm}>Send</Button>
        </div>
      </div>
    )
  }

  if (view.step === 'sending') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, padding: '34px 0 30px' }}>
        <Spinner size={34} ring={3} />
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.bright, textAlign: 'center' }}>Sending {fmt6(view.amountMicrotari)} XTR</span>
          <span style={{ fontSize: 13, color: C.mutedDim, textAlign: 'center', maxWidth: 300, lineHeight: 1.5 }}>{view.progress}</span>
        </span>
      </div>
    )
  }

  // The payment is FINISHED. This window is the index catching up — same treatment the move flow
  // gives it, so the two never tell the user different stories about the same wait.
  if (view.step === 'settling') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <StatusBlock
          ring={{ fill: 'rgba(var(--positive-rgb),0.12)', border: '1px solid transparent' }}
          icon={<Check color={C.positive} />}
          title="Sent"
          sub={`${fmt6(view.amountMicrotari)} XTR to ${shortAddr(view.recipient)}. Your balance updates in about a minute.`}
        />
        <SettleBar caption="Updating your balance — the payment itself is finished." />
        <DetailCard><DetailRow label="Network fee" value={XTR(view.feeMicrotari)} last /></DetailCard>
        <TxRow txId={view.txId} onCopy={() => onCopyTx(view.txId)} />
        <Button tone="neutral" onClick={onDone}>Done</Button>
      </div>
    )
  }

  if (view.step === 'success') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <StatusBlock
          ring={{ fill: 'rgba(var(--positive-rgb),0.12)', border: '1px solid transparent' }}
          icon={<Check color={C.positive} />}
          title="Sent"
          sub={view.lagged
            ? `${fmt6(view.amountMicrotari)} XTR to ${shortAddr(view.recipient)}. Confirmed on the network — your balance hasn’t caught up yet, so tap Refresh in a moment. Nothing is at risk.`
            : `${fmt6(view.amountMicrotari)} XTR to ${shortAddr(view.recipient)}`}
        />
        <DetailCard><DetailRow label="Network fee" value={XTR(view.feeMicrotari)} last /></DetailCard>
        <TxRow txId={view.txId} onCopy={() => onCopyTx(view.txId)} />
        <Button tone="primary" onClick={onDone}>Done</Button>
      </div>
    )
  }

  if (view.step === 'unconfirmed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* NORMAL, NOT AN ERROR. Broadcast and undecided is an ordinary outcome on this network:
            the payment may still land, nothing has failed, and nothing needs re-sending. It wears
            the ACCENT wash and a clock — the warning triangle and amber it used to carry read as
            "something went wrong", which is the one thing this state is not. */}
        <StatusBlock
          ring={{ fill: 'var(--accent-wash)', border: '1px solid transparent' }}
          icon={<Clock size={18} color="var(--accent-ink)" />}
          title="Sent, not yet confirmed"
          sub={view.message}
        />
        <TxRow txId={view.txId} onCopy={() => onCopyTx(view.txId)} />
        <Button tone="neutral" onClick={onViewActivity}>View in Activity</Button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <StatusBlock
        ring={{ fill: 'rgba(var(--danger-rgb),0.10)', border: '1px solid rgba(var(--danger-rgb),0.28)' }}
        icon={<Alert color={C.danger} />}
        title="The payment didn’t go through"
        sub="Nothing left your wallet and no fee was taken."
      />
      <VerbatimBox>{view.message}</VerbatimBox>
      <div style={{ display: 'flex', gap: 10 }}>
        <Button tone="neutral" flex={1} onClick={onDone}>Close</Button>
        <Button tone="primary" flex={2} onClick={onRetry}>Try again</Button>
      </div>
    </div>
  )
}

/** The network's own words, held legibly. Same treatment the move flow's failure card uses. */
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
 * ── THE QR AND THE CLIPBOARD CARRY THE FULL ADDRESS ─────────────────────────
 *
 * The address is shown TRUNCATED, because 100-odd characters of base58 is not something anyone
 * reads and the design gives it one line. But truncation is a display concern and nothing else:
 * `QRCodeSVG` encodes `address` and the copy button copies `address`, both in full. A scannable
 * code or a clipboard holding an elided address would send funds nowhere recoverable, so the two
 * are deliberately fed from the value rather than from the label.
 *
 * The plate stays WHITE in both themes. A QR needs a guaranteed light ground with dark modules to
 * scan reliably, so this is one of the few places a literal is correct rather than lazy.
 */
export function ReceivePanel({ address, copied, onCopy }: { address: string | null; copied: boolean; onCopy: () => void }) {
  const plate: React.CSSProperties = {
    width: 172, height: 172, borderRadius: 'var(--r-lg)', margin: '0 auto',
    display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
  }

  if (!address) {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ ...plate, background: 'var(--surface-void)', border: '1px solid var(--border)' }}>
          <Spinner size={22} ring={2.5} />
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', marginTop: 14 }}>Preparing your address</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 4, opacity: 0.8 }}>
          This happens here, on your device.
        </div>
      </div>
    )
  }

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ ...plate, background: '#FFFFFF', border: '1px solid var(--border)', padding: 12 }}>
        <QRCodeSVG value={address} size={148} bgColor="#FFFFFF" fgColor="#0A1322" level="M" />
      </div>
      <div
        title={address}
        style={{
          fontFamily: MONO, fontSize: 11.5, color: 'var(--text-body-dim)',
          marginTop: 14, lineHeight: 1.5, wordBreak: 'break-all',
        }}
      >{shortAddr(address)}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', marginTop: 8, lineHeight: 1.5 }}>
        Share this to receive shielded payments. Nobody can see the amounts.
      </div>
      <span
        role="button" tabIndex={0} onClick={onCopy} onKeyDown={e => e.key === 'Enter' && onCopy()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 14,
          padding: '9px 16px', borderRadius: 'var(--r-md)', fontSize: 12.5, fontWeight: 600,
          border: '1px solid var(--border-strong)', color: C.primary,
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <Copy size={12} color="currentColor" />{copied ? 'Copied' : 'Copy address'}
      </span>
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
}> = {
  confirmed:   { label: 'Confirmed',   ink: 'var(--positive)',      wash: 'rgba(var(--positive-rgb),0.12)', signed: true },
  received:    { label: 'Received',    ink: 'var(--positive)',      wash: 'rgba(var(--positive-rgb),0.12)', signed: true },
  sent:        { label: 'Sent',        ink: 'var(--accent-ink)',    wash: 'var(--accent-wash)',             signed: true },
  checking:    { label: 'Checking',    ink: 'var(--accent-ink)',    wash: 'var(--accent-wash)',             signed: false },
  // AMBER, NOT RED, for both. Broadcast-and-undecided and waiting-to-settle are ordinary outcomes
  // on this network: nothing failed, and nothing needs re-sending.
  unconfirmed: { label: 'Unconfirmed', ink: 'var(--warn)',          wash: 'rgba(var(--warn-rgb),0.12)',     signed: true },
  pending:     { label: 'Pending',     ink: 'var(--warn)',          wash: 'rgba(var(--warn-rgb),0.12)',     signed: true },
  failed:      { label: 'Failed',      ink: 'var(--danger-500)',    wash: 'rgba(var(--danger-rgb),0.12)',   signed: false },
  spent:       { label: 'Spent',       ink: 'var(--text-muted-dim)', wash: 'var(--surface-void)',           signed: false },
  unreadable:  { label: 'Unreadable',  ink: 'var(--text-muted-dim)', wash: 'var(--surface-void)',           signed: false },
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
      <span style={{
        display: 'inline-flex', alignItems: 'center', padding: '3px 9px', borderRadius: 'var(--r-pill)',
        background: st.wash, color: st.ink, fontSize: 10.5, fontWeight: 600, flexShrink: 0,
      }}>{st.label}</span>
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
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)', padding: 6, boxShadow: 'var(--e1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px 8px' }}>
        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: C.primary }}>Recent activity</span>
        {/* Only offered when there is more than the page is showing — a "Show all" over three rows
            of three would be a control that changes nothing. */}
        {rows.length > shown.length && (
          <span role="button" tabIndex={0} onClick={onViewAll} onKeyDown={e => e.key === 'Enter' && onViewAll()}
            style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', cursor: 'pointer', userSelect: 'none', flexShrink: 0 }}>
            Show all
          </span>
        )}
      </div>
      {shown.length === 0 ? <ActivityEmpty compact /> : shown}
    </div>
  )
}

/** The FULL list, in an overlay. Same rows, no cap. */
export function ActivityPanel({ rows }: { rows: ReactNode[] }) {
  if (rows.length === 0) return <ActivityEmpty />
  return <div style={{ display: 'flex', flexDirection: 'column' }}>{rows}</div>
}


export { Body, SubHeader }
