# hash-wasm (patched: allow empty Argon2 passwords)

A vendored copy of `hash-wasm`'s bundled ESM build (`dist/index.esm.js` at the version pinned in
this package's `package.json`, currently `^4.12.0`), with one change: `argon2d`'s internal
`validateOptions` no longer rejects a zero-length password.

## Why this is vendored instead of imported from npm

Argon2 (RFC 9106) defines an empty password as valid input, and hash-wasm's own unexported
`argon2Internal()` computation never checks the password length — the rejection lived entirely in
the public API's defensive validation (`validateOptions$3`), with no algorithmic justification and
no way to bypass it from outside the package (the unvalidated internal function isn't exported).

Tari's `CipherSeed` format allows an explicitly empty seed passphrase (distinct from omitting a
passphrase entirely, which uses Tari's own default string) — a recovery phrase created upstream
with `passphrase: ""` needs to decrypt here too. Reported upstream isn't an option that helps
today, so this vendors the smallest possible fix instead.

## What changed

Only the password-emptiness checks inside `argon2d`'s `validateOptions$3` (search the file for
`PATCHED (tari-cipherseed)` to find the exact diff). Nothing else — not the WASM binary, not the
Argon2 parameter validation (iterations/parallelism/memory/output-type bounds), not the salt-length
check, not any of hash-wasm's other exported algorithms — was touched.

## Re-applying this patch after a hash-wasm version bump

1. `npm install hash-wasm@<new-version>` (or update the version in `package.json` first).
2. `cp node_modules/hash-wasm/dist/index.esm.js vendor/hash-wasm-patched/index.esm.js`
3. Find `validateOptions` for `argon2d`/`argon2i`/`argon2id` (search for `"Password must be specified"`)
   and re-apply the same two edits shown in the current file's `PATCHED` comment.
4. Run `npm test` — `test/argon2-empty-password.test.ts` fails loudly if the patch didn't take, and
   the golden-vector tests catch any accidental behavior change for non-empty passwords.
