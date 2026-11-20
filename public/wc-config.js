// WalletConnect settings for /vendor/tari/tari-connector.js (Sapient for Android).
// Loaded before the connector. No projectId: the connector then uses its built-in shared project.
// `network` must match the phone wallet's network, or Sapient refuses the session.
window.TARI_WALLETCONNECT = {
  network: 'mainnet',
  metadata: {
    name: 'Caravel',
    description: 'Private messages and private payments, in one conversation.',
    url: window.location.origin,
    icons: [window.location.origin + '/icon-192.png'],
  },
}
