import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import wasmPlugin from 'vite-plugin-wasm'
import path from 'path'
import { fileURLToPath } from 'url'

// vite-plugin-wasm ships dual CJS/ESM types (`export =` on the CJS side), so under
// module:nodenext + verbatimModuleSyntax TS binds the default import to the module namespace
// (no call signature) — even though at runtime the default IS the plugin factory (proven: the
// bundle builds). Normalise the type to a callable factory so `tsc -b` / `npm run build` pass.
const wasm = wasmPlugin as unknown as () => PluginOption

// Repo-anchored (not cwd-dependent) path to the vendored dists — see vendor/README.md.
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const V = (p: string) => path.join(ROOT, 'vendor', p)

// Vite 8 handles top-level-await natively — no plugin needed.
// vite-plugin-wasm handles the `import * as wasm from "*.wasm"` in ootle-wasm.
//
// The Tari SDK is a NORMAL NPM DEPENDENCY (since the 0.39 bump). It used to be vendored under
// vendor/tari/ because the only published versions were 0.1.0, built against ootle-wasm ^0.32.0 —
// ABI-mismatched against the wasm Esmeralda actually needed, so their transactions were rejected.
// Publishing caught up, the vendored dists went, and there is nothing left to sync by hand.
//
// THE PAIRING IS THE THING TO CHECK ON EVERY BUMP, and it is checkable in one command: the four
// @tari-project packages must resolve to ONE copy of ootle-wasm. The SDK names the wasm it was
// built against, and -indexer and -secret-key-wallet pin `ootle` to an EXACT version, so moving
// any of the four alone makes npm nest a second, differently-built wasm rather than fail — two
// instances, one signing what the other did not build. That is what the 0.1.0 dists did.
//
//   npm ls @tari-project/ootle-wasm        → exactly one entry, no "deduped" second tree
//   find node_modules -path "*ootle-wasm/package.json"   → exactly one line
//
// Current pairing (Ootle 0.41 / protocol v1): SDK 0.5.0 on ootle-wasm ^0.41.0.
//
// The ONS client stays vendored — see vendor/README.md; it is our own unpublished package.
//
// tari-cipherseed is vendored too, but as SOURCE rather than a built dist: it derives the keys
// that control funds, so the reviewed bytes belong in-tree where every future diff re-exposes
// them. See vendor/tari-cipherseed/README.md for the pinned version and re-vendor procedure.
export default defineConfig({
  plugins: [wasm(), react()],
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    // Don't pre-bundle these — they contain WASM and TLA that esbuild
    // can't handle in the deps pre-bundling step.
    exclude: ['@tari-project/ootle-wasm', '@tari-project/ootle', '@tari-project/ootle-secret-key-wallet', '@tari-project/ootle-indexer', '@ootle/name-service'],
  },
  resolve: {
    alias: {
      '@ootle/name-service': V('ons/dist/index.js'),
      'tari-cipherseed': V('tari-cipherseed/src/index.ts'),
    },
  },
})
