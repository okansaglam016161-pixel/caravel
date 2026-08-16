// Single source of truth for Blossom blob-host URLs. No host URL should be hardcoded anywhere else.
// Sibling of config/relays.ts, and the same contract: a shared default now, user-configurable later.
//
// ── WHY THIS LIST IS SHORT (probed 2026-08-16, scripts/blossom-probe.mjs) ─────────
// Caravel uploads AES-GCM CIPHERTEXT — application/octet-stream with no magic bytes, unsniffable as
// any media type. MOST OF THE BLOSSOM ECOSYSTEM REFUSES THAT. Of 22 hosts probed with a real
// encrypted blob and an ephemeral-key BUD-11 auth event, only three accepted it:
//
//   blossom.band            415  "File type not allowed, unsupported"
//   blossom.nostr.build     415  (same nostr.build backend)
//   blossom.primal.net      415  "unsupported media type application/octet-stream"
//   blossom.swissdash.site  401  "Server dose not accept application/octet-stream blobs"
//   nostrcheck.me           400  "file type not detected or not allowed, mime: application/octet-stream"
//   blossom.f7z.io          401  "Pubkey not authorized by any storage rule" (allowlisted/paid)
//   blossom.oxtr.dev        401  (same)
//   nosto.re                403
//   + others unreachable, or no BUD-02 endpoint
//
// So the biggest, best-resourced hosts are exactly the ones that reject us. Every entry below was
// verified end-to-end IN A REAL BROWSER (scripts/blossom-probe.html — a PUT carrying Authorization
// is never a simple request, so it triggers a CORS preflight that curl and Node never exercise):
// encrypt → PUT → GET → sha256 byte-exact → AES-GCM decrypt → plaintext matches.
//
// ORDER IS MEANINGFUL. Upload walks the list and stops at the first success; download falls back
// across it by content hash (Blossom is hash-addressed, so the same blob has the same address
// everywhere — a free durability hedge if one host purges it).
export const DEFAULT_BLOSSOM_HOSTS = [
  // 201, byte-exact round-trip. Preflight lists `authorization` BY NAME — spec-clean.
  'https://nostr.download',
  // 201, byte-exact round-trip. Preflight lists `Authorization` BY NAME — spec-clean.
  'https://cdn.hzrd149.com',
  // 200, byte-exact round-trip, and it DID work in a real browser — but deliberately LAST.
  //
  // Its preflight returns `access-control-allow-headers: *` without naming Authorization, and the
  // Fetch standard says the wildcard does NOT cover Authorization (it must be listed explicitly).
  // It works today only because NO SHIPPING BROWSER ENFORCES THAT RULE YET: per caniuse (2026-07)
  // Chrome ≤154, Edge ≤151 and Safari ≤27 don't implement it and Firefox 115+ keeps it behind a
  // disabled-by-default flag — 0% global usage. That flag is what a staged rollout looks like, so
  // this host is one browser release away from rejecting our uploads.
  //
  // Kept because only three hosts in the ecosystem accept ciphertext at all and redundancy is worth
  // more than tidiness — but placed last so it is only reached if both spec-clean hosts fail, and
  // the failure mode is clean: the preflight fails, fetch throws, the client classifies it as a
  // network error and moves on. If uploads to this host ever start failing for no other reason,
  // this comment is the explanation.
  'https://files.sovbit.host',
] as const

// Requests are aborted past these. Upload gets more room: it is the larger body and the user is
// watching a progress indicator, whereas a slow download just delays one image.
export const BLOSSOM_UPLOAD_TIMEOUT_MS = 30_000
export const BLOSSOM_DOWNLOAD_TIMEOUT_MS = 20_000

// Refuse to buffer more than this from a host. Nothing we upload approaches it (see
// MAX_CIPHERTEXT_BYTES); the cap exists so a wrong or hostile URL cannot make the tab allocate
// unbounded memory before we discover the bytes are useless.
export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024
