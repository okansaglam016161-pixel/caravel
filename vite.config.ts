import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import wasmPlugin from 'vite-plugin-wasm'

// vite-plugin-wasm ships dual CJS/ESM types (`export =` on the CJS side), so under
// module:nodenext + verbatimModuleSyntax TS binds the default import to the module namespace
// (no call signature) — even though at runtime the default IS the plugin factory (proven: the
// bundle builds). Normalise the type to a callable factory so `tsc -b` / `npm run build` pass.
const wasm = wasmPlugin as unknown as () => PluginOption

// Vite 8 handles top-level-await natively — no plugin needed.
// vite-plugin-wasm handles the `import * as wasm from "*.wasm"` in @tari-project/ootle-wasm, which
// Caravel uses only to parse an `otl_…` address and check its network before paying it. It is
// imported dynamically (sapient/addressParser), so it is its own chunk, fetched when the pay panel
// first opens — never on the landing page or at app start.
export default defineConfig({
  plugins: [wasm(), react()],
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    // Don't pre-bundle these — they contain WASM and TLA that esbuild
    // can't handle in the deps pre-bundling step.
    exclude: ['@tari-project/ootle-wasm'],
  },
})
