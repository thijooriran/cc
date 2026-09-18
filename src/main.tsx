import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles.css'

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
