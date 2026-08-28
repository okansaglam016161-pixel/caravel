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
// the brand gradient is gone ("never teal, never gradients"). The `teal*` KEY NAMES survive this
// pass as deprecated aliases for the same reason the CSS variables do: renaming them is a 207-site
// mechanical commit, and mixing it into a colour change would make both unreviewable.

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
  // `teal*` names kept as deprecated aliases — see the header. Nothing here is teal any more.
  teal: 'var(--accent-400)',
  teal300: 'var(--accent-300)',
  tealGradTop: 'var(--accent-300)',
  tealGradBottom: 'var(--accent-500)',
  inkOnTeal: 'var(--ink-on-accent)',
  tealLabel: 'var(--text-vault-label)',
  tealDim: 'var(--text-accent-dim)',
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
export const tealBorder = (a: number) => `1px solid rgba(var(--accent-400-rgb),${a})`
export const warnBorder = (a: number) => `1px solid rgba(var(--warn-rgb),${a})`
export const tealFill = (a: number) => `rgba(var(--accent-400-rgb),${a})`
export const warnFill = (a: number) => `rgba(var(--warn-rgb),${a})`

export const MONO = 'var(--font-mono)'

/** The modal shell. 480px is the design's fixed width; it shrinks on narrow viewports. */
export const MODAL_WIDTH = 480

/**
 * The widest the wallet PAGE lets its content grow.
 *
 * The design lays the app out in a 1280 shell with a 224 nav beside it, leaving roughly 1050 for
 * the wallet and about 990 inside its padding. Past that the vault hero stops reading as a card and
 * the assets rows put half a screen between a name and its amount, so the content centres rather
 * than stretching further.
 */
export const PAGE_MAX_WIDTH = 1040
