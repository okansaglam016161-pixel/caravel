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
// The Tari SDK is now a NORMAL NPM DEPENDENCY (0.39 bump). It used to be vendored under
// vendor/tari/ because the only published versions were 0.1.0, built against ootle-wasm ^0.32.0 —
// ABI-mismatched against the wasm Esmeralda actually needed, so their transactions were rejected.
// tari.js published 0.3.0 on ootle-wasm ^0.39.0, which is exactly the pairing this app needs, so
// the vendored dists are gone and there is nothing left to keep in sync by hand.
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
