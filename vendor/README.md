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

tari.js publishes in step with the node now, so the reason to vendor is gone and `npm install` gets
the same code the rest of the ecosystem runs.

### The pairing, and how to check it

| Ootle | SDK (`ootle`, `-indexer`, `-secret-key-wallet`) | `ootle-wasm` |
|---|---|---|
| 0.39 | 0.3.0 | ^0.39.0 |
| 0.41 (protocol v1) | **0.5.0** | **^0.41.0** |

The four move TOGETHER, and npm will not stop you moving one. `-indexer` and `-secret-key-wallet`
pin `ootle` to an exact version and the SDK carries a caret on the wasm it was built against, so
bumping the wasm alone resolves to two differently-built copies — one signing what the other did
not build. That is the 0.1.0 failure, and it looks like a successful install.

So the check after any bump is a count, not a version read:

```
find node_modules -path "*ootle-wasm/package.json"   # exactly one line
npm ls @tari-project/ootle-wasm                      # one entry
```

A second line means stop and fix the pairing before running anything against the chain.

## `tari-cipherseed/` — Tari CipherSeed format + account-key derivation (SOURCE, not a dist)

The one entry here that is **not** a pre-built dist. `tari-cipherseed` derives the keys that
control funds, so it is vendored as readable source with the reviewed bytes in-tree, pinned to
version 0.2.0 at commit `a3f3b40`. It is an unofficial, single-maintainer package, adopted only
after a live byte-for-byte round-trip against the official `tari_ootle_walletd`.

See `tari-cipherseed/README.md` for full provenance, what was verified, and the re-vendor
procedure. Resolved by the `tari-cipherseed` alias in `vite.config.ts`, `tsconfig.app.json` **and**
`vitest.config.ts` — all three must agree.

## `ons/` — Ootle Name Service client (unpublished)

`@ootle/name-service` — our own client (source repo not yet published). Caravel imports only
`createOnsClient` from it. Vendored until the client is published to npm, then switch to the package.
