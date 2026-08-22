// Standard CRC-32 (IEEE 802.3 / zlib polynomial 0xEDB88320), matching Rust's `crc32fast` crate
// (its default `Hasher` uses this same polynomial) — used by CipherSeed's checksum (cipherSeed.ts).

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
