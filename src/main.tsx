import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { ONLINE } from './lib/config'
import './styles.css'

// Startup banner: version + build time are baked in at build time, so a
// deployed client can be matched against the repo at a glance.
console.info(
  `[crimechat] v${__APP_VERSION__} · built ${__BUILD_TIME__} · ${ONLINE ? 'LIVE network' : 'LOCAL-ONLY'}`,
)
;(window as unknown as Record<string, unknown>).__crimechat = {
  version: __APP_VERSION__,
  buildTime: __BUILD_TIME__,
}

// registerType: 'prompt' — we surface our own reload affordance when the new
// service worker is waiting.
const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(
      new CustomEvent('crimechat:sw-update', { detail: () => updateSW(true) }),
    )
  },
  onOfflineReady() {
    console.info('[crimechat] app shell cached — cold offline launch works')
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
