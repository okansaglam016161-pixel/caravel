// The combined balance — the vault, and the wallet's single loudest thing.
//
// ── WHAT LEFT THIS FILE, AND WHY IT IS SAFE ──────────────────────────────────
//
// It used to carry a two-card breakdown beneath the figure, and that breakdown had a real job: when
// the total could not be shown, it was the ONLY thing telling the user which half was the problem.
// A missing total with no breakdown is a dead end.
//
// THAT JOB DID NOT DISAPPEAR — IT MOVED to the Privacy card, which sits directly below this one,
// always renders, and reports each side's status independently. The guarantee is unchanged; the
// place that keeps it is one card lower. Do not remove the Privacy card without putting the
// breakdown back here first.
//
// What the hero gains for it is what V3 is after: one number, centred, with nothing competing.
//
// ── WHY THIS IS AN ALWAYS-DARK ISLAND ────────────────────────────────────────
//
// The foundation keeps the balance hero and the nav on navy 900-950 in BOTH themes. So this card
// carries data-theme="dark" and its contents resolve the dark ramp regardless of the page around
// it — white stays legible and the hairline stays navy.
//
// That is why nothing in here is a literal. Hardcoding the dark values would render identically
// today and rot silently the moment a token moves; the island declares its context once and then
// uses ordinary role tokens like everywhere else.

import { C, MONO } from './tokens'
import { Receive, Send, Shield, Spinner } from './icons'
import { fiatForTotal } from './fiat'
import { MASK_SHORT, fmt6 } from './format'
import { unreadableReasonText, type TotalView } from './total'
import type { BalanceView } from './balances'

const num = { fontWeight: 600, color: C.bright, fontFeatureSettings: "'tnum'" } as const

/**
 * The hero figure, with the currency mark set slightly apart from the number.
 *
 * PURELY TYPOGRAPHIC, and deliberately not done in fiat.ts. That module's output is a VALUE — it is
 * asserted over by tests that read the exact string, and it is also what the assets row and the
 * service rail print inline, where a gap would look like a stray space. At 52px the mark and the
 * first digit collide; at 13px they do not. So the spacing belongs to the place with the type
 * problem, and the string keeps its single canonical form.
 *
 * The split is on a LEADING '$' only, and anything else falls through untouched — the fallback
 * branches print token amounts with no mark at all.
 */
function Figure({ usd }: { usd: string }) {
  if (!usd.startsWith('$')) return <>{usd}</>
  return (
    <>
      <span style={{ marginRight: '0.09em' }}>$</span>{usd.slice(1)}
    </>
  )
}

export function TotalHero({ total, privateBalance, publicBalance, hidden, onRetry, onSend, onReceive }: {
  total: TotalView
  /** The SHIELDED balance. The prop keeps the name of the state it is derived from. */
  privateBalance: BalanceView
  /** The UNSHIELDED balance. */
  publicBalance: BalanceView
  hidden: boolean
  /** Offered on `unreadable` — the one state where waiting will not fix it. */
  onRetry?: () => void
  /** The two primary actions. Omitted where the hero is shown without them (the preview gallery). */
  onSend?: () => void
  onReceive?: () => void
}) {
  const headline = () => {
    if (hidden) {
      return (
        <div style={{ fontFamily: MONO, fontSize: 40, fontWeight: 500, color: C.bright, marginTop: 8, lineHeight: 1.05 }}>
          {MASK_SHORT}
        </div>
      )
    }
    switch (total.status) {
      case 'ready': {
        // The only branch with a figure to convert. Every other case falls through to the state it
        // already had, which is what keeps a dollar sign from ever standing in for a number nobody
        // has read.
        const usd = fiatForTotal(total)
        return (
          <div style={{ marginTop: 8 }}>
            <div style={{ ...num, fontSize: 52, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.02 }}>
              {usd ? <Figure usd={usd} /> : fmt6(total.microtari)}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 13, color: 'var(--accent-300)', marginTop: 8 }}>
              {fmt6(total.microtari)} XTR
            </div>
          </div>
        )
      }
      // NO NUMBER while settling — deliberately not even a faded one. The balances are
      // mid-transition, so any figure here is arithmetic across two different moments, which is how
      // a confident 1100.207422 once appeared directly above the words "updating after your move".
      case 'settling':
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 18, minHeight: 53 }}>
            <Spinner size={15} ring={2} />
            <span style={{ fontSize: 13.5, color: C.bodyDim }}>Settling, this can take a moment</span>
          </div>
        )
      case 'loading':
        // A skeleton, not a zero and not a dash: nothing is wrong, we simply have no reading yet.
        return <div style={{ width: 190, height: 40, borderRadius: 10, background: 'var(--vault-card)', margin: '14px auto 13px' }} />
      case 'unreadable':
        return (
          <div style={{ marginTop: 14, marginBottom: 4 }}>
            <div style={{ fontSize: 15, fontWeight: 500, color: C.primary }}>Balance unreadable right now</div>
            <div style={{ fontSize: 12.5, color: 'var(--vault-label)', marginTop: 4, lineHeight: 1.5 }}>
              {unreadableReasonText(total.reason)}
              {onRetry && <>{' '}<span
                role="button" tabIndex={0} onClick={onRetry}
                onKeyDown={e => e.key === 'Enter' && onRetry()}
                style={{ color: 'var(--accent-300)', cursor: 'pointer', fontWeight: 600 }}
              >Retry</span></>}
            </div>
          </div>
        )
    }
  }

  // Said once, when a side is the reason the total is missing. The Privacy card below shows WHICH
  // half failed; this line says what that costs — which is the one thing that card cannot say,
  // because it is a fact about the total rather than about either side.
  const unreadableSide =
    !hidden && total.status === 'unreadable' && privateBalance.status === 'unavailable' ? 'private'
    : !hidden && total.status === 'unreadable' && publicBalance.status === 'unavailable' ? 'public'
    : null

  // ── THE DESIGN'S LINE, SHOWN ONLY WHERE IT IS TRUE ──────────────────────────
  //
  // V3 draws "Your balance is private" under a shield, over a wallet that is 90% private. Sitting
  // four inches above a Privacy card reading "90% private", that sentence is not a slogan any more
  // — it is a claim about this balance, and it contradicts the card. So it renders when it is a
  // fact and hands back to "Total balance" when it is not.
  //
  // Note what it takes to earn: a KNOWN total, both halves read, nothing hidden, and nothing
  // public. Anything less falls through — the label never asserts privacy over a reading we do not
  // have.
  const allPrivate =
    !hidden
    && total.status === 'ready'
    && publicBalance.status === 'ready' && publicBalance.microtari === 0n
    && privateBalance.status === 'ready' && privateBalance.microtari > 0n

  // ── AN EMPTY WALLET, SAID WARMLY — AND ONLY WHEN IT IS ACTUALLY EMPTY ───────
  //
  // `ready` is the whole guard, and it is a strong one. computeTotal reaches it only when BOTH
  // halves read cleanly, from the same refresh, with nothing settling and nothing incomplete — so a
  // ready 0n is a balance we have read and confirmed, not a balance we failed to find. Every way of
  // not knowing lands in another branch: unreadable, settling, or loading.
  //
  // THAT DISTINCTION IS THE POINT, not a technicality. Until b4da173 every brand-new wallet reported
  // "Balance unreadable right now" over a balance that was plainly zero, because a never-created
  // account came back as a thrown error rather than as the zero it was. Printing "nothing here yet,
  // go top up" over an unknown balance would be the same lie with a friendlier face, and worse: it
  // would tell someone whose read had failed that their money is gone.
  //
  // NO FLAG AND NO STATE. It is a function of the number, so it appears the moment a wallet is
  // confirmed empty and leaves the moment anything lands — no persistence to go stale, nothing to
  // dismiss, and nothing that can be left showing over a funded wallet.
  //
  // `hidden` counts as not-empty: someone who has masked their balance is not asking to be told
  // what is in it.
  const emptyWallet = !hidden && total.status === 'ready' && total.microtari === 0n

  return (
    <div data-theme="dark" style={{
      background: 'var(--nav-ground)', border: '1px solid var(--border)',
      borderRadius: 18, padding: 32, textAlign: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
        {allPrivate && <Shield size={13} color="var(--vault-label)" />}
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--vault-label)' }}>
          {allPrivate ? 'Your balance is private' : 'Total balance'}
        </span>
      </div>

      {headline()}

      {unreadableSide && (
        <div style={{ fontSize: 11.5, color: 'var(--vault-label)', marginTop: 10, lineHeight: 1.5 }}>
          The {unreadableSide} half could not be read, so the total is not shown.
        </div>
      )}

      {/* THE FIGURE STAYS ABOVE THIS, deliberately. A confirmed zero is a real reading and the hero
          prints it like any other; this is a supporting line, not a replacement for the number.
          Hiding the 0.000000 would make an empty wallet look like a wallet that had not loaded.

          BOTH ROUTES IT NAMES ARE ON THIS SCREEN: Receive is the button directly below, and the
          faucet panel sits under the vault on the same overview, offering "free test funds" in those
          words. Nothing here promises a capability that does not exist. */}
      {emptyWallet && (
        <div style={{ fontSize: 12.5, color: 'var(--vault-label)', marginTop: 12, lineHeight: 1.5, textWrap: 'pretty' }}>
          Nothing here yet. Claim free test funds below, or receive a payment to get started.
        </div>
      )}

      {/* The two primary actions live ON the vault, per the design. They stay enabled through every
          balance state: a read that failed says nothing about whether a payment can be built, and
          the send form does its own checking with far better reasons than this card could give. */}
      {(onSend || onReceive) && (
        <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'center', flexWrap: 'wrap' }}>
          {onSend && <VaultAction tone="primary" icon={<Send color="currentColor" />} label="Send" onClick={onSend} />}
          {onReceive && <VaultAction tone="quiet" icon={<Receive color="currentColor" />} label="Receive" onClick={onReceive} />}
        </div>
      )}
    </div>
  )
}

/** A button on the vault: accent for the primary action, the vault's own card colour for the rest. */
function VaultAction({ tone, icon, label, onClick }: {
  tone: 'primary' | 'quiet'; icon: React.ReactNode; label: string; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="cv-vault-action"
      style={{
        minWidth: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        padding: '12px 24px', borderRadius: 10, border: 'none', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
        background: tone === 'primary' ? 'var(--accent-400)' : 'var(--vault-card)',
        color: '#FFFFFF',
      }}
    >{icon}{label}</button>
  )
}

/**
 * A compact figure for a summary, as one string. Same rules, no layout.
 *
 * STILL IN XTR, and still used by chat's sidebar pill. The reskinned surfaces — the rail, the hero,
 * the assets row — price through `fiatForTotal` and fall back to this when there is no figure to
 * price. Chat is dark-pinned and un-reskinned, so it keeps the token amount until its own pass;
 * changing it here would reach into a surface this stage is not touching.
 */
export function totalPillValue(total: TotalView, hidden: boolean): string {
  if (hidden) return '••••'
  switch (total.status) {
    case 'ready': return fmt6(total.microtari)
    case 'settling': return '···'   // No number mid-transition — same rule as the hero.
    case 'loading': return '···'
    case 'unreadable': return '—'
  }
}
