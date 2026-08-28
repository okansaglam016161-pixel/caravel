// Turning the fund modules' internal error strings into something a person can act on.
//
// WHY THIS EXISTS RATHER THAN EDITING THE MESSAGES AT SOURCE. conceal.ts and reveal.ts speak in
// µtTARI because that is the unit their arithmetic is in, and their messages are quoted verbatim in
// tests, in on-chain reconciliation notes, and in the console when something goes wrong. Rewriting
// them for the UI's benefit would blunt the diagnostics on the one path where diagnostics matter
// most — the irreversible one. So the modules keep saying exactly what they mean, and the
// TRANSLATION HAPPENS AT THE BOUNDARY, here, where the audience changes.
//
// The M4 report's finding was that µtTARI reaches the screen in three places and appears nowhere
// else in the product. This is the fix for all three, plus anything future code adds: the generic
// pass catches any `N µtTARI` a new message introduces.

const MICRO = 1_000_000n

/** µtTARI → a trimmed TARI decimal. Bigint throughout; 100000 → "0.1", 16138 → "0.016138". */
function toTari(micro: bigint): string {
  const whole = micro / MICRO
  const frac = (micro % MICRO).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/**
 * Rewrite a fund-module error for display.
 *
 * Two passes, and the ORDER MATTERS. Several messages already carry their own parenthesised TARI
 * gloss — "100000 µtTARI (0.10 TARI)" — so that shape is collapsed to just the gloss first.
 * Whatever bare `N µtTARI` remains is then converted. Doing it the other way round would produce
 * "0.1 TARI (0.10 TARI)".
 *
 * Anything it does not recognise passes through UNCHANGED. That is deliberate: a network rejection
 * string is the most useful thing we will ever be told about a failed transaction, and a translator
 * that mangled what it did not understand would be worse than none.
 */
export function plainError(message: string): string {
  if (!message) return message

  let out = message

  // 1 — "N µtTARI (X TARI)" → "X TARI". The module already did the conversion; keep only that.
  out = out.replace(/[\d_]+\s*µtTARI\s*\((\d[\d.,]*)\s*TARI\)/gi, '$1 XTR')

  // 2 — a bare "N µtTARI" → the same figure in TARI.
  out = out.replace(/([\d_]+)\s*µtTARI/gi, (_m, digits: string) => {
    const n = digits.replace(/_/g, '')
    try { return `${toTari(BigInt(n))} XTR` } catch { return _m }
  })

  // 3 — plumbing nouns the user has no model for. Narrow and literal on purpose; this is not a
  //     general-purpose rewriter, it is a fix for the specific phrases the fund modules emit.
  out = out
    .replace(/\bacross (\d+) output\(s\)/gi, (_m, n: string) => `across ${n} payment${n === '1' ? '' : 's'}`)
    .replace(/\bspread across too many small outputs\b/gi, 'split across too many small payments')

  return out
}
