import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts on purpose. The app config loads the WASM + React plugins and
// aliases the vendored Tari/ONS dists; the unit tests are pure logic over plain modules and need
// none of that, so pulling that config in would only add failure modes. Vitest prefers this file
// when both are present.
//
// environment: 'node' — no jsdom. The only browser API the store touches is localStorage, which
// the spec stubs in-memory (see messageStore.test.ts). That keeps the test dependency footprint at
// exactly one package and the suite instant.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
