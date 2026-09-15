//   The Bridge teaser — the roadmap graphic, drawn rather than rasterised.
//
//   ── WHY THIS IS CODE AND NOT A PNG ───────────────────────────────────────────
//
//   It was a PNG first. "Caravel Bridge Teaser.dc.html" exports a 1600×900 artboard, and the plan
//   was to ship that render behind a light plate. Two things killed it. The fetch cap truncated the
//   file mid-IDAT at exactly 192 KiB — a PNG that passes a byte-count check and fails on screen,
//   which is the trap the OG card already taught us once. And the render is baked LIGHT: #F6F8FA
//   ground, white cards, near-black text, which on navy-950 is a glowing slab that no plate makes
//   honest, only framed.
//
//   The source was never really a raster anyway. Strip the four coin marks and the artboard is
//   curves, rectangles and type — so it is rebuilt here from the design's own coordinates, and it
//   follows the theme like everything else the app draws. NO PLATE. It sits on the page ground.
//
//   ── THE COORDINATES ARE THE DESIGN'S, THE SIZES ARE NOT ──────────────────────
//
//   Every curve, dot and box below is transcribed from the artboard unchanged, and the connector
//   SVG keeps the design's own 1600×600 viewBox so the `d` strings are copied, not recomputed. What
//   could not survive is the TYPE SCALE. The artboard is 1600 wide and this page's column caps at
//   1040; at that width the design's 11px labels land at under 7px, which is not small type, it is
//   no type. So sizes are expressed in `cqw` against the container and clamped at both ends: the
//   geometry scales, the words stay readable, and at the page's full width they land within a
//   pixel of the sizes the design drew.
//
//   `container-type: inline-size` is what makes cqw mean "of this graphic" rather than "of the
//   viewport" — which matters, because this box is a column inside a page inside a shell, and none
//   of those are the window.
//
//   ── NO MEDIA QUERIES, BECAUSE THE APP HAS NONE ───────────────────────────────
//
//   src/index.css and App.css contain zero @media rules; everything fluid here is fluid by clamp
//   and flex. The band holds its 8:3 aspect and scales, so there is no breakpoint at which this
//   graphic reflows into a different drawing — it is the same drawing, smaller.
//
//   THE ROADMAP BADGE IS NOT DRAWN HERE. The design puts one in the artboard's top right, but
//   BridgePage already renders that exact chip in its header block a few rows above. Two identical
//   "ROADMAP · IN DEVELOPMENT" pills a screen-inch apart is a defect, not a design. Moving it into
//   the graphic instead is a two-line change if that is the call.

import Logo from '../primitives/Logo'

/** The artboard's band. Every absolute position below is a percentage of these. */
const BAND_W = 1600
const BAND_H = 600

/** The design's accent, which is already our token — the artboard and the app agree here. */
const WIRE = 'var(--accent-400)'

/**
 * Tari's purple, the one literal in this file.
 *
 * It is a THIRD-PARTY BRAND COLOUR, so it is not ours to resolve through a role token — the Ootle
 * tile is the Ootle's, the way the sail beside it is Caravel's. The artboard draws the border at
 * #9B6BFF and the label at #7A4FD0; the label is lifted to the border's value here because #7A4FD0
 * was chosen to sit on white and disappears on navy.
 */
const OOTLE = '#9B6BFF'

/** left/top/width in artboard px → percentages, so one number can be read against the design. */
const pc = (v: number, of: number) => `${(v / of) * 100}%`

/** The design's own type sizes, in artboard px. See the header note on cqw. */
const type = (px: number, min: number, max: number) => `clamp(${min}px, ${(px / BAND_W) * 100}cqw, ${max}px)`

const LABEL = {
  fontFamily: 'var(--font-mono)',
  fontSize: type(11, 8.5, 11),
  letterSpacing: '0.16em',
  color: 'var(--text-muted-dim)',
  textAlign: 'center',
} as const

/**
 * The three native assets, each the artboard's 94px mark inside its 104px dashed ring.
 *
 * THE MARKS ARE THE ONLY RASTERS IN THIS DRAWING, and they are the right ones to be: they are
 * other people's brand artwork, so redrawing them by eye is precisely what primitives/Logo argues
 * against for our own sail. Everything around them is vector and themed; these three are fixed
 * artwork and should be.
 *
 * THEY NEED NO PLATE. All three are 8-bit RGBA with a real alpha channel, so the mark sits on the
 * page ground rather than on a box of its own — which is what let the plate go when the composite
 * did. Verified on the way in: 94×94, IEND present, IDAT decoding to a full 35,438 scanline bytes.
 * The composite's failure was a file that passed a byte count and failed on screen, so these were
 * checked by decoding them rather than by weighing them.
 *
 * Root-relative from public/, like every other static image the app draws (wallet/v2/assets.tsx).
 */
const COINS = [
  { src: '/coin-btc.png', name: 'BITCOIN', top: 76 },
  { src: '/coin-xmr.png', name: 'MONERO', top: 236 },
  { src: '/coin-zec.png', name: 'ZCASH', top: 396 },
]

/** The artboard's mark size, 94 of the ring's 104. Both are cqw, so the pair scales together. */
const MARK = '5.875cqw'

/** The artboard's six utility nodes, in its order. */
const UTILITY = ['DeFi', 'NFTs', 'Prediction markets', 'RWAs', 'Swap', 'Stablecoins']

/** The dotted left-hand feeds and the six solid fans on the right. Verbatim from the artboard. */
function Connectors() {
  return (
    <svg
      viewBox={`0 0 ${BAND_W} ${BAND_H}`}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      aria-hidden="true"
      focusable="false"
    >
      {/* NATIVE → CARAVEL. Dotted, because nothing has crossed yet. */}
      {['M250 140 C400 140 460 280 610 293', 'M250 300 C380 300 470 300 610 300', 'M250 460 C400 460 460 320 610 307'].map(d => (
        <path key={d} d={d} stroke={WIRE} strokeWidth="1.6" strokeDasharray="2 7" strokeLinecap="round" fill="none" opacity=".55" />
      ))}
      {/* CARAVEL → UTILITY. Solid: past the bridge the asset is real on the Ootle. */}
      {[
        'M990 289.75 C1080 228.25 1120 119.6 1210 95',
        'M990 293.85 C1080 256.95 1120 191.76 1210 177',
        'M990 297.95 C1080 285.65 1120 263.92 1210 259',
        'M990 302.05 C1080 314.35 1120 336.08 1210 341',
        'M990 306.15 C1080 343.05 1120 408.24 1210 423',
        'M990 310.25 C1080 371.75 1120 480.4 1210 505',
      ].map(d => <path key={d} d={d} stroke={WIRE} strokeWidth="1.6" fill="none" opacity=".4" />)}
      {[95, 177, 259, 341, 423, 505].map(cy => (
        <circle key={cy} cx="1210" cy={cy} r="3" fill={WIRE} opacity=".7" />
      ))}
    </svg>
  )
}

/** The ⇄, at the artboard's own 34×26. The same mark the spine's Bridge row carries. */
function Exchange() {
  return (
    <svg viewBox="0 0 34 26" width="100%" height="100%" fill="none" stroke={WIRE} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2 8 H28 M23 2 L29 8 L23 14" />
      <path d="M32 18 H6 M11 12 L5 18 L11 24" />
    </svg>
  )
}

export default function BridgeTeaser() {
  return (
    <div
      role="img"
      aria-label="Bridge roadmap: native assets bridged through Caravel onto the Ootle, gaining utility"
      style={{ containerType: 'inline-size', width: '100%' }}
    >
      {/* The column headings sit above the band, as they do on the artboard. */}
      <div style={{ position: 'relative', height: type(11, 8.5, 11), marginBottom: '1.2cqw' }}>
        <div style={{ ...LABEL, position: 'absolute', left: pc(96, BAND_W), width: pc(150, BAND_W) }}>NATIVE</div>
        <div style={{ ...LABEL, position: 'absolute', left: pc(620, BAND_W), width: pc(370, BAND_W) }}>BRIDGED THROUGH CARAVEL</div>
        <div style={{ ...LABEL, position: 'absolute', left: pc(1210, BAND_W), width: pc(300, BAND_W) }}>UTILITY</div>
      </div>

      <div style={{ position: 'relative', width: '100%', aspectRatio: `${BAND_W} / ${BAND_H}` }}>
        <Connectors />

        {/* NATIVE — the three assets, still on their own chains. The dashed ring is the artboard
            saying "not here yet"; it is the only dashed shape in the drawing. */}
        {COINS.map(c => (
          <div key={c.name} style={{
            position: 'absolute', left: pc(96, BAND_W), top: pc(c.top, BAND_H), width: pc(150, BAND_W),
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.55cqw',
          }}>
            <span style={{
              width: '6.5cqw', height: '6.5cqw', borderRadius: '50%',
              border: '1.5px dashed var(--border-strong)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <img
                src={c.src}
                alt=""
                aria-hidden="true"
                width={94}
                height={94}
                loading="lazy"
                decoding="async"
                style={{ width: MARK, height: MARK, borderRadius: '50%', display: 'block' }}
              />
            </span>
            <span style={{ ...LABEL, letterSpacing: '0.14em', color: 'var(--text-body-dim)' }}>{c.name}</span>
          </div>
        ))}

        {/* BRIDGED THROUGH CARAVEL — the card the whole drawing points at. */}
        <div style={{
          position: 'absolute', left: pc(620, BAND_W), top: pc(150, BAND_H),
          width: pc(370, BAND_W), height: pc(300, BAND_H),
          boxSizing: 'border-box', borderRadius: '1.5cqw',
          background: 'var(--surface-raised)', border: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.1cqw',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1.625cqw' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6cqw' }}>
              <span style={{
                width: '4.875cqw', height: '4.875cqw', borderRadius: '1.1cqw', background: 'var(--accent-400)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {/* The mark itself, not a tracing of it — see primitives/Logo. */}
                <Logo size={44} style={{ height: '62%', width: 'auto' }} />
              </span>
              <span style={{ fontSize: type(15, 10, 15), fontWeight: 600, color: 'var(--text-primary)' }}>Caravel</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', height: '4.875cqw', width: '2.125cqw', flexShrink: 0 }}>
              <Exchange />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6cqw' }}>
              <span style={{
                width: '4.875cqw', height: '4.875cqw', borderRadius: '1.1cqw',
                border: `1.5px solid ${OOTLE}`, overflow: 'hidden', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <img src="/partner-tari.jpg" alt="" aria-hidden="true" loading="lazy" decoding="async"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </span>
              <span style={{ fontSize: type(15, 10, 15), fontWeight: 600, color: OOTLE }}>Ootle</span>
            </div>
          </div>

          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.5cqw',
            padding: '0.45cqw 0.85cqw', borderRadius: 'var(--r-pill)', background: 'var(--surface-inset)',
          }}>
            <svg width="0.7cqw" height="0.7cqw" viewBox="0 0 24 24" fill="none" stroke={WIRE} strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" focusable="false" style={{ width: '0.7cqw', height: '0.7cqw', flexShrink: 0 }}>
              <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: type(11, 7.5, 11), letterSpacing: '0.1em', color: 'var(--text-body-dim)', whiteSpace: 'nowrap' }}>
              ARRIVES WRAPPED · CONFIDENTIAL
            </span>
          </span>
        </div>

        {/* UTILITY — what the asset can do once it is on a programmable chain. */}
        <div style={{
          position: 'absolute', left: pc(1210, BAND_W), top: pc(63, BAND_H), width: pc(300, BAND_W),
          display: 'flex', flexDirection: 'column', gap: '1.125cqw',
        }}>
          {UTILITY.map(name => (
            <div key={name} style={{
              height: '4cqw', boxSizing: 'border-box', borderRadius: '0.875cqw',
              background: 'var(--surface-raised)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: '0.875cqw', padding: '0 1.25cqw',
            }}>
              <span style={{ width: '0.5cqw', height: '0.5cqw', minWidth: 3, minHeight: 3, borderRadius: '50%', background: WIRE, flexShrink: 0 }} />
              <span style={{ fontSize: type(17, 11, 17), fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
