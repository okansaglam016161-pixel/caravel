import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

// Kept separate from vite.config.ts on purpose. The app config loads the WASM + React plugins and
// aliases vendored code; the unit tests are pure logic over plain modules and need
// none of that, so pulling that config in would only add failure modes. Vitest prefers this file
// when both are present.
//
// environment: 'node' — no jsdom. The only browser API the store touches is localStorage, which
// the spec stubs in-memory (see messageStore.test.ts). That keeps the test dependency footprint at
// exactly one package and the suite instant.
// The one alias the tests DO need, to VENDORED code that is not in node_modules and so has no
// resolution of its own: tari-cipherseed (vendored as source). Specs importing it resolve through
// the same specifier the app uses. Kept in step with the matching entries in vite.config.ts and
// tsconfig.app.json — all three must agree or the app and its tests would silently exercise
// different code.
const ROOT = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'tari-cipherseed': path.join(ROOT, 'vendor/tari-cipherseed/src/index.ts'),
    },
  },
})
