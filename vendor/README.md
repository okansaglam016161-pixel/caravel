# Vendored dependencies

These are **pre-built `dist/` bundles** vendored into the repo so a fresh clone builds with
`npm install && npm run dev` — no external repos, no absolute paths. They are resolved by the
aliases in `vite.config.ts` (runtime) and the `paths` in `tsconfig.app.json` (types).

Both should be replaced with real npm dependencies once upstream/we publish current versions.

## `tari/` — Tari Ootle JS SDK (official, BSD-3)

`@tari-project/ootle`, `@tari-project/ootle-secret-key-wallet`, `@tari-project/ootle-indexer`.

- Source: the official SDK, <https://github.com/tari-project/tari.js> (commit `2bc5e93`).
- **Why vendored instead of npm:** the published versions (`0.1.0`) target `@tari-project/ootle-wasm ^0.32.0`,
  but Caravel needs the current Esmeralda wire format, which requires `ootle-wasm 0.35.2`. The `0.32`-era
  npm build is ABI-mismatched against `0.35.2` and its transactions are rejected by the indexer. These
  dists are built against `0.35.2` (Esmeralda-current). When Tari publishes an Esmeralda-current version,
  drop `tari/` and `npm install` the packages instead.
- License: `tari/LICENSE` (BSD 3-Clause, © The Tari Developer Community). Retained per the license.
- `@tari-project/ootle-wasm@0.35.2` is a normal npm dependency (in `package.json`) — not vendored here.

## `ons/` — Ootle Name Service client (unpublished)

`@ootle/name-service` — our own client (source repo not yet published). Caravel imports only
`createOnsClient` from it. Vendored until the client is published to npm, then switch to the package.
