import { BrowserRouter, Routes, Route } from 'react-router-dom'
import LandingPage from './components/landing/LandingPage'
import ChatApp from './components/chat/ChatApp'
import SdkTest from './components/SdkTest'
import './App.css'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/app" element={<ChatApp />} />
      </Routes>
      <SdkTest />
    </BrowserRouter>
  )
}
