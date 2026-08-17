// Binary ⇄ base64 helpers.
//
// Deliberately a COPY of the private helpers in walletCrypto.ts rather than an import or a
// refactor of them: that file is the mnemonic-encryption path, and churning wallet-critical code to
// share fourteen lines is a poor trade. Converging the two is separate cleanup with its own review.
//
// Only small values pass through here — a 32-byte media key, a 12-byte nonce, and a JSON auth event
// of a few hundred bytes. Image ciphertext moves as raw binary and is never base64'd, so the
// per-byte loop below is never on a hot path.

export function b64Encode(buf: Uint8Array): string {
  // btoa with fromCharCode handles binary safely for 8-bit values.
  let s = ''
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
  return btoa(s)
}

export function b64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

// base64url without padding — the encoding BUD-11 specifies for the Blossom Authorization token
// ("as used by JWTs"). Distinct from b64Encode because `+` and `/` are not safe in a header token.
export function b64urlEncodeString(text: string): string {
  const bytes = new TextEncoder().encode(text)
  return b64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
