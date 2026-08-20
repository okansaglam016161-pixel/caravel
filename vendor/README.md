# Vendored dependencies

These are **pre-built `dist/` bundles** vendored into the repo so a fresh clone builds with
`npm install && npm run dev` — no external repos, no absolute paths. They are resolved by the
aliases in `vite.config.ts` (runtime) and the `paths` in `tsconfig.app.json` (types).

The ONS client should be replaced with a real npm dependency once we publish it.

## `tari/` — REMOVED (0.39 bump)

The Tari Ootle SDK (`@tari-project/ootle`, `-secret-key-wallet`, `-indexer`) used to be vendored
here. It no longer is: they are ordinary npm dependencies in `package.json`.

The vendoring existed for one reason — the only published versions were `0.1.0`, built against
`@tari-project/ootle-wasm ^0.32.0`, while Esmeralda's wire format needed `0.35.2`. That pairing was
ABI-mismatched and its transactions were rejected by the indexer, so the dists were built from
tari.js `2bc5e93` against the right wasm and checked in.

tari.js has since published `0.3.0` on `ootle-wasm ^0.39.0`, which is exactly the pairing Ootle
0.39 requires. The reason to vendor is gone, so the dists are gone with it — one fewer thing to
keep in sync by hand, and `npm install` now gets the same code the rest of the ecosystem runs.

## `ons/` — Ootle Name Service client (unpublished)

`@ootle/name-service` — our own client (source repo not yet published). Caravel imports only
`createOnsClient` from it. Vendored until the client is published to npm, then switch to the package.
