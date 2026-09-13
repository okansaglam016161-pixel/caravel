//   Landing page — the public marketing page, built to the "Caravel Landing Page" design.
//
//   ── THEMING ──────────────────────────────────────────────────────────────────
//
//   The toggle here drives the APP-WIDE theme, held by hooks/useTheme and written to <html>. The
//   attribute on this page's root div is kept only so the scoped .cv-lp rules below can key off it;
//   it mirrors the app's value rather than owning one.
//
//   The choice PERSISTS and is APP-WIDE (see hooks/useTheme): a visitor who picks dark here is still
//   in dark at the unlock screen and in the wallet behind it.
//
//   ── RESPONSIVE ───────────────────────────────────────────────────────────────
//
//   The design is a fixed 1120 desktop canvas with no media queries of its own — four-, three- and
//   two-column grids that overflow below roughly 900px. Everything layout-changing (grid columns,
//   section rhythm, the display sizes, the mockup's rail) therefore lives in the scoped .cv-lp
//   classes below so the two breakpoints can override it; colours and decorative offsets stay
//   inline, exactly as the previous landing page was arranged.
//
//   The app mockup narrows rather than scales. Its internals are fixed pixels, so a transform would
//   need a paired negative margin to keep layout height in step — fiddly, and it makes the type
//   blurry on the way down. The right pane is already fluid, so it simply takes the width instead.
//
//   THE SPINE NOW STAYS. That paragraph used to end "dropping the nav rail below 880 lets the right
//   pane simply take the width — the rail is decoration here; the balance card is the point", and
//   both halves of that stopped being true. The rail was 190px and carried a balance card; it is
//   the app's 64px icon spine now, it carries no figure, and at that width there is nothing to drop
//   until roughly 460 — see the breakpoint's own note below. It is also no longer decoration: with
//   it gone the mockup is a wallet pane floating in a browser window, which is a picture of no
//   product. The one thing left that must go early is nothing; the spine is the shell.
//
//   WHAT NARROWS INSTEAD IS THE WALLET HEADER, which wraps at 640 — the title on one line, the
//   network chip and its three controls on the next. That row is the mockup's least compressible
//   thing (a nowrap chip beside three fixed boxes), so wrapping it rather than hiding the spine is
//   what keeps the shell on screen down to the low 400s.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../../hooks/useTheme'
import ThemeToggle from '../primitives/ThemeToggle'
import LogoTile from '../primitives/LogoTile'
import ChatStill from './ChatStill'
import WalletStill from './WalletStill'

// ── Icons ─────────────────────────────────────────────────────────────────────
//
// Transcribed from the design. `currentColor` throughout so a caller sets the colour once on the
// parent; the two that take an explicit colour do so because they sit on the navy vault, where the
// surrounding text colour is not the one the icon wants.

type IconProps = { size?: number; color?: string; strokeWidth?: number }

const svgBase = (size: number, color: string, strokeWidth: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  style: { flexShrink: 0 },
})

const Wallet = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><rect x="2.5" y="6" width="19" height="13" rx="2.5" /><path d="M2.5 10h19" /><path d="M15.5 14.5h2" /></svg>
)
const Message = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M21 11.5a8.5 8.5 0 1 0-16.9 1.6L3 20l3.8-1.1A8.5 8.5 0 0 0 21 11.5z" /></svg>
)
const ArrowOut = ({ size = 16, color = 'currentColor', strokeWidth = 2 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M7 17L17 7" /><path d="M9 7h8v8" /></svg>
)
const Browser = ({ size = 18, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /><circle cx="6" cy="6.5" r=".5" /><circle cx="8.5" cy="6.5" r=".5" /></svg>
)
const Key = ({ size = 18, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><circle cx="8" cy="15" r="4.5" /><path d="M11 12L20 3M16 7l3 3M13 10l2.5 2.5" /></svg>
)
const Swap = ({ size = 15, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M4 7h13l-3-3" /><path d="M20 17H7l3 3" /></svg>
)
const Bridge = ({ size = 15, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><path d="M2 17h20" /><path d="M4 17v-4a8 8 0 0 1 16 0v4" /></svg>
)
const Pools = ({ size = 15, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg {...svgBase(size, color, strokeWidth)}><circle cx="12" cy="7.5" r="3.2" /><circle cx="7.5" cy="15.5" r="3.2" /><circle cx="16.5" cy="15.5" r="3.2" /></svg>
)
const Chevron = ({ size = 16, color = 'currentColor', dir = 'down' }: IconProps & { dir?: 'up' | 'down' }) => (
  <svg {...svgBase(size, color, 2)}>{dir === 'up' ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}</svg>
)

// ── Small shared pieces ───────────────────────────────────────────────────────

/**
 * The brand lockup: the light mark inside an accent tile, then the wordmark.
 *
 * One rendering in both themes, deliberately. The foundation allows the blue mark on light and the
 * light mark on the vault — and the tile IS a vault-coloured surface, so the light mark is correct
 * whichever theme the page is in. It also keeps the lockup identical to the app's nav rail.
 */
function Lockup({ tile, text }: { tile: number; text: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tile > 28 ? 10 : 9 }}>
      {/* The mark's height and the tile's radius both derive from the tile now, so the second and
          third numbers this took are gone. `text` stays: the wordmark is not the mark's business. */}
      <LogoTile size={tile} />
      <span style={{ fontSize: text, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>Caravel</span>
    </div>
  )
}

/** The primary CTA. One definition — it appears in the top bar, the hero and the closing section. */
function LaunchButton({ onClick, big = false }: { onClick: () => void; big?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="cv-lp-primary"
      style={{
        cursor: 'pointer', fontFamily: 'inherit', border: 'none',
        padding: big ? '13px 26px' : '10px 18px', borderRadius: 'var(--r-md)',
        fontSize: big ? 15 : 14, fontWeight: 600,
        background: 'var(--accent-400)', color: '#FFFFFF',
      }}
    >Launch Caravel</button>
  )
}

/** Section heading. 38/600 on desktop; the class carries the two smaller steps. */
function H2({ children, narrow = false }: { children: React.ReactNode; narrow?: boolean }) {
  return (
    <h2 className="cv-lp-h2" style={{
      margin: '0 auto', textAlign: 'center', fontWeight: 600, letterSpacing: '-0.025em',
      lineHeight: 1.15, color: 'var(--text-primary)', textWrap: 'pretty',
      ...(narrow ? { maxWidth: 720 } : {}),
    }}>{children}</h2>
  )
}

/** "Live" / "Coming soon" / "BACKER" — the design's three pill treatments. */
function Pill({ tone, children }: { tone: 'live' | 'quiet' | 'mono'; children: React.ReactNode }) {
  if (tone === 'live') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
        borderRadius: 'var(--r-pill)', background: 'rgba(var(--positive-rgb),0.12)',
        color: 'var(--positive)', fontSize: 11.5, fontWeight: 600, flexShrink: 0,
      }}>
        <span style={{ width: 5, height: 5, borderRadius: 'var(--r-pill)', background: 'var(--positive)' }} />
        {children}
      </span>
    )
  }
  if (tone === 'mono') {
    return (
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.14em',
        color: 'var(--text-muted-dim)', padding: '5px 12px', borderRadius: 'var(--r-pill)',
        border: '1px solid var(--border)',
      }}>{children}</span>
    )
  }
  return (
    <span style={{
      padding: '3px 9px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border)',
      fontSize: 11, fontWeight: 600, color: 'var(--text-muted-dim)', flexShrink: 0,
    }}>{children}</span>
  )
}

// ── The app mockup ────────────────────────────────────────────────────────────
//
// A still of the product, not a live embed. Nothing here reads real state.
//
// THE WALLET HALF IS NO LONGER DRAWN HERE. It used to be, and this note used to say the mockup
// "deliberately does not import anything from the wallet — a marketing still that could break when
// the wallet's types move would be the worst of both". The reasoning inverted itself in practice:
// what actually happened is that the wallet's types moved, this file did NOT break, and the page
// went on showing a layout the app had deleted — a two-card Shielded/Unshielded breakdown, no
// Privacy card, an assets row with two features that no longer exist. Silence was the failure.
//
// So the vault, the Privacy card and the assets row are the REAL components now, over mock props,
// in WalletStill next door. Breaking on a type change is the alarm this picture never had. What is
// still hand-drawn is what has no component to borrow: the browser chrome, the service spine, and
// the header cluster — and the spine and header are copied measurement-for-measurement from
// ServiceNav and RootHeader, with their geometry imported where a module exists to import it from.
//
// TERMINOLOGY: PRIVATE / PUBLIC, and XTR. The app purged "shielded / unshielded" outright —
// wallet/v2/total.ts puts the rule as "the words here have to be the words the screen around them
// uses", and moveCopy.test.ts pins it with a case-insensitive assertion that no derived string may
// match /shielded/i ("Nothing may bring it back"). This page was the last surface still saying it.

/**
 * A rail row, as a picture of one. ON .cv-nav-item, WHICH IS THE REAL RAIL'S OWN CLASS — the hover
 * is not a look-alike written for this page, it is the rule ServiceNav's buttons carry, so the two
 * cannot drift.
 *
 * THE RESTING STATE IS DELIBERATELY NOT INLINE HERE, and that is the whole reason the hover is
 * visible at all. .cv-nav-item hovers by setting background and color; an inline "transparent" and
 * an inline dim color outrank a class selector, so a row that declares its own resting appearance
 * gets the class's hover silently thrown away. That is not a guess — the row was written that way
 * first and measured doing nothing under the pointer. It is the same collision index.css records
 * against .cv-accent-tile, which cost the real @ tile its hover for months.
 *
 * SO THE INACTIVE ROW DECLARES NOTHING: the dim color is inherited from the rail, and no background
 * at all leaves the class free to paint one. THE ACTIVE ROW STILL DECLARES BOTH, which keeps it
 * lit under the pointer instead of washing to the hover tint — the behaviour the real rail spells
 * out as .cv-nav-item[aria-current="page"]:hover.
 *
 * WORTH KNOWING WHILE READING ServiceNav: the real rows DO set both inline, so their hover is
 * currently dead on the same rule. That is the app's bug to fix on the app's own pass, not
 * something for a marketing graphic to reach across and change.
 */
function SpineItem({ icon, active = false }: { icon: React.ReactNode; active?: boolean }) {
  return (
    <span className="cv-nav-item" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 38, height: 38, flexShrink: 0, borderRadius: 11,
      ...(active ? { background: 'var(--nav-selected)', color: 'var(--text-bright)' } : null),
    }}>{icon}</span>
  )
}

function AppMockup() {
  return (
    <div className="cv-lp-mock" style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)',
      boxShadow: 'var(--e3)', overflow: 'hidden', textAlign: 'left',
    }}>
      {/* Browser chrome */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        {[0, 1, 2].map(i => <span key={i} style={{ width: 9, height: 9, borderRadius: 'var(--r-pill)', background: 'var(--border)' }} />)}
      </div>

      <div style={{ display: 'flex' }}>
        {/* ── The service spine ──────────────────────────────────────────────────
            THE APP'S SHELL, AT 64px. This drew a 190px labelled sidebar with a "Total balance"
            card under the lockup — the shell as it stood before V3. Three things went:

              * THE LABELS became tooltips, which a still can neither show nor needs to.
              * THE BALANCE CARD was deleted outright. shell/ServiceNav gives the reason: the
                wallet's whole point is now one centred figure, and a second copy of that same
                number 200px to its left is the screen saying the most important thing twice.
              * THE ADDRESS went with the width. The identity is the bare "@" tile now; the full
                value lives on `title` in the app, which this tile has no equivalent of — it hovers
                like the real one but explains nothing, and a graphic has nothing to explain.

            THE @ SERVICE ROW IS NOT MISSING, IT IS GONE. A third row sat here, between chat and the
            spacer, months after ServiceNav dropped it: CNS stopped being a service and became a
            thing you open inside chat, and the rail row went with it. The tile at the BOTTOM is a
            different @ entirely — that one is the identity, it is still in the real spine, and it
            stays. See the "TWO SERVICES, NOT THREE" note in ServiceNav.

            IT HOVERS NOW, AND ONLY HERE. The rail carries the app's own .cv-nav-item and
            .cv-accent-tile, so the rows and the identity tile answer the pointer exactly as the
            real ones do. The PANE beside it cannot: WalletStill is inert, and inert takes a subtree
            out of hit testing, so its buttons never see a hover to respond to. The asymmetry is
            measured rather than chosen — see the .cv-lp-mock block in LANDING_CSS.

            HAND-DRAWN, NOT IMPORTED, like the rest of this mockup — ServiceNav reads useWallet()
            for that tooltip and navigates on a click, and a marketing graphic wants neither. The
            geometry is copied from it on purpose: 64 wide, a 32 mark, three 38 buttons, a 30
            identity tile. NO RIGHT BORDER, also per the design — the pane beside it draws its own.

            AN ALWAYS-DARK ISLAND, again like the real one: the spine is navy in both themes, so it
            pins data-theme="dark" and everything inside resolves the dark ramp whatever the page
            around it is set to. That is what lets it use ordinary role tokens rather than the
            #FFFFFF and --navy-200 literals this rail used to carry. Same mechanism as the vault
            hero below it; see the note over the LIGHT ROLE TOKENS block in index.css. */}
        <div className="cv-lp-rail" data-theme="dark" style={{
          width: 64, flexShrink: 0, background: 'var(--nav-ground)',
          // THE DIM INK LIVES HERE, not on the rows — see SpineItem. Inherited, it is something
          // .cv-nav-item:hover can override; declared on each row, it is something that outranks it.
          color: 'var(--text-body-dim)',
          padding: '14px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        }}>
          {/* Decorative — no onClick, so LogoTile draws a plain span with no hover and no focus
              ring. It is a picture of the spine, not the spine. LEFT STATIC WHILE THE ROWS BELOW IT
              CAME ALIVE: the real mark is the way back to the landing page, and this IS the landing
              page, so a hover here would advertise the one journey in the rail that has nowhere to
              go. */}
          <LogoTile size={32} style={{ marginBottom: 10 }} />
          <SpineItem icon={<Wallet size={15} />} active />
          <SpineItem icon={<Message size={15} />} />
          <span style={{ flex: 1, minHeight: 24 }} />
          {/* The identity tile — STILL A ROW IN THE REAL SPINE, unlike the @ service tab that used to
              sit above it. .cv-accent-tile is ServiceNav's own class here too, `!important` and all,
              which is what gets a hover past the inline accent fill. */}
          <span className="cv-accent-tile" style={{
            width: 30, height: 30, borderRadius: 9, background: 'var(--accent-400)',
            color: 'var(--ink-on-accent)', fontSize: 11, fontWeight: 600, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>@</span>
        </div>

        {/* The wallet pane — the real components, over mock props. See WalletStill: the header
            cluster is drawn there too, because it belongs inside the same inert subtree. */}
        <div style={{ flex: 1, padding: '20px 24px 24px', minWidth: 0 }}>
          <WalletStill />
        </div>
      </div>
    </div>
  )
}

// ── Sections ──────────────────────────────────────────────────────────────────

const STEPS = [
  { icon: <Browser />, title: 'Launch Caravel', body: 'Open the app in your browser. Nothing to install.' },
  { icon: <Wallet size={18} />, title: 'Create your wallet', body: 'Generated on your device. Your keys never leave it.' },
  { icon: <Key />, title: 'Save your recovery phrase', body: 'Your 24 words. The only way back in, held by you.' },
  { icon: <ArrowOut size={18} />, title: 'Start transacting', body: 'Send, receive, message, and claim your @name on the Ootle.' },
]

/**
 * Reveal a section once, when it scrolls properly into view.
 *
 * LIFTED OUT OF HowItWorks WHEN THE SECOND CALLER ARRIVED, and not before — the landing page has
 * an in-repo account of what the other order costs. LogoTile's header note records four hand-drawn
 * copies of one tile that had already drifted to radii of 30%, 30%, 28% and 31%, "chosen by eye
 * rather than by rule", because the thing all four drew was never a thing in the codebase.
 *
 * THE OBSERVER IS NOT THE VALUABLE PART. It is four lines, and anyone would write them the same
 * way. The three decisions BELOW are the part worth having once: which way the guard fails, when
 * the disconnect happens, and that the flag only ever moves forwards. Each is a line of code and a
 * paragraph of reason, and duplicating that pair is how the second copy ends up with the code and
 * an abbreviated version of the reason — which is the copy someone later "fixes".
 *
 * WHAT THE CALLER GETS is a ref to hang on the container and a flag to key a class off. The
 * hidden-at-rest styling and the stagger stay with the section that owns them; two sections
 * revealing the same way should not imply they MOVE the same way.
 */
function useRevealOnce(threshold = 0.4) {
  const ref = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    // REVEALS RATHER THAN RETURNS, and the difference is the whole section. Constructing a missing
    // IntersectionObserver also throws inside an effect, which React propagates, so this cannot
    // simply be left to fail — but bailing out silently would leave a hidden-at-rest section with
    // nothing left to move it. Showing it is the honest fallback: no animation, which was never
    // available here, and no blank column either.
    if (typeof IntersectionObserver === 'undefined') { setRevealed(true); return }
    const el = ref.current
    if (!el) { setRevealed(true); return }

    const io = new IntersectionObserver(
      hits => {
        if (!hits.some(h => h.isIntersecting)) return
        setRevealed(true)
        // Immediately, not on unmount: the work is finished the moment it fires, and disconnecting
        // here is what makes the reveal unrepeatable rather than merely unrepeated.
        io.disconnect()
      },
      { threshold },
    )
    io.observe(el)
    // For the section that never intersects before the page is left.
    return () => io.disconnect()
  }, [threshold])

  return [ref, revealed] as const
}

/**
 * The four steps, revealed left to right as the section arrives.
 *
 * ── HIDDEN UNTIL THE SECTION IS PROPERLY ON SCREEN ───────────────────────────
 *
 * The steps rest hidden and the class reveals them, which is the ordinary way round and, here, the
 * only one that produces a reveal at all. The inverse was tried first — resting visible so the
 * animation could only ever be additive — and it failed on the thing it was for: a visitor
 * scrolling down meets the steps ALREADY READABLE, and the cascade then plays over four columns
 * they have been looking at for half a second. An entrance for something that already entered.
 *
 * THE COST IS REAL AND ACCEPTED: hidden at rest means a section that stays blank if the reveal
 * never runs, rather than one that merely does not animate. The guard below is what keeps that
 * down to a single failure — a browser with no IntersectionObserver reveals immediately instead of
 * waiting for a scroll event that will never be reported.
 *
 * THE THRESHOLD IS PART OF THE EFFECT, not a tuning detail. At a fifth of the row the cascade
 * starts while the steps are still entering, so the later ones land off the bottom of the window;
 * at two fifths the row is genuinely on screen when step one moves, and the eye has somewhere to
 * follow it to. That two fifths is now useRevealOnce's default, which is where the number should
 * live: the partners section wants the same one, and two sections agreeing by accident is a
 * weaker thing than two sections agreeing by construction.
 *
 * REVEAL-ONCE, THE DISCONNECT AND THE FALLBACK all moved into that hook with the observer. The
 * stagger and the hidden-at-rest rules did NOT: how a section reveals is shared, what it does
 * while revealing is its own.
 */
function HowItWorks() {
  const [steps, revealed] = useRevealOnce()

  return (
    <section id="how" className="cv-lp-section">
      <H2>How it works</H2>
      <div ref={steps} className={revealed ? 'cv-lp-steps cv-lp-steps-in' : 'cv-lp-steps'}>
        {STEPS.map((s, i) => (
          <div key={s.title} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <span style={{
              position: 'relative', width: 46, height: 46, borderRadius: 13,
              background: 'var(--lp-tile)', color: 'var(--lp-tile-ink)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              {s.icon}
              <span style={{
                position: 'absolute', top: -7, right: -7, width: 20, height: 20,
                borderRadius: 'var(--r-pill)', background: 'var(--accent-400)', color: '#FFFFFF',
                fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{i + 1}</span>
            </span>
            <h3 style={{ margin: '18px 0 0', fontSize: 16.5, fontWeight: 600, color: 'var(--text-primary)' }}>{s.title}</h3>
            <p style={{ margin: '7px 0 0', maxWidth: 220, fontSize: 14, lineHeight: 1.6, color: 'var(--text-body-dim)', textWrap: 'pretty' }}>{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

/** One service row: copy on one side, a navy demo card on the other. `flip` puts the card first. */
function ServiceRow({ title, body, card, flip = false }: {
  title: string; body: string; card: React.ReactNode; flip?: boolean
}) {
  const copy = (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{title}</h3>
        <Pill tone="live">Live</Pill>
      </div>
      <p style={{ margin: '14px 0 0', maxWidth: 400, fontSize: 16, lineHeight: 1.65, color: 'var(--text-body-dim)', textWrap: 'pretty' }}>{body}</p>
    </div>
  )
  // The card is ordered FIRST in the DOM when flipped so the visual alternation survives the
  // single-column breakpoint without a second set of rules — at narrow widths the reader gets
  // copy-then-card for rows 1 and 3, and card-then-copy for row 2, exactly as the design reads.
  return <div className="cv-lp-service">{flip ? <>{card}{copy}</> : <>{copy}{card}</>}</div>
}

const SOON = [
  { icon: <Swap />, label: 'Swap' },
  { icon: <Bridge />, label: 'Bridge' },
  { icon: <Pools />, label: 'Pools' },
]

function Services() {
  return (
    <section className="cv-lp-section">
      <H2 narrow>One app. A growing set of private services.</H2>
      <ServiceRow
        title="Wallet"
        body="Private and public balances in one place. Make funds private or public. Your money, your call."
        card={<WalletStill compact />}
      />
      <ServiceRow
        flip
        title="Chat"
        body="End-to-end encrypted messaging, tied to your wallet. Claim an @name so people can reach you by name — private messaging and private money, one conversation."
        card={<ChatStill />}
      />
      <div className="cv-lp-soon">
        {SOON.map(s => (
          <div key={s.label} style={{
            border: '1px dashed var(--border-strong)', borderRadius: 16, padding: '18px 24px',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ width: 34, height: 34, borderRadius: 'var(--r-md)', border: '1px solid var(--border)', color: 'var(--text-muted-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.icon}</span>
            <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text-body-dim)' }}>{s.label}</span>
            <Pill tone="quiet">Coming soon</Pill>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * The two partner cards, flipping in from edge-on as the pair arrives.
 *
 * THE SAME ARRIVAL AS THE STEPS, DELIBERATELY — useRevealOnce at the same threshold, revealed once,
 * hidden at rest, the same 220ms beat between siblings. The two sections should read as one design
 * language rather than two people's ideas about scroll animation.
 *
 * A DIFFERENT MOVE WITHIN IT, equally deliberately: the steps rise, these turn. Four small items
 * introducing a sequence want the lightest possible motion; two large cards presenting who stands
 * behind the product can afford a gesture with some weight, and a flip gives them one without
 * either section borrowing the other's.
 *
 * THE CARDS ARE HAND-WRITTEN, NOT MAPPED, unlike STEPS — and it costs the reveal nothing, because
 * the stagger keys off nth-child and DOM position does not care how the markup was produced. That
 * is also why neither card needed touching: the ref and the class go on the container.
 */
function Backing() {
  const [partners, revealed] = useRevealOnce()
  const card = (extra: React.CSSProperties = {}): React.CSSProperties => ({
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18,
    padding: '44px 40px', boxShadow: 'var(--e1)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', ...extra,
  })
  const logo: React.CSSProperties = {
    width: 84, height: 84, borderRadius: 22, overflow: 'hidden', border: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }
  const img: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' }
  return (
    <section className="cv-lp-section">
      <H2>Backing and ecosystem</H2>
      <div ref={partners} className={revealed ? 'cv-lp-partners cv-lp-partners-in' : 'cv-lp-partners'}>
        <div style={card()}>
          {/* White plate behind the DNC mark — its artwork is drawn for a light ground. */}
          <span style={{ ...logo, background: '#FFFFFF' }}>
            <img src="/partner-dnc.png" alt="Digital Node Capital" style={img} />
          </span>
          <h3 style={{ margin: '24px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Digital Node Capital</h3>
          <div style={{ marginTop: 10 }}><Pill tone="mono">BACKER</Pill></div>
          <p style={{ margin: '24px 0 0', maxWidth: 340, fontSize: 16.5, lineHeight: 1.6, fontWeight: 500, color: 'var(--text-primary)', textWrap: 'pretty' }}>
            &ldquo;We back builders making privacy usable. Caravel does exactly that.&rdquo;
          </p>
          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 500, color: 'var(--text-muted-dim)' }}>DNC</div>
        </div>
        <div style={card()}>
          <span style={logo}><img src="/partner-tari.jpg" alt="Tari" style={img} /></span>
          <h3 style={{ margin: '24px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>Built on Tari</h3>
          <div style={{ marginTop: 10 }}><Pill tone="mono">PROTOCOL</Pill></div>
          <p style={{ margin: '24px 0 0', maxWidth: 340, fontSize: 16.5, lineHeight: 1.6, fontWeight: 500, color: 'var(--text-primary)', textWrap: 'pretty' }}>
            Caravel runs on the Ootle, Tari&rsquo;s layer two for private, confidential transactions. Proven on chain.
          </p>
        </div>
      </div>
    </section>
  )
}

const FAQS: { q: string; a: string }[] = [
  { q: 'Is Caravel really self-custodial?', a: 'Yes. Your keys are generated on your device and never leave it. Not even Caravel can access your funds.' },
  { q: 'What if I lose my recovery phrase?', a: 'Your 24 words are the only way back in. Caravel cannot recover them for you, that is the nature of self-custody. Store them safely offline.' },
  { q: 'How is my activity kept private?', a: 'Balances can be made private and confidential on the Ootle, and messages are end-to-end encrypted. You choose what stays visible.' },
  { q: 'Can I use real funds?', a: 'Not yet. Caravel runs on the Tari Esmeralda testnet. It is experimental and for testing, not for real value.' },
  { q: 'What are Tari and the Ootle?', a: 'Tari is the ecosystem Caravel is built on. The Ootle is its layer two for private, confidential transactions.' },
  { q: 'What is coming next?', a: 'Swap, Bridge, and Pools are on the way, expanding Caravel into the everything app for private crypto.' },
]

/**
 * The FAQ.
 *
 * ONE open at a time, and pressing the open one closes it — the design's `openFaq: -1`. Kept as an
 * index rather than a Set because that is the behaviour the design specifies; a multi-open
 * accordion is a different component and should not arrive by accident.
 */
function Faq() {
  const [open, setOpen] = useState(0)
  return (
    <section className="cv-lp-section">
      <H2>Frequently Asked Questions</H2>
      <div className="cv-lp-faq" style={{ borderTop: '1px solid var(--border)' }}>
        {FAQS.map((f, i) => {
          const isOpen = open === i
          return (
            <div key={f.q} style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                onClick={() => setOpen(isOpen ? -1 : i)}
                aria-expanded={isOpen}
                style={{
                  cursor: 'pointer', width: '100%', background: 'transparent', border: 'none',
                  fontFamily: 'inherit', color: 'var(--text-primary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                  padding: '21px 4px', textAlign: 'left', fontSize: 16.5, fontWeight: 600,
                }}
              >
                <span>{f.q}</span>
                <Chevron color="var(--text-muted-dim)" dir={isOpen ? 'up' : 'down'} />
              </button>
              {isOpen && (
                <p style={{ margin: 0, padding: '0 4px 24px', maxWidth: 600, fontSize: 15, lineHeight: 1.65, color: 'var(--text-body-dim)', textWrap: 'pretty' }}>{f.a}</p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── Scoped stylesheet ─────────────────────────────────────────────────────────
//
// Everything that has to CHANGE with viewport width lives here; colours and one-off offsets stay
// inline. `--lp-tile` / `--lp-tile-ink` are the design's step-tile wash, which is the one place the
// two themes tint DIFFERENT accent steps — 400 on light, 300 on dark, because a .12 wash of 400 on
// a navy ground barely reads.

const LANDING_CSS = `
.cv-lp {
  --lp-tile: rgba(var(--accent-400-rgb), 0.10);
  --lp-tile-ink: var(--accent-500);
  min-height: 100vh;
  background: var(--surface-void);
  color: var(--text-primary);
  font-family: var(--font-ui);
  transition: background 0.25s, color 0.25s;
}
.cv-lp[data-theme="dark"] {
  --lp-tile: rgba(var(--accent-300-rgb), 0.12);
  --lp-tile-ink: var(--accent-300);
}
.cv-lp a { color: var(--accent-600); text-decoration: none; }
.cv-lp[data-theme="dark"] a { color: var(--accent-300); }
.cv-lp a:hover { text-decoration: underline; }
.cv-lp ::selection { background: rgba(var(--accent-400-rgb), 0.22); }

.cv-lp-bar { max-width: 1120px; margin: 0 auto; padding: 22px 40px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.cv-lp-section { max-width: 1120px; margin: 0 auto; padding: 170px 40px 0; }
.cv-lp-hero { max-width: 1120px; margin: 0 auto; padding: 110px 40px 0; text-align: center; }

.cv-lp-h1 { margin: 0 auto; max-width: 840px; font-size: 60px; font-weight: 600;
  letter-spacing: -0.03em; line-height: 1.08; text-wrap: pretty; }
.cv-lp-h2 { font-size: 38px; }

.cv-lp-mock { max-width: 920px; margin: 90px auto 0; }

/* ── THE MOCKUP HOVERS, AND IS STILL NOT A BUTTON ─────────────────────────────
   THE SPINE IS ALIVE AND THE PANE IS NOT, which is a measured outcome rather than a preference.
   The rail reuses the app's own rules — .cv-nav-item on the rows, .cv-accent-tile on the @ tile —
   so there is no second copy of either hover to drift from ServiceNav.

   THE PANE CANNOT JOIN THEM WHILE IT IS INERT. Its controls already carry the right classes
   (.cv-vault-action on Send and Receive, .cv-privacy-action, .cv-asset-row) and they already do
   nothing, because "inert" removes the subtree from HIT TESTING and not merely from clicking:
   probed in Chrome 152, Send under the pointer reports ":hover" unmatched and its filter still
   "none". The only way to buy that hover back is to give up "inert", and with it the tab-order and
   accessibility removals WalletStill exists to guarantee. A brightening button is not worth
   announcing a fake balance to a screen reader, so the pane stays a still.

   THE CURSOR IS THE HONESTY, and it is written for the graphic as a whole rather than for what
   happens to hover today. Anything that ever does reach the pointer in here — the real components
   carry "cursor: pointer" inline, in TotalHero's VaultAction, PrivacyCard's entries, the assets row
   and iconBoxStyle — would otherwise be the picture claiming you can click into the app from the
   landing page. The "!important" is what it takes to beat an inline declaration, the same reason
   .cv-btn-primary and .cv-accent-tile already carry one.

   A HOVER THAT RESPONDS UNDER A CURSOR THAT DOES NOT is the model: alive, not actionable. */
.cv-lp-mock, .cv-lp-mock * { cursor: default !important; }

/* STATIC ON TOUCH, deliberately. A touch browser fires :hover on tap and HOLDS it until you tap
   something else, so on a tablet the rail would sit with one permanently-lit row — the opposite of
   what the hover is for. Dropping the subtree out of hit testing is one declaration against
   resetting every hovered property by hand, and it returns the graphic to exactly the still it is
   on a device with no pointer. (Phones never reach this: the rail is display:none under 460.) */
@media (hover: none) {
  .cv-lp-mock { pointer-events: none; }
}
.cv-lp-steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 36px; margin-top: 64px; }

/* ── THE STEPS ARRIVE ONE AT A TIME ───────────────────────────────────────────
   HIDDEN AT REST, revealed by the class the observer adds. A TRANSITION RATHER THAN A KEYFRAME,
   which is what keeps this honest about where it ends: the revealed rule DECLARES the final
   appearance, so a step that is revealed is simply a step with those values, whatever happens to
   the animation carrying it there. A keyframe would have to be pinned in place by a fill mode to
   hold the same ground, and an interrupted one pinned that way stays wherever it was stopped.

   THE STAGGER IS A DELAY ON THE TRANSITION, not four animations racing. Each step waits its turn
   and then takes the same 0.6s, so the four form one cascade the eye can follow left to right
   rather than a cluster that happens to resolve in order. The last begins at 660ms and lands at
   about 1.26s after the trigger — long enough to read as a sequence, short enough that nobody
   waiting to read the section notices they were waiting.

   THE ORDER SURVIVES THE REFLOW for free. The delays key off nth-child, the grid is plain 1fr
   columns with no "order" or reversal anywhere, so source order is visual order at every width:
   left to right across four, reading order through the 2x2 at 1024, and top to bottom once it
   stacks at 640. */
.cv-lp-steps > div {
  opacity: 0; transform: translateY(12px);
  transition: opacity 0.6s ease-out, transform 0.6s ease-out;
}
.cv-lp-steps-in > div { opacity: 1; transform: translateY(0); }
.cv-lp-steps-in > div:nth-child(1) { transition-delay: 0ms; }
.cv-lp-steps-in > div:nth-child(2) { transition-delay: 220ms; }
.cv-lp-steps-in > div:nth-child(3) { transition-delay: 440ms; }
.cv-lp-steps-in > div:nth-child(4) { transition-delay: 660ms; }
.cv-lp-service { display: grid; grid-template-columns: 1fr 1fr; gap: 72px; align-items: center;
  max-width: 980px; margin: 80px auto 0; }
.cv-lp-service ~ .cv-lp-service { margin-top: 96px; }
.cv-lp-soon { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px;
  max-width: 980px; margin: 96px auto 0; }
.cv-lp-partners { display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
  max-width: 880px; margin: 56px auto 0;
  /* THE PERSPECTIVE BELONGS TO THE CONTAINER AND NOWHERE ELSE. This property applies to an
     element's DIRECT CHILDREN, so here it is what gives the two cards their depth; moved onto a
     card it would apply to that card's CONTENTS instead, and the card's own rotation would project
     flat — the horizontal squash that looks like a broken animation rather than a misplaced line.
     The cards are direct children of this grid, with no wrapper between, which is what makes one
     declaration reach both.

     1200px BECAUSE THE PAIR IS 880px WIDE. The two centres sit about 215px either side of the
     vanishing point, near enough that they read as two panels in one scene; nearer 600px and the
     off-axis edges visibly shear. */
  perspective: 1200px;
}

/* ── THE PAIR TURNS TO FACE YOU ───────────────────────────────────────────────
   HIDDEN AT REST AT A QUARTER TURN. At exactly 90 degrees a card projects to zero width, so it is
   genuinely not on screen rather than merely transparent — the rotation IS the hiding, and the
   opacity beside it only covers the sub-pixel sliver a browser can leave at the exact edge. It
   goes solid in 0.35s against the turn's 0.6s, so the card is a card early and the FLIP is the
   thing you watch, rather than a fade that happens to be rotating.

   NO backface-visibility, deliberately rather than by omission: this never travels past 90
   degrees, so the reverse face is never turned toward the viewer and there is nothing to hide.
   Adding it would promote a layer to solve a problem this animation does not have.

   THE REVEALED STATE IS "none", NOT "rotateY(0deg)", and the two are not the same thing at rest.
   They interpolate identically — "none" is the identity — but a card left holding a transform
   stays on a composited layer afterwards, where text is resampled and reads faintly soft. Ending
   at no transform at all hands the card back to ordinary rendering the moment it lands.

   SAME 220ms BEAT AS THE STEPS, and the same 0.4 threshold through useRevealOnce, so the two
   sections are consistent by construction rather than by two people choosing similar numbers.
   nth-child means the order survives the reflow: side by side above 1024, and top then bottom
   once the grid drops to one column beneath it. */
.cv-lp-partners > div {
  opacity: 0; transform: rotateY(90deg);
  transition: opacity 0.35s ease-out, transform 0.6s ease-out;
}
.cv-lp-partners-in > div { opacity: 1; transform: none; }
.cv-lp-partners-in > div:nth-child(1) { transition-delay: 0ms; }
.cv-lp-partners-in > div:nth-child(2) { transition-delay: 220ms; }
.cv-lp-faq { max-width: 680px; margin: 48px auto 0; }
.cv-lp-footer { max-width: 1120px; margin: 150px auto 0; padding: 34px 40px 44px;
  border-top: 1px solid var(--border); display: flex; align-items: center;
  justify-content: space-between; gap: 20px; flex-wrap: wrap; }

.cv-lp-primary { transition: background 0.15s; }
.cv-lp-primary:hover { background: var(--accent-hover) !important; }

/* ── ≤1024: the multi-column grids collapse; the rhythm tightens ── */
@media (max-width: 1024px) {
  .cv-lp-bar, .cv-lp-hero, .cv-lp-section, .cv-lp-footer { padding-left: 28px; padding-right: 28px; }
  .cv-lp-section { padding-top: 120px; }
  .cv-lp-hero { padding-top: 80px; }
  .cv-lp-h1 { font-size: 44px; }
  .cv-lp-h2 { font-size: 30px; }
  .cv-lp-mock { margin-top: 64px; }
  .cv-lp-steps { grid-template-columns: repeat(2, 1fr); gap: 40px 28px; margin-top: 48px; }
  .cv-lp-service { grid-template-columns: 1fr; gap: 32px; margin-top: 56px; }
  .cv-lp-service ~ .cv-lp-service { margin-top: 72px; }
  .cv-lp-soon { grid-template-columns: 1fr; margin-top: 72px; }
  .cv-lp-partners { grid-template-columns: 1fr; }
  .cv-lp-footer { margin-top: 110px; }
}

/* ── ≤640: single column throughout, and the display sizes come down again ── */
@media (max-width: 640px) {
  .cv-lp-bar, .cv-lp-hero, .cv-lp-section, .cv-lp-footer { padding-left: 20px; padding-right: 20px; }
  .cv-lp-section { padding-top: 96px; }
  .cv-lp-h1 { font-size: 34px; }
  .cv-lp-h2 { font-size: 26px; }
  .cv-lp-steps { grid-template-columns: 1fr; gap: 36px; }
  .cv-lp-hero-ctas { flex-direction: column; gap: 16px !important; }
  /* The mockup's wallet header: the title takes one line and the chip-plus-three-controls
     cluster the next, rather than the row refusing to shrink. This is what keeps the spine's
     breakpoint below where it would otherwise have to go — see the rule under this block.
     (It replaces a .cv-lp-asset rule that did the same job for the hand-drawn assets row; that
     row is AssetsPanel now, and brings its own.) */
  .cv-lp-mockhead { flex-wrap: wrap; row-gap: 10px; }
  .cv-lp-footer { justify-content: flex-start; }
}

/* ── ≤460: the last width where the spine still leaves the pane room ──
   THIS USED TO BE 880, when the rail was a 190px labelled sidebar carrying a
   balance card. At 64px it costs a third of that, so it survives every tablet
   and laptop width and most phones — which matters, because a wallet pane with
   no shell around it is not a picture of the app at all.

   RE-DERIVED FOR THE V3 HEADER, which roughly doubled the row this number comes
   from: one 26px control became a ~156px chip plus three 30px boxes, taking the
   unshrinkable header from ~227px to ~344px. Straight through, that would have
   forced the spine out at ~500px and lost it on every phone. The header wraps at
   640 instead (.cv-lp-mockhead above), so the binding width is now the right-hand
   cluster alone — about 270px, plus 48px of pane padding, the 64px spine and the
   card's two borders, over the 20px section gutters. That lands near 424px.

   THE FIGURES ARE DERIVED FROM THE FLEX CONSTRAINTS, NOT MEASURED, and carry
   perhaps 15px of error each; 460 is where the rule sits so they have room to be
   wrong. Erring high is the cheap direction: the mockup's outer card is
   "overflow: hidden", so overshooting CLIPS the pane rather than scrolling it,
   while undershooting only drops a 64px decoration slightly early. */
@media (max-width: 460px) {
  .cv-lp-rail { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .cv-lp, .cv-lp-primary, .cv-icon-btn { transition: none; }
  /* The rail's newly-live hovers, which ease in index.css. SCOPED TO THE MOCK, because these are
     shared app classes: the setting is the visitor's rather than this page's, and the app answers
     it on its own surfaces without the landing page reaching across into them. The pane's classes
     are deliberately absent — nothing in there hovers; see the .cv-lp-mock note above. */
  .cv-lp-mock .cv-nav-item, .cv-lp-mock .cv-accent-tile { transition: none; }
}
`

// ══════════════════════════════════════════════════════════════════════════════

export default function LandingPage() {
  const navigate = useNavigate()
  // The APP's theme, not a second copy of it. This page used to hold its own state over the same
  // storage key, and paint <body> by hand because the attribute was scoped to its own subtree. The
  // provider puts data-theme on <html>, so <body> is already correct and the choice a visitor makes
  // here is the one the gate screens and the wallet open in.
  const { theme } = useTheme()

  const onOpenApp = useCallback(() => navigate('/app'), [navigate])

  return (
    // The attribute stays for the scoped --lp-tile rules below; the value now comes from the app.
    <div className="cv-lp" data-theme={theme}>
      <style>{LANDING_CSS}</style>

      {/* Top bar */}
      <div className="cv-lp-bar">
        <Lockup tile={32} text={18} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <ThemeToggle />
          <LaunchButton onClick={onOpenApp} />
        </div>
      </div>

      {/* Hero */}
      <section className="cv-lp-hero">
        <h1 className="cv-lp-h1">Caravel is a vessel for a new era of private exchange.</h1>
        <div style={{ margin: '26px auto 0', fontSize: 22, fontWeight: 500, color: 'var(--text-body-dim)' }}>
          A Swiss bank account in your pocket.
        </div>
        <div className="cv-lp-hero-ctas" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22, marginTop: 38 }}>
          <LaunchButton onClick={onOpenApp} big />
          <a href="#how" style={{ fontSize: 15, fontWeight: 500 }}>See how it works.</a>
        </div>
        <AppMockup />
      </section>

      <HowItWorks />
      <Services />
      <Backing />
      <Faq />

      {/* Closing CTA */}
      <section className="cv-lp-section" style={{ textAlign: 'center' }}>
        <H2>Ready to go private?</H2>
        <div style={{ marginTop: 32 }}><LaunchButton onClick={onOpenApp} big /></div>
      </section>

      {/* Footer */}
      <footer className="cv-lp-footer">
        <Lockup tile={26} text={15} />
        <div style={{ display: 'flex', gap: 26, fontSize: 14 }}>
          {/* About and Docs have no destinations yet — deliberately inert rather than pointing
              somewhere wrong. The X link is real. */}
          <a href="#" style={{ color: 'var(--text-body-dim)' }}>About</a>
          <a href="#" style={{ color: 'var(--text-body-dim)' }}>Docs</a>
          <a href="https://x.com/Caravelxyz" target="_blank" rel="noreferrer noopener" style={{ color: 'var(--text-body-dim)' }}>X</a>
        </div>
        <div style={{ width: '100%', fontSize: 12.5, color: 'var(--text-muted-dim)', fontFamily: 'var(--font-mono)' }}>
          Running on the Tari Esmeralda testnet. Self-custodial and experimental. Don&rsquo;t use for real value.
        </div>
      </footer>
    </div>
  )
}
