// The microscope's lens mount. Everything Node needs before Caravel's own modules will load.
//
//   node scripts/harness.mjs <command> [args]
//
// NOT product code, never shipped, and deliberately not under src/ — see scripts/harness.ts for
// what it does. This file exists only because the shipping modules are written for a bundler and a
// browser, and the point of the harness is to run THOSE modules rather than a Node-shaped copy of
// them. Three things stand between `node` and `src/crypto/*`, and each is solved here rather than
// by touching the code under test:
//
//   1. EXTENSIONLESS TYPESCRIPT IMPORTS. `import { RESOURCE_HEX } from './utxoFeed'` is the
//      project's bundler convention (tsconfig: moduleResolution "bundler",
//      allowImportingTsExtensions). Node's resolver will not add the `.ts` for you, so the resolve
//      hook below does — and nothing else. Node 22.6+ strips the types itself, and the project
//      already forbids the syntax that cannot be stripped (tsconfig: erasableSyntaxOnly), so no
//      transform step is needed or wanted: a transform is a second compiler, and a second compiler
//      is a second thing that can disagree with what Vite ships.
//
//      This is the same problem vitest.live.config.ts solves by going through Vite, and the same
//      answer: resolve the REAL modules, do not reimplement them. Vite is the heavier tool and
//      would also work; a twenty-line resolve hook needs no config, no plugin and no dev server,
//      and `npx tsx` was considered and rejected because it is not installed and adding a
//      dependency to look at a bug is a change to the tree we were asked not to commit.
//
//   2. THE VENDORED CIPHERSEED ALIAS. `tari-cipherseed` is vendored as SOURCE, not in
//      node_modules, and derivation.ts imports it by that bare specifier. All three build configs
//      carry the alias (vite.config.ts, vitest.config.ts, vitest.live.config.ts); this is the
//      fourth, and it must stay in step with them or the harness would derive keys through
//      different code than the app.
//
//   3. THE BROWSER GLOBALS. Only `localStorage` — see the shim below. Everything else the crypto
//      and network paths touch (fetch, crypto.subtle, AbortSignal.timeout, DOMException,
//      WebAssembly ESM imports) is native in Node 26.
//
// The WASM warning Node prints on startup is expected: @tari-project/ootle-wasm is imported as an
// ESM module instance, which Node supports and still calls experimental. It is the same wasm the
// browser loads.

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Kept in step with the `tari-cipherseed` alias in vite.config.ts / vitest*.config.ts. */
const ALIASES = new Map([
  ['tari-cipherseed', path.join(ROOT, 'vendor/tari-cipherseed/src/index.ts')],
])

/** What a bundler tries when a relative import has no extension, in the order it tries them. */
const CANDIDATES = (base) => [
  `${base}.ts`,
  `${base}.tsx`,
  `${base}.js`,
  path.join(base, 'index.ts'),
  path.join(base, 'index.tsx'),
]

function isFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

// registerHooks (not register): synchronous, in-thread, and not deprecated. The hook is resolve
// ONLY — Node's default loader reads and type-strips the .ts file itself.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const aliased = ALIASES.get(specifier)
    if (aliased) return nextResolve(pathToFileURL(aliased).href, context)

    // Bare specifiers (node_modules) and anything already resolvable is left completely alone.
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
      return nextResolve(specifier, context)
    }

    const parent = context.parentURL && context.parentURL.startsWith('file:')
      ? path.dirname(fileURLToPath(context.parentURL))
      : ROOT
    const target = specifier.startsWith('file:')
      ? fileURLToPath(specifier)
      : path.resolve(parent, specifier)

    // Only fill in a MISSING extension. An import that already names a real file resolves normally,
    // so this can never redirect a working import somewhere else.
    if (!isFile(target)) {
      for (const candidate of CANDIDATES(target)) {
        if (isFile(candidate)) return nextResolve(pathToFileURL(candidate).href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})

// ── The one browser global the crypto paths actually need ────────────────────
//
// crypto/accountStore.ts reads and writes `localStorage` — and conceal.ts and reveal.ts both treat
// the account address it stores as a HARD PREREQUISITE, refusing before they build anything if it
// is missing. So without this the write commands could not run at all.
//
// IN-MEMORY AND PER-PROCESS, deliberately. Nothing the harness learns is persisted to disk: a
// harness that wrote a wallet's account address into a file would be a harness that could serve a
// stale one on the next run, and the whole point is to see what the live network says today. The
// address is re-probed from the chain on every run (accountRecovery.probeAccountAddress), which is
// exactly what the app does on unlock.
//
// This is the ONLY stub. It is a real Storage implementation rather than a two-method fake so that
// any other store reached through an unexpected import path behaves rather than throwing.
// ── THE PROBE, NOT THE `in` CHECK ────────────────────────────────────────────
//
// Node 26 ALREADY DEFINES `globalThis.localStorage` — as an accessor that returns `undefined`
// unless the process was started with `--localstorage-file`. So `'localStorage' in globalThis` is
// true, a guard written that way installs nothing, and every call then throws
// `Cannot read properties of undefined (reading 'getItem')` INSIDE accountStore's try/catch, which
// swallows it and returns null.
//
// That is not hypothetical: it is what this file did on its first run. The harness printed a
// freshly recovered account address and prepareConceal then refused with "this wallet's account
// could not be identified" — a storage failure wearing a network failure's message. Exactly the
// class of silent wrong answer the harness exists to catch, caught in the harness itself.
//
// So: probe whether a round trip actually works, replace it with defineProperty when it does not
// (the native property is configurable), and VERIFY. A stub that fails quietly is worse than no
// stub, because it makes every result downstream a plausible lie.
function storageWorks() {
  try {
    const s = globalThis.localStorage
    if (!s) return false
    s.setItem('__caravel_harness_probe', '1')
    const ok = s.getItem('__caravel_harness_probe') === '1'
    s.removeItem('__caravel_harness_probe')
    return ok
  } catch { return false }
}

if (!storageWorks()) {
  // IN-MEMORY BY DEFAULT, and per-process. Nothing the harness learns is persisted unless asked:
  // a harness that wrote a wallet's state to disk could serve a stale account address on the next
  // run, and the point is to see what the live network says today.
  //
  // CARAVEL_HARNESS_STATE OPTS INTO A FILE, because one thing genuinely has to outlive a process:
  // the spend record (crypto/spentOutputs). Proving that a real `send --yes` makes the next `scan`
  // drop the coin takes two commands, and two commands are two processes. The file holds only what
  // the app itself keeps in localStorage — the sealed spend record, the sealed journal, the
  // account address — and every one of those is encrypted under the wallet's store key. THE
  // MNEMONIC IS NEVER IN IT; it is read from the environment and never written anywhere.
  const stateFile = (process.env.CARAVEL_HARNESS_STATE ?? '').trim()
  const map = new Map()

  if (stateFile) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(stateFile, 'utf8')))) map.set(k, String(v))
    } catch { /* absent or unreadable — start empty, exactly as a fresh browser profile would */ }
  }
  const persist = !stateFile ? () => {} : () => {
    try {
      mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(Object.fromEntries(map), null, 2))
    } catch { /* best effort: a harness must not die because a scratch file would not write */ }
  }

  // A real Storage shape rather than a two-method fake, so any other store reached through an
  // unexpected import path behaves instead of throwing.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      get length() { return map.size },
      key: (i) => [...map.keys()][i] ?? null,
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => { map.set(String(k), String(v)); persist() },
      removeItem: (k) => { map.delete(String(k)); persist() },
      clear: () => { map.clear(); persist() },
    },
  })
  if (!storageWorks()) {
    throw new Error('harness: could not install a working localStorage stub — refusing to run, because accountStore would silently read every value as absent.')
  }
}

const harness = await import('./harness.ts')
await harness.main(process.argv.slice(2))
