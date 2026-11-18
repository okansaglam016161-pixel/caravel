import { BrowserRouter, Routes, Route } from 'react-router-dom'
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
      {/* Sapient (the browser wallet) stands on its own; chat reads it for payments, and works
          with no wallet at all. */}
      <SapientProvider>
      <ChatProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/app" element={<AppRoute />} />
          </Routes>
        </BrowserRouter>
      </ChatProvider>
      </SapientProvider>
    </ThemeProvider>
  )
}
