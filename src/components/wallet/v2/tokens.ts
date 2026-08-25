// Design tokens for the M4 wallet modal, transcribed from the Claude Design canvas
// "Caravel Balance Modal v2.dc.html".
//
// WHY THESE LIVE IN TS RATHER THAN index.css, FOR NOW. Stage 1 is a preview harness: it must be
// possible to look at the new design beside the shipped modal without editing a stylesheet the
// shipped modal also reads. Every value below that already exists in index.css has the SAME value
// there — they were both exported from the same Claude Design token scale — so promoting these to
// CSS variables in Stage 2 is a rename, not a re-pick.
//
// The handful that are genuinely new are marked. They are all surfaces the old modal had no state
// for: a disabled row, a pressed MAX, an amber confirm, and the error console.

export const C = {
  // ── Surfaces ──
  void: '#05080E',
  modal: '#0C111B',
  raised: '#10151F',
  inset: '#161C28',
  trough: '#080C14',
  disabled: '#0E131D',        // NEW — disabled/unavailable card ground
  maxActive: '#1F2536',       // NEW — MAX pill once pressed
  amberGround: '#241C0C',     // NEW — the make-public confirm button
  errorGround: '#170D0D',     // NEW — the verbatim-error console

  // ── Private (teal) ──
  teal: '#2DE0C6',
  teal300: '#7DE9D8',
  tealGradTop: '#34E5D0',
  tealGradBottom: '#12A594',
  inkOnTeal: '#04120F',
  tealLabel: '#8FB7B0',
  tealDim: '#5E8A82',
  heroGrad: 'linear-gradient(165deg, #0E2A28, #0A1A1C)',

  // ── Caution (amber) — the reveal direction ──
  warn: '#FFB43C',
  warn300: '#FFC978',

  // ── Fault (coral) ──
  danger: '#FF8E8E',
  dangerText: '#E2A9A9',

  // ── Text ramp ──
  bright: '#EAFBF7',
  primary: '#F2F5FB',
  body: '#E4EAF4',
  bodyDim: '#C7D0E4',
  muted: '#99A6C2',
  mutedDim: '#8A97B4',
  faint: '#6B7793',
  faintDim: '#55617D',
  ghost: '#3D4657',
} as const

/** Border tints. The design writes these as rgba(120,150,210,α) throughout. */
export const border = (a: number) => `1px solid rgba(120,150,210,${a})`
export const tealBorder = (a: number) => `1px solid rgba(45,224,198,${a})`
export const warnBorder = (a: number) => `1px solid rgba(255,180,60,${a})`
export const tealFill = (a: number) => `rgba(45,224,198,${a})`
export const warnFill = (a: number) => `rgba(255,180,60,${a})`

export const MONO = "'IBM Plex Mono', monospace"

/** The modal shell. 480px is the design's fixed width; it shrinks on narrow viewports. */
export const MODAL_WIDTH = 480
