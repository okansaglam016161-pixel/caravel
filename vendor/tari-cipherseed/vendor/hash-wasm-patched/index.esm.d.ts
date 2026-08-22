// Minimal ambient declaration for the one export this package actually uses from the vendored,
// patched hash-wasm bundle. See index.esm.js's header comment and README.md's "Vendored
// dependency" section for why this is vendored rather than imported from npm.
export type HashWasmDataType = string | Uint8Array;

export interface Argon2Options {
  password: HashWasmDataType;
  salt: HashWasmDataType;
  secret?: HashWasmDataType;
  iterations: number;
  parallelism: number;
  memorySize: number;
  hashLength: number;
  outputType?: "hex" | "binary" | "encoded";
}

type Argon2ReturnType<T> = T extends { outputType: "binary" } ? Uint8Array : string;

export declare function argon2d<T extends Argon2Options>(options: T): Promise<Argon2ReturnType<T>>;
