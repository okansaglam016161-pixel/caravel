import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { WalletProvider } from './context/WalletContext'
import { ThemeProvider } from './hooks/useTheme'
import LandingPage from './components/landing/LandingPage'
import AppRoute from './components/AppRoute'
import './App.css'

export default function App() {
  // ThemeProvider is outermost so `data-theme` lands on <html> for EVERY route — including the
  // gate screens, which render outside the app shell and would otherwise have no theme at all.
  return (
    <ThemeProvider>
      <WalletProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/app" element={<AppRoute />} />
          </Routes>
        </BrowserRouter>
      </WalletProvider>
    </ThemeProvider>
  )
}
