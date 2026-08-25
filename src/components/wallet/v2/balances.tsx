// What a balance can be.
//
// ── THIS FILE USED TO HOLD THE TWO BALANCE CARDS ─────────────────────────────
//
// PrivateHero and PublicRow were the M4 layout: private a teal hero, public a quieter row, never
// summed. M7 replaced that with TotalHero — the combined figure as the hero and these two as its
// breakdown — and left the old pair behind a `total ? … : …` fallback while the new hero settled.
//
// The fallback then became unreachable. Every call site, production and preview alike, supplies a
// total, and computeTotal has no undefined result to give, so the branch could not be taken. Two
// full balance layouts existed, one of which nobody could see and no test could reach: exactly the
// code that rots quietly and then reappears in a redesign as "the way it used to work". Removed in
// M9 CP3, along with the fallback.
//
// The TYPE stays, and belongs here. It is what the shipped ScanState / RevealedState split looks
// like to the UI, it is imported by WalletModal, TotalHero, WalletModalV2 and the preview, and its
// zero-versus-unavailable distinction is the whole reason the balance code is careful.

/** What either balance can be. Mirrors the shipped ScanState / RevealedState split exactly. */
export type BalanceView =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; microtari: bigint }
