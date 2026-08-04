import { Network } from '@tari-project/ootle';
import { Signer } from '@tari-project/ootle';
import { TransactionSignature } from '@tari-project/ootle-ts-bindings';
import { UnsignedTransactionV1 } from '@tari-project/ootle-ts-bindings';

/**
 * The injected-crypto argument of {@link Signer.addStealthSignature}, derived from the
 * interface so this package never imports the internal `stealth/` module directly.
 */
declare type AddStealthSignatureCtx = Parameters<NonNullable<Signer["addStealthSignature"]>>[3];

/**
 * A one-shot signer that generates a fresh throwaway keypair, signs once,
 * and exposes no way to reuse the key. Used for privacy-preserving transactions
 * where the sender wants no link between the transaction and their identity.
 *
 * **No stealth spending support by design.** This signer holds no view key, so it
 * deliberately does **not** implement the optional `Signer.getViewSecret`/
 * `Signer.addStealthSignature` members. Stealth scanning and one-time spend-key signing
 * require a view secret + owner secret pair — use {@link SecretKeyWallet} for that.
 *
 * @example
 * ```ts
 * const signer = EphemeralKeySigner.generate();
 * const signed = await signTransaction([signer], unsignedTx);
 * ```
 */
export declare class EphemeralKeySigner implements Signer {
    private readonly secretKey;
    private readonly publicKey;
    readonly address: string;
    private constructor();
    /**
     * Generates a fresh ephemeral keypair. The secret key exists only for the
     * lifetime of this object and is never persisted.
     *
     * The WASM `generateKeypair` already returns 32-byte halves; the explicit
     * assertion is defence-in-depth so an upstream WASM regression surfaces here
     * rather than silently mis-signing further down the line.
     */
    static generate(network?: Network): EphemeralKeySigner;
    getAddress(): Promise<string>;
    getPublicKey(): Promise<Uint8Array>;
    signTransaction(unsignedTx: UnsignedTransactionV1, sealPublicKey: Uint8Array): Promise<TransactionSignature[]>;
}

/**
 * A local signer that holds a secret key (and optional view-only key) in memory,
 * using the WASM module for transaction hashing and Schnorr signing.
 *
 * For production use, prefer `WalletDaemonSigner` so the secret key never lives
 * in JavaScript memory.
 *
 * Prefer {@link SecretKeyWallet.getViewSecret} for view-secret access;
 * {@link SecretKeyWallet.getViewOnlySecret} is retained for back-compat.
 */
export declare class SecretKeyWallet implements Signer {
    private readonly ownerSecretKey;
    private readonly ownerPublicKey;
    private readonly viewOnlySecret;
    private readonly viewOnlyPublicKey;
    readonly network: Network;
    private constructor();
    /**
     * Generates a fresh random account keypair and a separate random view-only key.
     * The view-only key is used for stealth/confidential output scanning.
     * Mirrors `OotleSecretKey { account_secret, view_only_secret }` from ootle-rs.
     */
    static randomWithViewKey(network: Network): SecretKeyWallet;
    /**
     * Creates a wallet from an existing hex-encoded account secret key.
     * The public key is derived via `wasm.derivePublicKey`.
     *
     * @throws {InvalidArgumentError} if `ownerSecretKey` (or `viewOnlySecret`, when
     *   supplied) is not exactly 32 bytes.
     */
    static fromSecretKey(ownerSecretKey: Uint8Array, network: Network, viewOnlySecret?: Uint8Array): SecretKeyWallet;
    /**
     * Creates a wallet directly from a secret key and its corresponding public key.
     * Use this overload if you already have both keys (e.g. from key storage).
     *
     * @throws {InvalidArgumentError} if `ownerSecretKey`, `ownerPublicKey`, or
     *   `viewOnlySecret` (when supplied) is not exactly 32 bytes.
     */
    static fromKeypair(ownerSecretKey: Uint8Array, ownerPublicKey: Uint8Array, network: Network, viewOnlySecret?: Uint8Array): SecretKeyWallet;
    /**
     * @throws {WalletError} when the view-only key has not been set on this wallet.
     */
    getAddress(): Promise<string>;
    getPublicKey(): Promise<Uint8Array>;
    /**
     * Returns the view-only secret key, if one was set.
     * Used for stealth/confidential output scanning.
     *
     * @deprecated Use {@link getViewSecret} instead. This method signals a missing
     *   view key via a `null` return; `getViewSecret` throws a `WalletError` with
     *   an actionable message.
     */
    getViewOnlySecret(): Uint8Array | null;
    /**
     * Returns the view-only secret for stealth scanning/spending ({@link Signer.getViewSecret}).
     *
     * Intentionally duplicates {@link getViewOnlySecret} (the pre-existing synchronous public
     * accessor): this async method conforms to the `Signer` interface, while the original is
     * kept unchanged to avoid a breaking API change.
     *
     * @throws {WalletError} when no view-only secret is set on this wallet (e.g. a wallet
     *   built via {@link fromSecretKey}/{@link fromKeypair} without a view secret).
     */
    getViewSecret(): Promise<Uint8Array>;
    /**
     * Produces a one-time spend-key signature for a stealth input ({@link Signer.addStealthSignature}).
     *
     * Derives the one-time spend scalar (`c + k`) for the owned stealth UTXO via
     * `stealthDhSecret(network, ownerSecret, publicNonce)`, then signs via the WASM
     * `addTransactionSigner` (same path as {@link signTransaction}).
     *
     * The returned {@link TransactionSignature} carries the one-time spend public key (not the
     * wallet's owner public key) — it authorizes the specific stealth UTXO being spent.
     */
    addStealthSignature(unsignedJson: string, publicNonce: Uint8Array, sealPublicKey: Uint8Array, ctx: AddStealthSignatureCtx): Promise<TransactionSignature>;
    signTransaction(unsignedTx: UnsignedTransactionV1, sealPublicKey: Uint8Array): Promise<TransactionSignature[]>;
}

export { }
