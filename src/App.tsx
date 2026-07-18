import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { WalletProvider } from './context/WalletContext'
import LandingPage from './components/landing/LandingPage'
import AppRoute from './components/AppRoute'
import './App.css'

export default function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/app" element={<AppRoute />} />
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  )
}
