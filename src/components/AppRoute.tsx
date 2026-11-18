import { useChat } from '../context/ChatContext'
import AppShell from './shell/AppShell'
import ChatIdentityGate from './chat/identity/ChatIdentityGate'

/**
 * The /app route. Gated on the CHAT identity, not the wallet:
 * - Chat unlocked → the service shell (Chat is the default view)
 * - otherwise     → the chat identity gate (create / import / unlock)
 *
 * Payments go through Sapient (the browser wallet); Caravel holds no wallet of its own.
 */
export default function AppRoute() {
  const { chatUnlocked } = useChat()
  return chatUnlocked ? <AppShell /> : <ChatIdentityGate />
}
