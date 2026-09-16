// Design tokens for the wallet modal — v0.3 "Foundation".
//
// ── THIS FILE NO LONGER HOLDS VALUES ─────────────────────────────────────────
//
// It used to be a literal table: 31 hex codes transcribed from the design canvas, deliberately
// duplicating src/index.css. The reason was real at the time — Stage 1 was a preview harness that
// had to be viewable beside the shipped modal without editing the stylesheet the shipped modal also
// read. That reason has expired, and what it left behind is two sources of truth for one scale.
//
// So every value below is now a var() onto src/index.css, which is the only place a brand colour is
// written down. The EXPORT SHAPE IS UNCHANGED — `C`, the five border/fill helpers, MONO and
// MODAL_WIDTH all keep their names and types — so the 207 call sites across panels.tsx,
// primitives.tsx, WalletModalV2, TotalHero, move.tsx and the preview harness are untouched.
//
// THE PREVIEW HARNESS STILL WORKS. dev-wallet.html reaches this through src/dev/main.tsx, which
// imports '../index.css' — so the custom properties resolve there exactly as they do in the app.
// That is the fact that made this collapse safe; without it, a var()-based table would render the
// standalone harness colourless.
//
// ── WHAT CHANGED IN THE VALUES ───────────────────────────────────────────────
//
// The accent moved from teal #2DE0C6 to cobalt #378ADD, surfaces from blue-black to ink navy, and
// the brand gradient is gone ("never teal, never gradients"). The `teal*` KEY NAMES survived that
// pass as deprecated aliases, for the same reason the CSS variables did: renaming them in the same
// commit would have buried a colour change under a mechanical rename and made both unreviewable.
// L7 finished the rename and the aliases went the same way the CSS ones did. Nothing in this file
// is named teal any more.

/**
 * The token table.
 *
 * Every entry is a CSS custom property reference, so these strings are only valid inside a style
 * that the browser resolves — which is every use they have (inline `style`, SVG `stroke`/`fill`,
 * template literals inside `background`). None of them can be read as a colour in JS, and nothing
 * ever did.
 */
export const C = {
  // ── Surfaces ──
  void: 'var(--surface-void)',
  modal: 'var(--surface)',
  raised: 'var(--surface-raised)',
  inset: 'var(--surface-inset)',
  trough: 'var(--surface-trough)',
  disabled: 'var(--surface-raised)',      // disabled/unavailable card ground
  maxActive: 'var(--navy-600)',           // MAX pill once pressed
  amberGround: 'rgba(232,180,75,0.10)',   // the make-public confirm button
  errorGround: 'rgba(255,138,115,0.10)',  // the verbatim-error console

  // ── Accent (cobalt) ──
  // These replace the `teal*` aliases retired in L7. Three of those were DROPPED rather than
  // renamed, because all three were already dead: tealGradTop/tealGradBottom named the brand
  // gradient the foundation retired, and tealLabel had no consumer. A renamed dead token is
  // still dead, and keeping one would have carried the gradient's vocabulary past its artwork.
  accent: 'var(--accent-400)',
  accent300: 'var(--accent-300)',
  inkOnAccent: 'var(--ink-on-accent)',
  accentDim: 'var(--text-accent-dim)',
  /** The balance hero's ground. FLAT now — the foundation forbids brand gradients. */
  heroGrad: 'var(--nav-ground)',
  /** The hero's two breakdown cards. Private and public share one ground on purpose: the
   *  foundation distinguishes them by icon and label, never by colour. */
  vaultCard: 'var(--vault-card)',

  // ── Caution (amber) — the reveal direction ──
  warn: 'var(--warn)',
  warn300: 'var(--warn-300)',

  // ── Fault (coral) ──
  danger: 'var(--danger-500)',
  dangerText: 'var(--danger-300)',

  // ── Positive — inflows in the activity list ──
  positive: 'var(--positive)',

  // ── Text ramp ──
  bright: 'var(--text-bright)',
  primary: 'var(--text-primary)',
  body: 'var(--text-body)',
  bodyDim: 'var(--text-body-dim)',
  muted: 'var(--text-muted)',
  mutedDim: 'var(--text-muted-dim)',
  faint: 'var(--text-faint)',
  faintDim: 'var(--text-faint-dim)',
  ghost: 'var(--text-disabled)',
} as const

/**
 * Border and fill tints.
 *
 * These build `rgba(<triplet>, α)` strings, so they need the rgb TRIPLET variables rather than the
 * hex ones — `rgba(var(--accent-400), α)` is not valid CSS. src/index.css publishes
 * `--border-rgb`, `--accent-400-rgb` and `--warn-rgb` for exactly this.
 */
export const border = (a: number) => `1px solid rgba(var(--border-rgb),${a})`
export const accentBorder = (a: number) => `1px solid rgba(var(--accent-400-rgb),${a})`
export const warnBorder = (a: number) => `1px solid rgba(var(--warn-rgb),${a})`
export const accentFill = (a: number) => `rgba(var(--accent-400-rgb),${a})`
export const warnFill = (a: number) => `rgba(var(--warn-rgb),${a})`

export const MONO = 'var(--font-mono)'

/** The modal shell. 480px is the design's fixed width; it shrinks on narrow viewports. */
export const MODAL_WIDTH = 480

/**
 * A SAFETY CEILING, not a measure.
 *
 * The wallet page is FLUID: it fills whatever the spine leaves it, with only its own side padding
 * between the content and the pane. That is the whole layout, and on every ordinary screen this
 * number never comes up — a 1440, a 1512 or a 1728 viewport is fully filled, because the pane is
 * narrower than the cap.
 *
 * What it stops is the absurd end. On a 2560 or a 3840 display an uncapped column draws the balance
 * hero two and a half thousand pixels wide and puts half a metre of desk between an asset's name
 * and its amount. 1600 is set where the fill stops being a fill and starts being a stretch: the
 * first common width it bites at is 1920, and there it leaves ~128 either side rather than boxing
 * the page.
 *
 * IT IS NOT THE DESIGN'S MEASURE, and nothing is proportioned against it. "Caravel Dapp (Wallet)
 * V3" series 01 draws the overview in a 770 column, and this page ran at that measure briefly; the
 * call after seeing it was that a wallet should own its page rather than sit in a card-shaped
 * margin of it. The design's numbers still govern everything INSIDE the column — the hero's 32
 * padding, the 12/24 rhythm — which is what survives the column getting wider.
 */
export const PAGE_MAX_WIDTH = 1600
