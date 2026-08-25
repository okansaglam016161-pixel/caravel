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
import { C, MONO, border, tealBorder, tealFill } from './tokens'
import { Alert, Check, Copy, Retry, Shield, Spinner } from './icons'
import {
  AmountField, Body, Button, DetailCard, DetailRow, FieldLabel, Panel, PanelText,
  StatusBlock, SubHeader, TextField, TxRow,
} from './primitives'
import { fmt6 } from './format'

const TARI = (n: bigint) => `${fmt6(n)} TARI`

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

export function FaucetPanel({ phase, received, balance, message, onClaim, onRefresh }: FaucetPanelProps) {
  const GRANT = '+1,000 TARI'

  if (phase === 'done') {
    return (
      <Panel tone="teal" titleColor={C.bright} title={<><CheckDot />Funds received</>}>
        <PanelText color={C.tealLabel}>
          {message ?? (received !== undefined
            ? `${TARI(received)} added. You can send it, make it public, or register a name.`
            : 'Your balance has been updated.')}
        </PanelText>
        <Button tone="disabled">Claimed ✓</Button>
      </Panel>
    )
  }

  // NOT AN ERROR. The claim committed; only the balance display is behind.
  if (phase === 'lagging') {
    return (
      <Panel tone="amber" title={<><span style={{ width: 8, height: 8, borderRadius: '50%', background: C.warn, animation: 'cv-pulse 1.6s ease-in-out infinite' }} />Funds sent, not visible yet</>}>
        <PanelText>The faucet confirmed. Your balance hasn’t caught up — this can take a minute, and nothing is at risk.</PanelText>
        <Button tone="neutral" onClick={onRefresh}>Refresh balance</Button>
      </Panel>
    )
  }

  if (phase === 'error') {
    return (
      <Panel tone="danger" titleColor={C.dangerText} title={<><Alert size={16} color={C.danger} />Faucet unavailable</>}>
        <PanelText>{message ?? 'The faucet didn’t respond. Nothing was claimed.'}</PanelText>
        <Button tone="neutral" onClick={onClaim}>Try again</Button>
      </Panel>
    )
  }

  if (phase === 'claiming' || phase === 'verifying') {
    return (
      <Panel title="Testnet faucet" meta={GRANT} metaColor={C.teal300}>
        <PanelText>{phase === 'claiming' ? 'Asking the faucet for funds.' : 'Waiting for the funds to show up in your balance.'}</PanelText>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 12, borderRadius: 11, background: C.inset, border: tealBorder(0.2), color: C.teal300, fontSize: 14, fontWeight: 700 }}>
          <Spinner size={15} />{phase === 'claiming' ? 'Claiming…' : 'Checking…'}
        </div>
      </Panel>
    )
  }

  if (phase === 'cooldown') {
    return (
      <Panel title="Testnet faucet" titleColor={C.muted} meta="just claimed">
        <PanelText color={C.faint}>{message ?? 'You’ve already claimed. Try again shortly.'}</PanelText>
        <Button tone="disabled">Claimed ✓</Button>
      </Panel>
    )
  }

  if (phase === 'plenty') {
    return (
      <Panel title="Testnet faucet" titleColor={C.muted} meta={balance !== undefined ? `balance ${fmt6(balance)}` : undefined}>
        <PanelText color={C.faint}>You already have plenty. Leave the rest for other testers.</PanelText>
        <Button tone="disabled">Claim funds</Button>
      </Panel>
    )
  }

  const locked = phase === 'locked'
  return (
    <Panel title="Testnet faucet" meta={GRANT} metaColor={C.teal300}>
      <PanelText>Free test funds, signed here in your browser.{locked && ' Unlock your wallet to claim.'}</PanelText>
      <Button tone={locked ? 'disabled' : 'primary'} onClick={locked ? undefined : onClaim}>Claim funds</Button>
    </Panel>
  )
}

const CheckDot = () => (
  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: tealFill(0.16), flexShrink: 0 }}>
    <Check size={13} color={C.teal} />
  </span>
)

// ══ SEND ══════════════════════════════════════════════════════════════════════

export type SendView =
  | { step: 'form'; recipient: string; amount: string; note: string; available: bigint | null; canReview: boolean; error?: string }
  | { step: 'review'; recipient: string; amountMicrotari: bigint; note: string; feeMicrotari: bigint | null }
  | { step: 'sending'; amountMicrotari: bigint; progress: string }
  | { step: 'success'; recipient: string; amountMicrotari: bigint; feeMicrotari: bigint; txId: string }
  | { step: 'error'; message: string }
  /** Broadcast but undecided. NOT a failure — the send may still land, so it must not read as one. */
  | { step: 'unconfirmed'; message: string; txId: string }

export interface SendPanelProps {
  view: SendView
  hidden: boolean
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

export function SendPanel({ view, hidden, onRecipient, onAmount, onNote, onMax, onReview, onBack, onConfirm, onDone, onRetry, onCopyTx, onViewActivity }: SendPanelProps) {
  if (view.step === 'form') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <FieldLabel>TO</FieldLabel>
          <TextField value={view.recipient} onChange={onRecipient} placeholder="otl_esm_… or @name" ariaLabel="Recipient" />
        </div>
        <AmountField
          value={view.amount} onChange={onAmount} onMax={onMax}
          availableLabel="Available" availableValue={hidden ? '••••••' : view.available !== null ? fmt6(view.available) : '—'}
          error={view.error}
        />
        <div>
          <FieldLabel>PRIVATE NOTE · OPTIONAL</FieldLabel>
          <TextField value={view.note} onChange={onNote} placeholder="Only your recipient sees this" mono={false} multiline ariaLabel="Private note" />
        </div>
        <div style={{ display: 'flex', gap: 9, padding: '11px 13px', borderRadius: 11, background: tealFill(0.05), border: tealBorder(0.22), fontSize: 12, color: C.teal300, lineHeight: 1.5 }}>
          <Shield size={14} color={C.teal} />
          Private. The amount and your address stay hidden.
        </div>
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
          <DetailRow label="Amount" value={TARI(view.amountMicrotari)} valueColor={C.bright} />
          <DetailRow label="Network fee" last value={pricing
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spinner size={12} /><span style={{ fontFamily: 'inherit', fontSize: 12.5, color: C.faint }}>Pricing…</span></span>
            : TARI(view.feeMicrotari!)} />
        </DetailCard>
        {view.note && (
          <div style={{ padding: '12px 14px', borderRadius: 11, background: C.trough, border: `1px dashed rgba(45,224,198,0.26)` }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: C.tealDim, marginBottom: 6 }}>PRIVATE NOTE</div>
            <div style={{ fontSize: 13, color: '#C7E4DD', fontStyle: 'italic' }}>“{view.note}”</div>
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
          <span style={{ fontSize: 16, fontWeight: 700, color: C.bright, textAlign: 'center' }}>Sending {fmt6(view.amountMicrotari)} TARI</span>
          <span style={{ fontSize: 13, color: C.mutedDim, textAlign: 'center', maxWidth: 300, lineHeight: 1.5 }}>{view.progress}</span>
        </span>
      </div>
    )
  }

  if (view.step === 'success') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <StatusBlock
          ring={{ fill: tealFill(0.1), border: tealBorder(0.35) }}
          icon={<Check color={C.teal} />}
          title="Sent"
          sub={`${fmt6(view.amountMicrotari)} TARI to ${shortAddr(view.recipient)}`}
        />
        <DetailCard><DetailRow label="Network fee" value={TARI(view.feeMicrotari)} last /></DetailCard>
        <TxRow txId={view.txId} onCopy={() => onCopyTx(view.txId)} />
        <Button tone="primary" onClick={onDone}>Done</Button>
      </div>
    )
  }

  if (view.step === 'unconfirmed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <StatusBlock
          ring={{ fill: 'rgba(255,180,60,0.08)', border: '1px solid rgba(255,180,60,0.35)' }}
          icon={<Alert color={C.warn} />}
          title="Not confirmed yet"
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
        ring={{ fill: 'rgba(255,122,122,0.08)', border: '1px solid rgba(255,122,122,0.3)' }}
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
      padding: '13px 15px', borderRadius: 11, background: C.errorGround,
      border: '1px solid rgba(255,122,122,0.22)', fontFamily: MONO, fontSize: 11.5,
      lineHeight: 1.65, color: C.dangerText, overflowWrap: 'anywhere',
      userSelect: 'text', cursor: 'text', maxHeight: 180, overflowY: 'auto',
    }}>{children}</div>
  )
}

// ══ RECEIVE ═══════════════════════════════════════════════════════════════════

export function ReceivePanel({ address, copied, onCopy }: { address: string | null; copied: boolean; onCopy: () => void }) {
  if (!address) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 178, height: 178,
          borderRadius: 14, background: C.raised, border: '1px dashed rgba(120,150,210,0.2)',
        }}><Spinner size={30} ring={3} color={C.mutedDim} /></div>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.muted }}>Preparing your address</span>
          <span style={{ fontSize: 13, color: C.faint }}>This happens here, on your device.</span>
        </span>
        <div style={{ width: '100%' }}><Button tone="disabled">Copy address</Button></div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <div style={{ display: 'inline-flex', padding: 14, borderRadius: 14, background: C.bright }}>
        <QRCodeSVG value={address} size={150} bgColor="#EAFBF7" fgColor="#04120F" level="M" />
      </div>
      <span style={{ fontSize: 13, color: C.mutedDim, textAlign: 'center', lineHeight: 1.5 }}>
        Share this to receive private payments. Nobody can see the amounts.
      </span>
      <div style={{
        width: '100%', padding: '13px 15px', borderRadius: 11, background: C.trough, border: border(0.12),
        fontFamily: MONO, fontSize: 12, color: C.bodyDim, lineHeight: 1.6, wordBreak: 'break-all',
      }}>{address}</div>
      <div style={{ width: '100%' }}>
        <Button tone="primary" onClick={onCopy}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <Copy color={C.inkOnTeal} />{copied ? 'Copied' : 'Copy address'}
          </span>
        </Button>
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
          <DetailCard><DetailRow label="Network fee" value={feeMicrotari !== undefined ? TARI(feeMicrotari) : '—'} last /></DetailCard>
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: 12, borderRadius: 11, background: C.inset, border: tealBorder(0.2), color: C.teal300, fontSize: 14, fontWeight: 700 }}>
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

// ══ Activity (placeholder — not redesigned in this stage) ═════════════════════

export function ActivityPlaceholder({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '26px 0' }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: '50%', background: C.raised, border: border(0.14) }}>
        <Retry size={18} color={C.faint} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.muted }}>Nothing here yet</span>
        <span style={{ fontSize: 13, color: C.faint, textAlign: 'center', maxWidth: 260, lineHeight: 1.5 }}>
          Payments you send and receive will show up here.
        </span>
      </span>
      <Button tone="neutral" onClick={onRefresh}>Refresh</Button>
    </div>
  )
}

export { Body, SubHeader }
