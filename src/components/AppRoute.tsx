import { useWallet } from '../context/WalletContext'
import AppShell from './shell/AppShell'
import CreateWallet from './wallet/CreateWallet'
import UnlockWallet from './wallet/UnlockWallet'

/**
 * The /app route. Acts as a wallet gate:
 * - No wallet in localStorage → show create flow
 * - Wallet exists but not yet unlocked in memory → show unlock screen
 * - Wallet unlocked in memory → show the service shell (Wallet is the default view)
 */
export default function AppRoute() {
  const { wallet, walletExists } = useWallet()

  if (wallet) return <AppShell />
  if (walletExists) return <UnlockWallet />
  return <CreateWallet />
}
