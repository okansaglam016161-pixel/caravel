import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import path from 'path'

const TARI_REF = path.resolve('/Users/okansaglam/Desktop/caravel/tarijs-reference')
const ONS_CLIENT = path.resolve('/Users/okansaglam/Desktop/ootle-name-service/client')

// Vite 8 handles top-level-await natively — no plugin needed.
// vite-plugin-wasm handles the `import * as wasm from "*.wasm"` in ootle-wasm.
// Aliases point workspace packages to their pre-built dist in tarijs-reference;
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
      '@tari-project/ootle': path.join(TARI_REF, 'packages/ootle/dist/index.js'),
      '@tari-project/ootle-secret-key-wallet': path.join(TARI_REF, 'packages/ootle-secret-key-wallet/dist/index.js'),
      '@tari-project/ootle-indexer': path.join(TARI_REF, 'packages/ootle-indexer/dist/index.js'),
      // ONS client library (local path, same pattern as the tari.js packages above).
      '@ootle/name-service': path.join(ONS_CLIENT, 'dist/index.js'),
    },
  },
})
