import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { WalletProvider } from './context/WalletContext'
import { ChatProvider } from './context/ChatContext'
import { SapientProvider } from './context/SapientContext'
import { ThemeProvider } from './hooks/useTheme'
import LandingPage from './components/landing/LandingPage'
import AppRoute from './components/AppRoute'
import './App.css'

export default function App() {
  // ThemeProvider is outermost so `data-theme` lands on <html> for EVERY route — including the
  // gate screens, which render outside the app shell and would otherwise have no theme at all.
  return (
    <ThemeProvider>
      {/* Chat outside the wallet: the wallet reads chat's messages (payment attribution), never the
          other way round, and Chat must work with no wallet at all. */}
      {/* Sapient (the browser wallet) stands on its own: detection and the connection do not depend on
          chat or the built-in wallet, and the payments step reads it from here. */}
      <SapientProvider>
      <ChatProvider>
      <WalletProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/app" element={<AppRoute />} />
          </Routes>
        </BrowserRouter>
      </WalletProvider>
      </ChatProvider>
      </SapientProvider>
    </ThemeProvider>
  )
}
