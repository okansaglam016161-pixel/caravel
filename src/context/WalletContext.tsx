import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { type SecretKeyWallet } from '@tari-project/ootle-secret-key-wallet'
import {
  createMnemonic,
  walletFromMnemonic,
  encryptMnemonic,
  decryptMnemonic,
  hasStoredWallet,
  loadStoredWallet,
  saveStoredWallet,
} from '../crypto/walletCrypto'

// ── Types ────────────────────────────────────────────────────────────────────

export interface WalletCtx {
  walletExists: boolean
  wallet: SecretKeyWallet | null
  address: string | null
  /** Generate a fresh BIP-39 mnemonic (sync, call before showing step 2). */
  generateMnemonic: () => string
  /** Encrypt mnemonic with password, save to localStorage, unlock in memory. */
  createWallet: (mnemonic: string, password: string) => Promise<void>
  /** Decrypt stored wallet with password, load into memory. */
  unlock: (password: string) => Promise<void>
  /** Overwrite stored wallet from an existing phrase + new password, then unlock. */
  restore: (mnemonic: string, password: string) => Promise<void>
  /** Clear wallet from memory (wallet remains in localStorage; returns to unlock screen). */
  lock: () => void
  /** Decrypt and return the stored mnemonic — requires the user's password. */
  getMnemonic: (password: string) => Promise<string>
}

// ── Context ──────────────────────────────────────────────────────────────────

const Ctx = createContext<WalletCtx | null>(null)

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider')
  return ctx
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<SecretKeyWallet | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [walletExists, setWalletExists] = useState(() => hasStoredWallet())

  // Materialize a wallet object + resolve its address into state
  const materialize = useCallback(async (w: SecretKeyWallet) => {
    const addr = await w.getAddress()
    setWallet(w)
    setAddress(addr)
  }, [])

  const generateMnemonic = useCallback(() => createMnemonic(), [])

  const createWallet = useCallback(async (mnemonic: string, password: string) => {
    const stored = await encryptMnemonic(mnemonic, password)
    saveStoredWallet(stored)
    setWalletExists(true)
    const w = await walletFromMnemonic(mnemonic)
    await materialize(w)
  }, [materialize])

  const unlock = useCallback(async (password: string) => {
    const stored = loadStoredWallet()
    if (!stored) throw new Error('No wallet stored')
    // decryptMnemonic throws DOMException (OperationError) on wrong password
    const mnemonic = await decryptMnemonic(stored, password)
    const w = await walletFromMnemonic(mnemonic)
    await materialize(w)
  }, [materialize])

  const restore = useCallback(async (mnemonic: string, password: string) => {
    const stored = await encryptMnemonic(mnemonic, password)
    saveStoredWallet(stored)
    setWalletExists(true)
    const w = await walletFromMnemonic(mnemonic)
    await materialize(w)
  }, [materialize])

  const lock = useCallback(() => {
    setWallet(null)
    setAddress(null)
  }, [])

  const getMnemonic = useCallback(async (password: string) => {
    const stored = loadStoredWallet()
    if (!stored) throw new Error('No wallet stored')
    return decryptMnemonic(stored, password)
  }, [])

  return (
    <Ctx.Provider value={{ walletExists, wallet, address, generateMnemonic, createWallet, unlock, restore, lock, getMnemonic }}>
      {children}
    </Ctx.Provider>
  )
}
