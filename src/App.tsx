import { useEffect, useState } from 'react'
import { ONLINE } from './lib/config'
import { bootIdentity, type Identity } from './lib/auth'
import { seedMockData } from './lib/mock'
import { syncAll, syncTokens } from './lib/sync'
import { cleanupTransferCards } from './lib/store'
import { flushOutbox, registerBackgroundSync } from './lib/outbox'
import { startPresenceHeartbeat, startRealtime } from './lib/realtime'
import { Header, type View } from './components/Header'
import { BootModal, FieldGuideModal, ReloadPrompt } from './components/Modals'
import { ChatView } from './components/Chat'
import { BoardView } from './components/Board'
import { VaultView } from './components/Vault'

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [bootError, setBootError] = useState('')
  const [view, setView] = useState<View>('channels')
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const [installEvt, setInstallEvt] = useState<{ prompt: () => Promise<void> } | null>(null)
  const [updateReady, setUpdateReady] = useState<(() => void) | null>(null)

  // Boot: identity → seed/sync → realtime → outbox.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const id = await bootIdentity()
        if (!alive) return
        setIdentity(id)
        if (!ONLINE) await seedMockData(id)
        await syncTokens()
        await syncAll(id)
        await startRealtime(id)
        startPresenceHeartbeat(id)
        await flushOutbox()
        await cleanupTransferCards()
        await registerBackgroundSync()
      } catch (e) {
        if (alive) setBootError(e instanceof Error ? e.message : 'boot failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Custom install prompt.
  useEffect(() => {
    const onBiP = (e: Event) => {
      e.preventDefault()
      setInstallEvt(e as unknown as { prompt: () => Promise<void> })
    }
    window.addEventListener('beforeinstallprompt', onBiP)
    return () => window.removeEventListener('beforeinstallprompt', onBiP)
  }, [])

  // Service worker waiting → prompt to reload.
  useEffect(() => {
    const onSw = (e: Event) => setUpdateReady(() => (e as CustomEvent<() => Promise<void>>).detail)
    window.addEventListener('crimechat:sw-update', onSw)
    return () => window.removeEventListener('crimechat:sw-update', onSw)
  }, [])

  if (bootError) {
    return (
      <div className="boot-error">
        <h2>The network refused you</h2>
        <p className="mono">{bootError}</p>
        <p className="muted">
          The relay may be unreachable, or your cover has been burned. Check your connection and reload.
        </p>
      </div>
    )
  }

  if (!identity) {
    return (
      <div className="boot-screen">
        <div className="boot-glyph">◈</div>
        <p>establishing cover identity…</p>
      </div>
    )
  }

  const onSwitchIdentity = (id: Identity) => {
    setIdentity(id)
    setActiveThreadId(null)
    void (async () => {
      if (!ONLINE) await seedMockData(id)
      await syncAll(id)
      await startRealtime(id)
    })()
  }

  return (
    <div className="app">
      <Header
        identity={identity}
        view={view}
        setView={(v) => {
          setView(v)
          if (v !== 'channels') setActiveThreadId((cur) => cur)
        }}
        onShowGuide={() => setShowGuide(true)}
        onInstall={
          installEvt
            ? () => {
                void installEvt.prompt()
                setInstallEvt(null)
              }
            : null
        }
        onSwitchIdentity={onSwitchIdentity}
      />
      <main className="app-main">
        {view === 'channels' && (
          <ChatView identity={identity} activeThreadId={activeThreadId} setActiveThreadId={setActiveThreadId} />
        )}
        {view === 'board' && <BoardView identity={identity} onOpenChannel={(id) => { setActiveThreadId(id); setView('channels') }} />}
        {view === 'vault' && <VaultView identity={identity} />}
      </main>
      <BootModal onEnter={() => undefined} />
      {showGuide && <FieldGuideModal onClose={() => setShowGuide(false)} />}
      {updateReady && <ReloadPrompt onReload={() => updateReady()} />}
    </div>
  )
}
