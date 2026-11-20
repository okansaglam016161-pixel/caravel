# Tari connector (pinned, self-hosted)

Caravel serves its own copies of the Tari wallet connector instead of loading them from
universe.tari.mw at runtime: these scripts run with full access to the page, which holds chat keys
and decrypted messages, so the exact bytes are reviewed and pinned here.

| File | Source | Fetched | Size | SHA-256 |
|---|---|---|---|---|
| `tari-connector.js` | https://universe.tari.mw/tari-connector.js | 2026-11-20 | 25870 bytes | `eacd7e5cda6fdbd5f5fbe5fd3d422b10b43bfb037d6747ad0e14576c2d91351e` |
| `tari-connector-wc.js` | https://universe.tari.mw/tari-connector-wc.js?v=6 | 2026-11-20 | 537203 bytes | `531d93179828f7eba246f60069aab53e1af58fa3d7a933a3b394beb9b77ddd9b` |

- `tari-connector.js` provides `window.tari` inside Tari Universe and, with `window.TARI_WALLETCONNECT`
  set (`/wc-config.js`), a WalletConnect provider for Sapient for Android. It never replaces an installed
  Sapient extension's `window.tari`; `window.tariUniverse` is always its own provider.
- `tari-connector-wc.js` is the WalletConnect add-on (version `v=6`). The connector loads it from this same
  folder, and only on the first call that needs the phone.
- No WalletConnect project ID is set: the add-on then uses its built-in shared project ID.
- Docs: https://universe.tari.mw/integration/

To update: download both files again, review the diff, replace them here, and update this table.
