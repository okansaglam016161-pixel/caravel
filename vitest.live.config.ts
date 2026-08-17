import { defineConfig } from 'vitest/config'

// LIVE tests only — the ones that hit the real network. Kept in a SEPARATE config from
// vitest.config.ts (which includes `src/**/*.test.ts`) precisely so that `npm test` can never fail
// because the wifi dropped or a third-party host had a bad afternoon. A unit suite that is
// unreliable for reasons unrelated to the code stops being trusted, and then stops being run.
//
//   npm run test:live
//
// These are written as vitest specs rather than plain node scripts for one practical reason: the
// modules under test are TypeScript with extensionless imports (the project's bundler convention),
// which Node's own resolver cannot follow. Going through Vite means the live checks exercise the
// REAL shipped modules rather than a reimplementation of them.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.live.ts'],
    // Real uploads over a real network, sequentially against third-party hosts — be patient, and be
    // polite by not running them in parallel.
    testTimeout: 120_000,
    fileParallelism: false,
  },
})
