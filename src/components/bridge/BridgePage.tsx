//   Bridge — the roadmap tab.
//
//   ── A TEASER, AND IT HAS TO STAY ONE ─────────────────────────────────────────
//
//   This page has no button, no input, no form, no amount field, no asset picker and no read of
//   WalletContext. That is not an oversight to be filled in later; it is the whole point. A bridge
//   is the one feature where a control that looks live and is not costs someone real money in a
//   real asset, so the page says what we are building in words and offers nothing to press.
//
//   THE TWO CHIPS DO THE SAME WORK FROM THE OTHER END. "ROADMAP · IN DEVELOPMENT" sits in the page
//   header where a live tab would put its primary action, and the closing callout repeats it in a
//   sentence. Anyone who reads only the chrome, and anyone who reads only the prose, gets told.
//
//   ── THE CHROME IS WALLETPAGE'S, DELIBERATELY ─────────────────────────────────
//
//   Outer scroller, PAGE_MAX_WIDTH column, the same clamp padding. Copied structurally from
//   WalletPage rather than invented, because the spine now has three rows and a tab that scrolls or
//   gutters differently from its neighbours reads as a different app rather than a different page.
//
//   THE DESIGN'S HEADER BAR IS NOT BUILT. "Caravel Dapp (Bridge).dc.html" draws a bordered bar
//   across the top of the pane carrying the title and the two chips. No other service here has one
//   — the wallet page starts at its content, chat brings its own header — so building it would have
//   given Bridge a piece of shell chrome that exists on exactly one tab. The bar's CONTENTS are all
//   here; they are the first block of the scrolling column instead of a fixed strip above it.
//
//   ── THE ARTWORK IS DRAWN, NOT PLATED ─────────────────────────────────────────
//
//   This page carried a raster for about an hour: bridge-teaser.png, behind a light plate, because
//   the render is baked for the dapp's LIGHT theme and would otherwise have been a glowing slab on
//   navy-950. Both halves of that are now gone. The plate is gone because there is nothing light
//   left to host, and the raster is gone because it never arrived intact — see BridgeTeaser, which
//   redraws the artboard from its own coordinates and follows the theme like the rest of the app.
//
//   NOTHING REFERENCES /bridge-teaser.png ANY MORE, and no such file is in public/.

import { Callout, Chip } from '../primitives'
import { PAGE_MAX_WIDTH } from '../wallet/v2/tokens'
import BridgeTeaser from './BridgeTeaser'

const PARAGRAPHS = [
  "Caravel Labs' mission is to ensure the Tari ecosystem is not an island. We believe the strongest path to that goal is a bridge that brings wrapped assets onto the Ootle, giving them programmable privacy for the first time.",
  'Guided by current market demand, we believe Bitcoin, Monero, and Zcash are the assets that would benefit most from this integration: bringing the liquidity and communities of the largest privacy assets into a programmable, confidential environment.',
  'We are actively pursuing funding to accelerate this research, and are in contact with the Tari Council regarding grants to speed the process.',
]

/** The callout's circled-i, at the size Callout's own 13px body sits beside. */
function InfoIcon() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      style={{ flexShrink: 0, marginTop: 2 }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" />
    </svg>
  )
}

export default function BridgePage() {
  return (
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      <div style={{
        maxWidth: PAGE_MAX_WIDTH, margin: '0 auto',
        padding: 'clamp(16px, 3vw, 32px) clamp(16px, 3vw, 32px) 48px',
        display: 'flex', flexDirection: 'column', gap: 28,
      }}>
        {/* The header bar's contents, as content: name on the left, status on the right, the two
            pushed apart across the measure the way the design's bar holds them.

            NO NETWORK BADGE. It said "Esmeralda testnet", which is true of the wallet and the chat
            because those talk to it. Nothing on this page talks to anything — naming the network a
            roadmap page does not use invites the reading that the bridge is live on it, which is
            the one impression this page exists to avoid.

            `wrap` because there are no media queries in this app: in a narrow pane the chip drops
            under the title rather than crushing it, and `gap` is what separates them once it has. */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <h1 style={{
            margin: 0, fontSize: 21, fontWeight: 600, letterSpacing: '-0.015em',
            color: 'var(--text-primary)',
          }}>Bridge</h1>
          {/* NO LEADING DOT. It read as a status light — the thing a connection indicator uses to
              say "live" — on a pill whose whole job is to say the opposite. The words carry it. */}
          <Chip mono style={{ letterSpacing: '0.12em', fontSize: 10.5 }}>
            ROADMAP · IN DEVELOPMENT
          </Chip>
        </div>

        {/* The teaser, in a frame.

            THE FRAME IS NOT THE OLD PLATE COMING BACK. The plate was #F6F8FA — a light ground
            imported to host artwork baked for a light theme, and it went when the artwork stopped
            being a raster. This is a dark surface with a hairline: --surface is navy-900, one step
            ABOVE the page's navy-950, so it reads as a card cut out of the page rather than a hole
            punched into it. The graphic inside is untouched and still draws its own cards on
            --surface-raised, which stays a step above this, so the depth order still runs
            page → frame → cards in the right direction.

            The padding is what the border buys: the artboard runs its column headings and its
            outermost nodes close to the edge, and a hairline drawn tight against them reads as a
            crop. Fluid, like every other measure on this page. */}
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          padding: 'clamp(14px, 2.2vw, 26px)',
        }}>
          <BridgeTeaser />
        </div>

        {/* The prose: left-aligned, and the full width of the content column.

            NO MEASURE CAP. The design sets the prose in a 720 column, which is the right call on a
            1600 artboard where 720 IS the measure and the rest is margin. Here it is not: this page
            is already inside PAGE_MAX_WIDTH, so a second cap nested in the first left the text
            ending well short of the frame above it and read as an indent nobody asked for. One
            column, one width — the heading, the paragraphs and the callout now start and end on the
            same axes as the header row and the teaser frame.

            `textAlign: left` is stated rather than left to the default, because it is a decision
            here and not an accident: the block was briefly centred, and writing it down is what
            stops the next reader assuming the default is doing the work. It is inherited, so the
            callout's body follows without the callout knowing. */}
        <div style={{
          width: '100%', textAlign: 'left',
          display: 'flex', flexDirection: 'column', gap: 18,
        }}>
          <h2 style={{
            margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.015em',
            color: 'var(--text-primary)', textWrap: 'pretty',
          }}>Bringing liquidity to the Ootle.</h2>

          {PARAGRAPHS.map(text => (
            <p key={text.slice(0, 24)} style={{
              margin: 0, fontSize: 15, lineHeight: 1.7,
              color: 'var(--text-body-dim)', textWrap: 'pretty',
            }}>{text}</p>
          ))}

          <Callout tone="note" icon={<InfoIcon />} style={{ marginTop: 4 }}>
            This is early and in development. It reflects the direction Caravel is building toward,
            not a live feature today.
          </Callout>
        </div>
      </div>
    </div>
  )
}
