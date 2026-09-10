//   CNS — "Register a name": the availability half of registration (design §10C).
//
//   ── WHERE IT SITS ────────────────────────────────────────────────────────────
//
//   A VIEW INSIDE THE OVERLAY, not a second modal. The design draws the difference: §6A's nine
//   New-conversation variants each carry the modal frame (20px padding, the 12/32 lift, a 16px
//   title, a close), while §10C's nine carry a panel's (18px, the flat lift, a 14px title, no
//   close). CNS is one overlay you move around inside, so the way back is a chevron beside this
//   view's own heading — not a second × competing with ModalCard's.
//
//   ── THE FIELD SAYS ONE THING ─────────────────────────────────────────────────
//
//   Its border reports whether this input is being WORKED ON, and nothing else: accent while a
//   check is running or has come back free, danger only when the TYPED TEXT is the problem, neutral
//   otherwise — including on a taken name and on a failed lookup, where the text was fine and the
//   card below carries the news. That is the compose modal's rule, and its note explains the bug it
//   fixed: three indicators saying one thing, and a field turning red about text that was perfectly
//   well typed.
//
//   ── THREE ANSWERS, THREE CARDS ───────────────────────────────────────────────
//
//     available    accent wash, accent border, a check          → the name was free when we looked
//     taken        warn wash, NEUTRAL border, no retry          → a fact about someone else's name
//     unreachable  warn wash, WARN border, Try again            → not an answer at all
//
//   Taken and unreachable are separated three ways at once — the card's border weight, the presence
//   of Try again, and the copy — because they are the pair this product has confused before. A name
//   we could not check is not a name somebody owns, and the difference is the user's fee.
//
//   ── AVAILABLE IS A PREVIEW ───────────────────────────────────────────────────
//
//   The indexer says what the registry looked like a moment ago; the contract decides at submit,
//   atomically. So the card says "available right now" and names the chain as the authority, and
//   nothing here says the name IS yours. §10D owns what happens when somebody takes it in between.
//
//   ── WHAT IS LIVE, AND WHAT IS NOT ────────────────────────────────────────────
//
//   Check availability and Try again act, so they look like it. "Register @name" leads to §10D,
//   which does not exist yet, so it wears the disabled fill rather than a full accent that would
//   swallow the click — the same rule the dashed row and the empty-state button followed while they
//   waited for this view.

import { useRef, useState } from 'react'
import { useWallet } from '../../context/WalletContext'
import { checkOnsAvailable, toOnsName, validateOnsName } from '../../crypto/ons'
import CnsCommitView from './CnsCommitView'

/** What the last completed check said. The policy error is NOT here — see `policyErr` below. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken' }
  | { kind: 'unreachable'; error: string }

const CARD: React.CSSProperties = {
  marginTop: 9, padding: '13px 14px', borderRadius: 12,
  display: 'flex', flexDirection: 'column', gap: 6,
}

/** The 26px glyph tile a result card leads with. It sits on the card surface, not on the wash. */
const CARD_TILE: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 8, flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--surface)',
}

const CARD_HEAD: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const CARD_BODY: React.CSSProperties = { fontSize: 12, color: 'var(--text-body-dim)', lineHeight: 1.5, textWrap: 'pretty' }

/** The composer's ring at 12px — one spinner idiom in the product, one duration. */
const Ring = ({ size = 12 }: { size?: number }) => (
  <span style={{
    width: size, height: size, borderRadius: 99, flexShrink: 0,
    border: '2px solid var(--border)', borderTopColor: 'var(--accent-400)',
    animation: 'cv-spin 0.8s linear infinite',
  }} />
)

const WarnTriangle = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
)

export default function CnsRegisterView({ onBack, onDone, onOpenWallet }: {
  onBack: () => void
  /** Finished with the whole flow — the overlay returns to the list and re-reads it. */
  onDone: () => void
  /** Switch to the Wallet service, for the timeout screen's "Check Activity". */
  onOpenWallet: () => void
}) {
  const { wallet, address, nostrNpub } = useWallet()
  const [raw, setRaw] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /**
   * THE COMMIT SCREEN REPLACES THIS ONE'S BODY, rather than being pushed as a third view.
   *
   * This component stays mounted underneath, so Cancel comes back to an availability answer that is
   * still on screen and still true — re-checking on the way back would spend a round trip to
   * re-learn something we were told a second ago, and could contradict the answer the user just
   * acted on. The design drops the field entirely in every 10D card, which is why this is a swap
   * and not an addition.
   */
  const [committing, setCommitting] = useState(false)

  // A GENERATION, not a cancellation flag. This check is fired by a button rather than by an
  // effect, so there is no teardown to hang a flag on — the guard has to survive across calls. Same
  // idiom the compose resolver uses: the run stamps a token, and a result whose token has been
  // superseded is dropped rather than written over a newer one.
  const token = useRef(0)

  const name = toOnsName(raw)
  // DERIVED, NEVER STORED. A policy problem is a fact about what is in the field right now, so it
  // is read from the field on every render. Holding it in state is how a stale error outlives the
  // text that caused it.
  const policyErr = raw.trim() ? validateOnsName(name) : null

  const checking = phase.kind === 'checking'
  const canCheck = !!name && !policyErr && !checking

  /**
   * Whether this wallet could actually register right now.
   *
   * CURRENTLY ALL-OR-NOTHING BY CONSTRUCTION: adoptIdentity sets the npub, then materialize sets
   * the wallet and its address together in one batch, and lock() clears all three at once. So the
   * partial case — a wallet present but its address or npub not yet — cannot happen today, and the
   * "just a moment" branch below is written for a shape the context does not currently produce. It
   * stays because it is the design's state and costs one ternary, and because the moment that
   * ordering changes, the alternative is a register button that silently does nothing.
   */
  const identityReady = !!wallet && !!address && !!nostrNpub

  function onType(v: string) {
    setRaw(v)
    // A new keystroke invalidates any answer on screen — including one still in flight. Bumping the
    // token here is what stops a check for "okz" landing under the word "okz61".
    token.current++
    if (phase.kind !== 'idle') setPhase({ kind: 'idle' })
  }

  async function check() {
    if (!canCheck) return
    const mine = ++token.current
    setPhase({ kind: 'checking' })
    const r = await checkOnsAvailable(name)
    if (token.current !== mine) return   // the field moved on; this answer is about older text
    if (!r.ok) {
      setPhase({ kind: 'unreachable', error: r.error ?? 'Could not reach the name registry — try again.' })
      return
    }
    // `available` is absent on a failed read, so there is no false here to mistake for "taken".
    setPhase({ kind: r.available ? 'available' : 'taken' })
  }

  // The field reports only whether it is being worked on. See the header note.
  const fieldBorder = policyErr ? 'var(--danger-500)'
    : (checking || phase.kind === 'available') ? 'var(--accent-400)'
    : 'var(--border)'
  const fieldLit = !policyErr && (checking || phase.kind === 'available')

  const showRegister = phase.kind === 'available'

  if (committing) {
    return (
      <CnsCommitView
        name={name}
        onCancel={() => setCommitting(false)}
        onDone={onDone}
        // Back to a clean field: the name that was just registered — or just lost — is not the one
        // to offer next.
        onTryAnother={() => { setCommitting(false); setRaw(''); setPhase({ kind: 'idle' }) }}
        onOpenWallet={onOpenWallet}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      {/* THE WAY BACK. The overlay's × closes CNS entirely; this returns to the list, which is the
          move somebody reaching for it actually wants. The design draws no control for it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
        <button
          onClick={onBack}
          title="Back to your names"
          aria-label="Back to your names"
          className="cv-icon-btn"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, flexShrink: 0, padding: 0, borderRadius: 7,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted-dim)', cursor: 'pointer',
          }}
        >
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>Register a name</div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 2, padding: '11px 13px', borderRadius: 11,
        border: `1px solid ${fieldBorder}`,
        boxShadow: fieldLit ? '0 0 0 3px rgba(var(--accent-400-rgb),0.14)' : 'none',
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted-dim)' }}>@</span>
        <input
          autoFocus
          value={raw}
          onChange={e => onType(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canCheck) void check() }}
          placeholder="Choose a name"
          spellCheck={false}
          aria-label="Name to register"
          className="cv-composer"
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--text-body)', fontSize: 14, fontWeight: raw ? 600 : 400,
            fontFamily: 'inherit', padding: 0,
          }}
        />
      </div>

      {/* THE RULES, BEFORE THE MISTAKE. Shown while nothing is wrong and nothing has been answered,
          so the constraint is read rather than discovered. */}
      {!policyErr && phase.kind === 'idle' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted-dim)', marginTop: 7, lineHeight: 1.5, textWrap: 'pretty' }}>
          Lowercase letters, numbers, hyphen and underscore. Up to 32 characters.
        </div>
      )}

      {/* THE VALIDATOR'S OWN SENTENCE, rendered as it comes. Red is reserved for the typed text
          being wrong, which is the one thing on this screen the person can fix by typing. */}
      {policyErr && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--danger-500)', marginTop: 7 }}>
          <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx={12} cy={12} r={9} /><path d="M12 8v4M12 16h.01" /></svg>
          {policyErr}
        </div>
      )}

      {checking && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-body-dim)', marginTop: 9 }}>
          <Ring />Checking @{name} on the Tari network…
        </div>
      )}

      {phase.kind === 'available' && (
        <div style={{ ...CARD, background: 'var(--accent-wash)', border: '1px solid var(--accent-400)' }}>
          <div style={CARD_HEAD}>
            <span style={{ ...CARD_TILE, color: 'var(--accent-ink)' }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            </span>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-ink)' }}>@{name} is available</div>
          </div>
          {/* NOT A PROMISE. The indexer answered about a moment ago and the contract decides at
              submit — so this says when it was free, and who actually decides. */}
          <div style={CARD_BODY}>Available right now. The chain has the final say when you register.</div>
        </div>
      )}

      {phase.kind === 'taken' && (
        // A FACT, NOT A FAULT. Someone owns this name; nothing went wrong and nothing needs
        // retrying, so the card is a quiet amber with a NEUTRAL border and no action on it. The
        // border weight is what separates it at a glance from the card below.
        <div style={{ ...CARD, background: 'var(--card-warn)', border: '1px solid var(--border)' }}>
          <div style={CARD_HEAD}>
            <span style={{ ...CARD_TILE, color: 'var(--warn)' }}><WarnTriangle /></span>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--warn)' }}>@{name} is already registered</div>
          </div>
          <div style={CARD_BODY}>This name is already taken. Try another.</div>
        </div>
      )}

      {phase.kind === 'unreachable' && (
        // NOT AN ANSWER. The registry did not tell us anything, so nothing here may imply the name
        // is gone — it says the opposite explicitly. Full warn border and a Try again, both of
        // which the taken card deliberately lacks.
        <div style={{ ...CARD, background: 'var(--card-warn)', border: '1px solid var(--warn)' }}>
          <div style={CARD_HEAD}>
            <span style={{ ...CARD_TILE, color: 'var(--warn)' }}><WarnTriangle /></span>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--warn)' }}>Couldn’t check @{name}</div>
          </div>
          <div style={CARD_BODY}>This is a network problem, not a taken name. @{name} may well be free.</div>
          {/* No .cv-icon-btn: that class hovers by setting border-color, which would turn this warn
              edge neutral grey — the one colour on the card doing work. */}
          <button
            onClick={() => { void check() }}
            style={{
              alignSelf: 'flex-start', marginTop: 3, padding: '7px 14px', borderRadius: 8,
              border: '1px solid var(--warn)', background: 'transparent', color: 'var(--warn)',
              fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      )}

      {/* §10C·9 — THE NAME IS FREE, THE WALLET IS NOT READY. The availability answer STAYS on
          screen; this is an additional card, not a replacement, because the two facts are
          independent and losing the first would make the second look like a failure.

          TWO SENTENCES, because two different things reach here. A wallet that is still resolving
          will self-clear, and "just a moment" is true. A LOCKED wallet will not, and telling
          somebody to wait for something that is never coming is the same class of confident wrong
          answer this whole flow is built to avoid. See `identityReady` for which of the two the
          context can currently produce. */}
      {phase.kind === 'available' && !identityReady && (
        <div style={{ ...CARD, background: 'var(--surface-base)', border: '1px solid var(--border)' }}>
          <div style={CARD_HEAD}>
            <span style={{ ...CARD_TILE, color: 'var(--text-body-dim)' }}><Ring /></span>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-body-dim)' }}>
              {wallet ? 'Just a moment' : 'This wallet is locked'}
            </div>
          </div>
          <div style={CARD_BODY}>
            {wallet
              ? <>Finishing setting up your wallet. You can register @{name} in a second.</>
              : <>Unlock this wallet to register @{name}.</>}
          </div>
        </div>
      )}

      {/* THE ACTION. Check availability is live and wears the accent when it can act. Register
          leads to §10D, which does not exist yet, so it is drawn in the disabled fill rather than
          as a control that looks live and swallows the click. */}
      {showRegister ? (
        // LIVE AT LAST. It waited three stages in the disabled fill because it opened nothing; it
        // opens the fee gate — which spends no money until the fee has been shown and approved.
        <button
          onClick={() => setCommitting(true)}
          className="cv-btn-primary"
          style={{
            width: '100%', marginTop: 11, padding: 10, borderRadius: 10, border: 'none',
            background: 'var(--accent-400)', color: 'var(--ink-on-accent)',
            fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
          }}
        >
          Register @{name}
        </button>
      ) : (
        <button
          onClick={() => { if (canCheck) void check() }}
          disabled={!canCheck}
          className={canCheck ? 'cv-btn-primary' : undefined}
          style={{
            width: '100%', marginTop: 11, padding: 10, borderRadius: 10, border: 'none',
            background: canCheck ? 'var(--accent-400)' : 'var(--msg-received)',
            color: canCheck ? 'var(--ink-on-accent)' : 'var(--text-muted-dim)',
            fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            cursor: canCheck ? 'pointer' : 'default',
          }}
        >
          {checking ? 'Checking…' : 'Check availability'}
        </button>
      )}
    </div>
  )
}
