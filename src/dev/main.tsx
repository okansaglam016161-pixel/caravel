// Entry point for the standalone M4 preview (dev-wallet.html). Dev-only — never built.
//
// Deliberately does NOT mount WalletProvider or the router: the harness renders the redesign from
// mock props alone, so there is no way for it to reach a wallet, a key, or the network.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import WalletPreview from './WalletPreview'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletPreview />
  </StrictMode>,
)
