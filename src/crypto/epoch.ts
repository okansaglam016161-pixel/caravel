// Transaction validity window (Ootle 0.39).
//
// 0.39 made `max_epoch` MANDATORY on every transaction: the builder takes it at construction and
// throws `maxEpoch must be a non-negative integer epoch` without it, so this is not an optional
// hardening step — it is the reason every write path broke on the upgrade. The value is the last
// epoch in which the network may still sequence the transaction; past it, the transaction is dead
// rather than pending.
//
// This lives in its own module because BOTH write paths need the identical answer and they are
// otherwise unrelated files — the same reasoning replyCompose.ts and messageEdit.ts are split out
// for. A lead duplicated in two places is a lead that drifts.

import { resolveMaxEpoch, type Provider } from '@tari-project/ootle'

// How many epochs of validity a transaction we build now should carry.
//
// MEASURED FIRST, because the intuition here is wrong. Esmeralda ran ~30 s/block when sampled
// (3 blocks in 90 s, 2026-08-20) and ~80 blocks/epoch over its lifetime (height 842 387 / epoch
// 10 529), which puts ONE epoch at roughly 40 minutes. Both figures are rough — a 90-second sample
// and a lifetime average — but they are the right order of magnitude, and that is enough to settle
// the choice.
//
// The consequence is that the lead is NOT the lever for the thing it looks like it should fix.
// Caravel's confirmation poll gives up after ~32 s and reports a timeout, and the transaction can
// still commit afterwards — but the smallest legal lead (1) already leaves a ~40 minute window, so
// no value here brings "timed out" anywhere near "did not happen". That gap is a UI problem (the
// poll's wording, and rescanning later), not something max_epoch can close. Worth noting the
// direction of travel though: before 0.39 the field was `null` — NO expiry at all — so a stale
// signed transaction could be sequenced indefinitely. Any bound is an improvement on that.
//
// So the lead is chosen purely for RELIABILITY margin, where the trade is one-sided:
//
//   Too SHORT and a transaction that was valid when signed expires before the network sequences it.
//   A lead of 1 is the dangerous case — submit just before an epoch rolls and the effective window
//   is not 40 minutes but whatever is left of it, possibly seconds, plus indexer lag on top.
//
//   Too LONG only matters near MAX_TRANSACTION_VALIDITY_EPOCHS (2160, ~60 days), where the network
//   rejects the transaction outright with `AbortReason::ValidityWindowTooLong`.
//
// 10 epochs (~6.7 h) sits comfortably between: several epochs of boundary margin, and 0.46% of the
// cap. It is also the SDK's own default for `resolveMaxEpoch`, i.e. the ecosystem's answer to this
// exact question. It is passed EXPLICITLY at the call sites rather than left to default, so the
// value is visible in Caravel instead of being a property of whichever SDK version is installed.
export const MAX_EPOCH_LEAD = 10

// `currentEpoch + MAX_EPOCH_LEAD`, read live from the indexer.
//
// CALL THIS AS LATE AS POSSIBLE — immediately before constructing the builder, AFTER the balance
// proofs and output statements are generated. Those are the slow part (wasm range proofs), and a
// tip read placed before them spends part of the window on work that happens on this device.
export async function nextMaxEpoch(provider: Provider): Promise<number> {
  return resolveMaxEpoch(provider, MAX_EPOCH_LEAD)
}
