//   CNS — "Your @names". The resting view (design §10A).
//
//   ── WHAT IT IS ───────────────────────────────────────────────────────────────
//
//   CNS opens as an OVERLAY OVER CHAT, not as a service view — the [@] in the search row replaces
//   the standalone @ tab the spine used to carry. It shares the frame the other three chat entry
//   modals share (ModalCard), because the design draws it as the same card: same surface, same
//   hairline, same radius, the same header row with a 26px close. It is wider (520 rather than 420)
//   and capped shorter (560 rather than the viewport) because it holds a list plus a register path.
//
//   ── WHAT IT RENDERS, AND WHAT IT REFUSES TO ──────────────────────────────────
//
//   ROWS ONLY WHEN THE REGISTRY ANSWERED WITH NAMES. That is the design's own rule (§10B·4: "rows
//   only render once the list is fully resolved, so every rendered row is confirmed"), and it is
//   also the only shape that keeps the read layer's honesty intact. ownedOnsNames answers four
//   different things (crypto/ons.ts) and this stage renders exactly one of them:
//
//     { ok: true,  names: […] }   → the rows. ALL of them — owns-one and owns-several are one path.
//     { ok: true,  names: [] }    → shell only. The honest empty state is §10B.
//     { ok: false, … }            → shell only. Unreachable is §10B, and it is NOT empty.
//     still resolving             → shell only. Checking is §10B.
//
//   The last three deliberately render NOTHING in the body rather than something approximate. An
//   unreachable registry drawn as an empty one is the exact confident-wrong answer the read layer
//   was reworked to make impossible, and a placeholder written now would be a §10B state written
//   early and badly. The shell and the pinned register row still render in all four, which is what
//   §10B·1 draws — so the next stage fills two named holes rather than replacing a lie.
//
//   ── EVERYTHING HERE IS STATIC ────────────────────────────────────────────────
//
//   No cursor, no hover, no chevron, no click handler — on the name rows OR the register row. The
//   register flow is §10C and does not exist yet, and this codebase has already settled what to do
//   in the meantime: "withholding it removes every affordance at once rather than leaving a control
//   that looks live and does nothing" (WalletModal, on the assets row). The design's hover states
//   arrive with the behaviour they belong to.
//
//   ── LOCAL STYLE CONSTANTS, ON PURPOSE ────────────────────────────────────────
//
//   The sidebar's row constants (CONV_ROW, REQUEST_CARD …) are module-private to ChatApp and stay
//   that way. Exporting one so a modal could borrow it would couple the conversation list's
//   geometry to this overlay's, and they are different rows at different sizes. What is shared is
//   the TOKENS, which is how PickRow, CreateGroupModal and ReinviteModal already do it.

import { useEffect, useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { ownedOnsNames, type NameRecord } from '../../crypto/ons'
import ModalCard from './ModalCard'

/** The card's height ceiling. 560 is the design's cap; the viewport still wins on a short screen. */
const MAX_HEIGHT = 'min(560px, 88vh)'

/** The 34px "@" tile that leads every row, and the register row. --accent-wash behind --accent-ink. */
const TILE: React.CSSProperties = {
  width: 34, height: 34, borderRadius: 10, flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--accent-wash)', color: 'var(--accent-ink)',
}

/** One name. A solid hairline row; the register row below differs only in its dashed edge and ink. */
const NAME_ROW: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 11,
  padding: '11px 12px', borderRadius: 11, border: '1px solid var(--border)',
}

/**
 * The confirmed pill. Same formula the relay-health rows use — a 12% wash of the positive ink
 * behind the ink itself — so the one green in the product means one thing.
 */
const PILL: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
  padding: '3px 9px', borderRadius: 999,
  background: 'rgba(var(--positive-rgb),0.12)', color: 'var(--positive)',
  fontSize: 10.5, fontWeight: 600,
}

const Check = () => (
  <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
)

export default function CnsOverlay({ onClose }: { onClose: () => void }) {
  const { wallet } = useWallet()

  /**
   * null is "no answer to show", and it covers three different situations on purpose — still
   * resolving, the registry could not be read, and this wallet owns nothing. They are three
   * distinct results at the read layer and they become three distinct STATES in §10B; until then
   * none of them may render a claim, so they collapse to the same silence rather than to the same
   * sentence. `loading` is kept for §10B to hang its checking state on.
   */
  const [names, setNames] = useState<NameRecord[] | null>(null)

  // NO `loading` FLAG YET, and that is not an oversight. Nothing on this stage's screen changes
  // while the read is in flight — checking is §10B — so a boolean nothing reads would be a
  // re-render for no one and a variable the next stage would have to re-derive anyway. It arrives
  // with the state that needs it.
  //
  // The cancellation guard is the one OnsRegisterPanel uses: a boolean captured in the closure, so
  // a resolve that lands after this overlay closed writes to nothing.
  useEffect(() => {
    if (!wallet) return
    let cancelled = false
    ownedOnsNames(wallet).then(r => {
      if (cancelled) return
      // ONLY a confirmed, non-empty answer produces rows. Every other outcome leaves `names` null —
      // see the header note for why that is silence rather than an empty list.
      setNames(r.ok && r.names?.length ? r.names : null)
    })
    return () => { cancelled = true }
  }, [wallet])

  // Escape closes, the way every other modal here does it — ModalCard owns the backdrop and the ×,
  // each caller owns the key.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <ModalCard title="Your @names" onClose={onClose} maxWidth={520} maxHeight={MAX_HEIGHT}>
      {/* A BODY LINE, not ModalCard's `subtitle`: that one rides beside the close and ellipsises on
          one line. This is full width under the header, like New conversation's instruction line. */}
      <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', lineHeight: 1.5, textWrap: 'pretty', marginTop: -6, flexShrink: 0 }}>
        Names registered to this wallet. People can reach you by any of them.
      </div>

      {/* ONLY THE ROWS SCROLL — the header, this list's ceiling and the register row below all stay
          put. Same shape as New group's member list. */}
      {names && (
        <div style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {names.map(n => (
            <div key={n.name} style={NAME_ROW}>
              <span style={{ ...TILE, fontSize: 13, fontWeight: 600 }}>@</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-name)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{n.name}</div>
                {/* "Registered" AND NOTHING ELSE. The design's row reads "Registered [date]" when
                    the chain supplies one — and it supplies none: the registry stores {owner,
                    records} with no time field, so there is no date to print and the design draws
                    that case too ("never a fabricated date"). The only timestamp in the product is
                    this device's journal clock, which is when WE acted, not when the name was
                    registered, and on another device it does not exist at all. */}
                <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 1 }}>Registered</div>
              </div>
              <span style={PILL}><Check />Registered</span>
            </div>
          ))}
        </div>
      )}

      {/* PINNED BENEATH THE LIST, never inside it — it is the way out of this view, not an item in
          it, and §10B keeps it on screen while the list is still loading. INERT THIS STAGE: it is
          drawn and does nothing until §10C gives it a flow to open, so it carries no pointer, no
          hover and no chevron. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 11, flexShrink: 0,
        padding: '11px 12px', borderRadius: 11,
        border: '1px dashed var(--border-strong)', color: 'var(--accent-ink)',
      }}>
        <span style={TILE}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </span>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Register a new name</div>
      </div>
    </ModalCard>
  )
}
