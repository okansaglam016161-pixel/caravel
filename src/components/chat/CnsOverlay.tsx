//   CNS — "Your @names". The overlay and all of its list states (design §10A, §10B).
//
//   ── WHAT IT IS ───────────────────────────────────────────────────────────────
//
//   CNS opens as an OVERLAY OVER CHAT, not as a service view — the [@] in the search row replaces
//   the standalone @ tab the spine used to carry. It shares the frame the other three chat entry
//   modals share (ModalCard), because the design draws it as the same card: same surface, same
//   hairline, same radius, the same header row with a 26px close. It is wider (520 rather than 420)
//   and capped shorter (560 rather than the viewport) because it holds a list plus a register path.
//
//   ── SHELL + ONE BODY SWITCH ──────────────────────────────────────────────────
//
//   The constant is small and it is exactly what §10B draws as constant: the card, the title, the
//   close. EVERYTHING below switches, including two things that look like chrome and are not:
//
//     · THE SUB-LINE belongs to the list, not to the shell. "Names registered to this wallet" is a
//       caption for rows; over a spinner it captions nothing, and over the empty state it argues
//       with the sentence beneath it. §10A·2 carries it, §10B·1/2/3 do not.
//     · THE REGISTER ROW IS NOT PINNED CHROME. It rides with the list and the spinner, becomes the
//       primary action when the answer is a confirmed zero, and DISAPPEARS ENTIRELY when the
//       registry is unreachable. That last one is the honest call, not a layout accident: you
//       cannot know whether a name is free while the registry is unreadable, so inviting somebody
//       to register there is inviting a burned fee.
//
//   ── EMPTY IS NOT UNREACHABLE ─────────────────────────────────────────────────
//
//   The whole reason this file has four states rather than two. A confirmed zero and a failed read
//   used to render identically in this product, which told somebody who already owns a name that
//   they own nothing. They are now different bodies, different tone, different copy and different
//   actions — register versus retry — so no reading of one can arrive at the other. Unknown is
//   never drawn as zero.
//
//   ── EVERYTHING EXCEPT "TRY AGAIN" IS STATIC ──────────────────────────────────
//
//   Try again does something, so it looks like it does. The register affordances do not — §10C
//   builds that flow — so they carry no pointer, no hover and no chevron, and the empty state's
//   button wears this codebase's disabled treatment rather than a full-strength accent fill that
//   swallows clicks. "Withholding it removes every affordance at once rather than leaving a control
//   that looks live and does nothing" (WalletModal, on the assets row).
//
//   ── LOCAL STYLE CONSTANTS, ON PURPOSE ────────────────────────────────────────
//
//   The sidebar's row constants (CONV_ROW, REQUEST_CARD …) are module-private to ChatApp and stay
//   that way. Exporting one so a modal could borrow it would couple the conversation list's
//   geometry to this overlay's, and they are different rows at different sizes. What is shared is
//   the TOKENS, which is how PickRow, CreateGroupModal and ReinviteModal already do it. The empty
//   block is written here rather than through ThreadEmptyState for the same reason: that component
//   centres itself in a thread and carries a lock glyph, and widening it for a modal's benefit
//   would make one component answer to two screens.

import { useEffect, useState } from 'react'
import { useOwnedNames, type OwnedNamesState } from '../../hooks/useOwnedNames'
import type { NameRecord } from '../../crypto/ons'
import CnsRegisterView from './CnsRegisterView'
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

/** The composer's ring, at the design's 16px. One spinner idiom in the product, one duration. */
const Ring = () => (
  <span style={{
    width: 16, height: 16, borderRadius: 99, flexShrink: 0,
    border: '2px solid var(--border)', borderTopColor: 'var(--accent-400)',
    animation: 'cv-spin 0.8s linear infinite',
  }} />
)

/**
 * The way into §10C, in the two states that may offer one.
 *
 * LIVE NOW, AND DRESSED AS IT ACTS. It waited two stages without a pointer, a hover or the design's
 * chevron because it opened nothing; it opens the register view, so it gets all three back.
 */
function RegisterRow({ onOpen }: { onOpen: () => void }) {
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="cv-pick-row"
      style={{
        display: 'flex', alignItems: 'center', gap: 11, flexShrink: 0,
        padding: '11px 12px', borderRadius: 11, cursor: 'pointer',
        border: '1px dashed var(--border-strong)', color: 'var(--accent-ink)',
      }}
    >
      <span style={TILE}>
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </span>
      <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Register a new name</div>
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M9 18l6-6-6-6" /></svg>
    </div>
  )
}

/** A resolved name. Everything here is confirmed — see the pill note below. */
function NameRow({ record }: { record: NameRecord }) {
  return (
    <div style={NAME_ROW}>
      <span style={{ ...TILE, fontSize: 13, fontWeight: 600 }}>@</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-name)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{record.name}</div>
        {/* "Registered" AND NOTHING ELSE. The design's row reads "Registered [date]" when the chain
            supplies one — and it supplies none: the registry stores {owner, records} with no time
            field, so there is no date to print and the design draws that case too ("never a
            fabricated date"). The only timestamp in the product is this device's journal clock,
            which is when WE acted, not when the name was registered, and on another device it does
            not exist at all. */}
        <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 1 }}>Registered</div>
      </div>
      {/* THE ONLY PER-ROW PILL IN v1, and it can only ever say one thing: rows render only once the
          whole list has resolved, so every row on screen is confirmed. The unconfirmed states are
          whole-list states — checking and unreachable — never a row wearing a different colour. */}
      <span style={PILL}><Check />Registered</span>
    </div>
  )
}

export default function CnsOverlay({ onClose, onOpenWallet }: {
  onClose: () => void
  /** Switch to the Wallet service. The timeout screen's "Check Activity" is the only thing that
   *  needs it, and it needs it to be a real destination rather than a word. */
  onOpenWallet: () => void
}) {
  const { state, retry } = useOwnedNames()

  /**
   * ONE OVERLAY, TWO VIEWS. CNS is a place you move around inside rather than a stack of modals —
   * the design draws §10C as a panel with its own 14px heading and no close of its own, against
   * §6A's variants which each carry the full modal frame. So this switch sits ABOVE the list's
   * state switch: the register view is not a fifth thing the list can be.
   */
  const [view, setView] = useState<'list' | 'register'>('list')

  // Escape closes, the way every other modal here does it — ModalCard owns the backdrop and the ×,
  // each caller owns the key.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // COMING BACK RE-READS. Nothing registers yet — that is §10D — but the read is cheap, the list is
  // the thing you came back to look at, and wiring it now means a name claimed in a later stage
  // appears without closing and reopening the overlay.
  const backToList = () => { setView('list'); retry() }
  const openRegister = () => setView('register')

  return (
    <ModalCard title="Your @names" onClose={onClose} maxWidth={520} maxHeight={MAX_HEIGHT}>
      {view === 'register'
        ? <CnsRegisterView
            onBack={backToList}
            onDone={backToList}
            onOpenWallet={() => { onClose(); onOpenWallet() }}
          />
        : body(state, retry, openRegister)}
    </ModalCard>
  )
}

/**
 * The one body switch. Exhaustive by construction: the `never` binding below stops compiling the
 * moment a state is added without a body, which is how §10C and §10D will find out they own one.
 */
function body(state: OwnedNamesState, retry: () => void, onRegister: () => void) {
  switch (state.kind) {
    case 'checking':
      return (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '22px 0 16px' }}>
            <Ring />
            <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)' }}>Loading your names…</div>
          </div>
          {/* The way in stays put while the list loads. No rows are guessed at above it. */}
          <RegisterRow onOpen={onRegister} />
        </>
      )

    case 'names':
      return (
        <>
          {/* A BODY LINE, not ModalCard's `subtitle`: that one rides beside the close and ellipsises
              on one line. This is full width under the header, like New conversation's instruction
              line — and it belongs to this state alone, because it is a caption for the rows. */}
          <div style={{ fontSize: 12, color: 'var(--text-muted-dim)', lineHeight: 1.5, textWrap: 'pretty', marginTop: -6, flexShrink: 0 }}>
            Names registered to this wallet. People can reach you by any of them.
          </div>
          {/* ONLY THE ROWS SCROLL — the header, this list's ceiling and the register row below all
              stay put. Same shape as New group's member list. */}
          <div style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {state.names.map(n => <NameRow key={n.name} record={n} />)}
          </div>
          <RegisterRow onOpen={onRegister} />
        </>
      )

    case 'empty':
      // A CONFIRMED ZERO. The registry answered and this wallet owns nothing — which is a fact worth
      // saying plainly, and the one state where registering is the point of the screen rather than a
      // footnote to a list. Note what is absent: no pill, and nothing that could be read as a failure.
      return (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 11, padding: '22px 0 2px', textAlign: 'center' }}>
            <span style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent-wash)', color: 'var(--accent-ink)',
              fontSize: 17, fontWeight: 600,
            }}>@</span>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>You don’t have an @name yet</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted-dim)', lineHeight: 1.5, maxWidth: 300, textWrap: 'pretty' }}>
              Claim one so people can reach you by name instead of your npub.
            </div>
          </div>
          {/* THE PRIMARY ACTION, AND NOW IT IS ONE. It wore the disabled fill while §10C did not
              exist; it opens the register view, so it wears the accent. This is the one state where
              registering is the point of the screen rather than a footnote to a list. */}
          <button
            onClick={onRegister}
            className="cv-btn-primary"
            style={{
              width: '100%', flexShrink: 0, padding: 11, borderRadius: 11, border: 'none',
              background: 'var(--accent-400)', color: 'var(--ink-on-accent)',
              fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Register a name
          </button>
        </>
      )

    case 'unreachable': {
      // NOT AN ANSWER ABOUT THE CHAIN. Two different not-knowings reach here and they get two
      // different sentences: a registry we could not read, and a wallet whose identity we could not
      // read (locked, or keyless). Telling somebody with a locked wallet that they have a network
      // problem would be a small confident wrong answer of exactly the kind this state exists to
      // remove. The frame, tile, tone and Try again are the same either way.
      const network = state.errorKind === 'unreachable'
      return (
        <>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 9, flexShrink: 0,
            padding: 16, borderRadius: 12,
            background: 'var(--card-warn)', border: '1px solid var(--warn)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{
                width: 28, height: 28, borderRadius: 9, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--surface)', color: 'var(--warn)',
              }}>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
              </span>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--warn)' }}>
                {network ? 'Couldn’t reach the name registry' : 'Couldn’t read this wallet’s identity'}
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-body-dim)', lineHeight: 1.55, textWrap: 'pretty' }}>
              {network
                ? 'This is a network problem. Your names are safe, we just can’t show them right now.'
                : 'Your names are safe. Unlock this wallet and try again.'}
            </div>
            {/* NO .cv-icon-btn HERE. That class hovers by setting border-color, which would turn this
                button's warn edge neutral grey on hover — the one colour on the card doing work.
                The compose modal's own Try again carries no hover class either. */}
            <button
              onClick={retry}
              style={{
                alignSelf: 'flex-start', marginTop: 2, padding: '8px 16px', borderRadius: 9,
                border: '1px solid var(--warn)', background: 'transparent', color: 'var(--warn)',
                fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </div>
          {/* Said once more, plainly, because it is the point: a list we could not read is not an
              empty one, and NOTHING on this screen may imply otherwise. Which is also why there is
              no register affordance here — a name cannot be checked against a registry that will
              not answer, so offering to claim one would be offering to spend a fee blind. */}
          <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', lineHeight: 1.5, textWrap: 'pretty', flexShrink: 0 }}>
            We don’t know what this wallet owns until the registry answers.
          </div>
        </>
      )
    }

    default: {
      const unhandled: never = state
      return unhandled
    }
  }
}
