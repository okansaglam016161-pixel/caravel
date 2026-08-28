// Privacy — the composition of the balance, and the two ways to change it.
//
// ── WHAT THIS CARD TOOK OVER ─────────────────────────────────────────────────
//
// Two things used to live above it and no longer do. The vault hero carried a pair of breakdown
// cards, and a separate MoveList carried the Shield / Unshield entry rows (both now deleted).
// V3 folds them into one
// card, which is the right shape: the amounts and the controls that change them are the same
// subject, and reading "348.86 shielded" three inches from the button that changes it was the old
// layout's main cost.
//
// IT INHERITS THE BREAKDOWN'S JOB. The hero can fail to show a total; when it does, THIS card is
// the only thing on screen that says which half is the reason. So it renders in every state,
// including the ones where the hero shows nothing, and each side reports its own status
// independently. That guarantee moved here intact — it did not survive by accident.
//
// ── THE BAR IS NOT THE AMOUNTS ───────────────────────────────────────────────
//
// The two are drawn together and degrade separately, on purpose. A half that failed to read still
// shows its sibling's figure — that is diagnosis. But the BAR is a ratio between them, so it needs
// both, and it goes neutral the moment either is missing. See privacy.ts for why a ratio drawn
// from one known half is worse than no bar at all.
//
// ── EQUAL WEIGHT, AND WHERE THE WARNING WENT ─────────────────────────────────
//
// "Make private" and "Make public" are drawn identically: same border, same ground, same size.
// Neither is amber here. Choosing to be visible on chain is an ordinary thing to want — you cannot
// pay an exchange from a shielded balance — and putting a caution colour on the entry point frames
// a normal choice as a mistake before the user has made it.
//
// THIS IS A CHANGE AT THE ENTRY POINT ONLY. The unshield SHEET keeps every bit of its amber
// treatment and its "this cannot be undone" copy, shown on review, before the confirm button. The
// warning belongs where the irreversible act is committed, not on the door to the room.

import { Eye, Lock, Spinner } from './icons'
import { MONO, C } from './tokens'
import { MASK_SHORT, fmt6 } from './format'
import { privacySplit, splitLabel } from './privacy'
import type { EntryProps } from './move'
import type { BalanceView } from './balances'
import type { TotalView } from './total'

/** The buttons, in the order the design draws them. `dir` is the wallet's word; the label is V3's. */
const ACTIONS = [
  { dir: 'conceal', label: 'Make private' },
  { dir: 'reveal', label: 'Make public' },
] as const

/**
 * One side's amount, with its own state.
 *
 * NOT COLOUR-CODED, same as the breakdown cards this replaced: the foundation is explicit that
 * "private vs public is icon + label, never color". The lock and the eye carry the distinction, so
 * the pair stays legible in a screenshot and to a colour-blind reader — on the one distinction the
 * product is actually about. The only colour here is amber, and it means "this did not read",
 * which is a status rather than a side.
 */
function Side({ kind, balance, hidden }: {
  kind: 'private' | 'public'; balance: BalanceView; hidden: boolean
}) {
  const Icon = kind === 'private' ? Lock : Eye

  const value = () => {
    if (hidden) return <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: C.primary }}>{MASK_SHORT}</span>
    if (balance.status === 'loading') {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Spinner size={11} /><span style={{ fontSize: 12, color: C.mutedDim }}>Checking</span>
        </span>
      )
    }
    // NEVER A ZERO HERE. `unavailable` is a failed read, not an empty balance, and on a screen
    // about where someone's money is the two could not be further apart.
    if (balance.status === 'unavailable') {
      return <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--warn)' }}>Unavailable</span>
    }
    return (
      <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, color: C.primary }}>
        {fmt6(balance.microtari)}
      </span>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
      <Icon size={12} color={kind === 'private' ? 'var(--accent-ink)' : C.mutedDim} />
      <span style={{ fontSize: 12.5, color: C.mutedDim, flexShrink: 0 }}>
        {kind === 'private' ? 'Private' : 'Public'}
      </span>
      {value()}
    </div>
  )
}

export function PrivacyCard({ privateBalance, publicBalance, total, hidden, entries, lockedText, lockedIsFlight }: {
  privateBalance: BalanceView
  publicBalance: BalanceView
  total: TotalView
  hidden: boolean
  /** The shield / unshield entries with their disabled reasons — the overview's, unchanged. */
  entries?: EntryProps[]
  /** When set, BOTH directions are unavailable and this is the reason for both. */
  lockedText?: string
  /** A move is on the wire rather than a balance being unreadable — a different kind of wait. */
  lockedIsFlight?: boolean
}) {
  const split = privacySplit(total, privateBalance, publicBalance, hidden)

  // Rendered for every outcome of privacySplit, because the track itself is not a claim — only a
  // filled portion of it is. Neutral means "no ratio available", and looks like it.
  const bar = () => {
    if (split.kind !== 'known') {
      return (
        <div
          aria-hidden="true"
          style={{
            height: 8, borderRadius: 99, background: 'var(--border)',
            // Only while a reading is actually in progress. A hidden or unreadable bar sits still:
            // a pulse would suggest something is about to resolve, and neither of those will.
            animation: split.kind === 'unknown' && (split.label === 'Checking' || split.label === 'Updating')
              ? 'cv-pulse 1.4s ease-in-out infinite' : undefined,
          }}
        />
      )
    }
    return (
      <div aria-hidden="true" style={{ display: 'flex', gap: 2, height: 8 }}>
        <span style={{ width: `${split.privatePct}%`, background: 'var(--accent-400)', borderRadius: 99 }} />
        <span style={{ flex: 1, background: 'var(--border)', borderRadius: 99 }} />
      </div>
    )
  }

  const caption =
    split.kind === 'known' ? splitLabel(split.privatePct)
    : split.kind === 'empty' ? 'No funds yet'
    : split.label

  // The reasons, gathered. `lockedText` speaks for both directions; otherwise each entry brings its
  // own. Shown BENEATH the buttons rather than hidden in a title attribute: a disabled control that
  // cannot say why is the thing this wallet has refused to ship since M4.
  const reasons: { label: string; why: string }[] = []
  for (const a of ACTIONS) {
    const entry = entries?.find(e => e.dir === a.dir)
    const why = lockedText ?? entry?.disabledReason ?? (entry ? undefined : 'Unavailable right now')
    if (why) reasons.push({ label: a.label, why })
  }

  // One line when both directions are blocked for the same reason — repeating it verbatim under
  // two buttons reads as two separate problems.
  const sharedReason = reasons.length === 2 && reasons[0].why === reasons[1].why ? reasons[0].why : null

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 16, padding: '20px 22px', boxShadow: 'var(--e1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: C.primary }}>Privacy</span>
        {caption && (
          <span style={{
            fontSize: 12, flexShrink: 0,
            // Muted unless it is an actual percentage. A state word should not look like a figure.
            color: split.kind === 'known' ? C.primary : C.mutedDim,
            fontWeight: split.kind === 'known' ? 600 : 400,
          }}>{caption}</span>
        )}
      </div>

      {bar()}

      {/* Private LEFT, public RIGHT — the two ends of the bar directly above them. Sitting them
          side by side on the left made the figures read as a list; pushed apart, each one sits
          under the portion of the bar it accounts for. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 18, marginTop: 13, flexWrap: 'wrap',
      }}>
        <Side kind="private" balance={privateBalance} hidden={hidden} />
        <Side kind="public" balance={publicBalance} hidden={hidden} />
      </div>

      <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
        {ACTIONS.map(a => {
          const entry = entries?.find(e => e.dir === a.dir)
          const why = lockedText ?? entry?.disabledReason ?? (entry ? undefined : 'Unavailable right now')
          const off = !!why || !entry?.onClick
          return (
            <button
              key={a.dir}
              onClick={off ? undefined : entry!.onClick}
              disabled={off}
              // The full sentence on hover as well as below — the line under the row is truncated
              // by width, this never is.
              title={why}
              className={off ? undefined : 'cv-privacy-action'}
              style={{
                flex: 1, padding: 10, borderRadius: 9, fontFamily: 'inherit',
                fontSize: 13, fontWeight: 600,
                border: '1px solid var(--border-strong)', background: 'var(--surface)',
                color: off ? C.mutedDim : C.primary,
                cursor: off ? 'default' : 'pointer',
                opacity: off ? 0.6 : 1,
              }}
            >{a.label}</button>
          )
        })}
      </div>

      {/* The reason, always said. `lockedIsFlight` is a wait rather than a fault, so it gets the
          spinner the in-flight banner uses and not the flat grey of an unavailable control. */}
      {reasons.length > 0 && (
        <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {sharedReason ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: C.mutedDim, lineHeight: 1.45 }}>
              {lockedIsFlight && <Spinner size={10} />}{sharedReason}
            </span>
          ) : reasons.map(r => (
            <span key={r.label} style={{ fontSize: 11.5, color: C.mutedDim, lineHeight: 1.45 }}>
              <span style={{ fontWeight: 600 }}>{r.label}</span> · {r.why}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
