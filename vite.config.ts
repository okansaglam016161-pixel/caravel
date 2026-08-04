import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'
import { fileURLToPath } from 'url'

// Repo-anchored (not cwd-dependent) path to the vendored dists — see vendor/README.md.
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const V = (p: string) => path.join(ROOT, 'vendor', p)

// Vite 8 handles top-level-await natively — no plugin needed.
// vite-plugin-wasm handles the `import * as wasm from "*.wasm"` in ootle-wasm.
// Aliases point the Tari SDK + ONS client at their pre-built dists vendored in-repo (vendor/);
// ootle-wasm is installed directly from npm at the correct version (0.35.2).
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
      '@tari-project/ootle': V('tari/ootle/dist/index.js'),
      '@tari-project/ootle-secret-key-wallet': V('tari/ootle-secret-key-wallet/dist/index.js'),
      '@tari-project/ootle-indexer': V('tari/ootle-indexer/dist/index.js'),
      '@ootle/name-service': V('ons/dist/index.js'),
    },
  },
})
