import { useEffect, useState } from 'react'
import { Identicon, AddressChip, ReputationBar } from './bits'
import type { Identity } from '../lib/auth'
import { useLive } from '../lib/store'
import { db } from '../lib/db'
import { getNetState, onNetState, type NetState } from '../lib/net'
import { switchIdentity } from '../lib/auth'
import { getNotifyState, requestNotifyPermission, type NotifyState } from '../lib/notify'

export type View = 'channels' | 'board' | 'vault'

function NotifyBell() {
  const [state, setState] = useState<NotifyState>(() => getNotifyState())
  if (state === 'unsupported') return null
  const enabled = state === 'granted'
  const title =
    state === 'granted'
      ? 'Message alerts on — system notifications while the app is in the background'
      : state === 'denied'
        ? 'Alerts blocked — allow notifications for this site in your browser settings'
        : 'Enable message alerts — system notifications while the app is in the background'
  return (
    <button
      className={`btn btn-ghost notify-bell${state === 'denied' ? ' notify-bell-blocked' : ''}`}
      title={title}
      aria-pressed={enabled}
      onClick={() => {
        if (state === 'prompt') void requestNotifyPermission().then(setState)
      }}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor">
        <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5S10.5 3.17 10.5 4v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
      </svg>
      {enabled && <span className="notify-dot" aria-label="alerts on" />}
      <span className="notify-label">{enabled ? 'Alerts' : state === 'denied' ? 'Alerts blocked' : 'Enable alerts'}</span>
    </button>
  )
}

export function ConnectionBanner() {
  const [net, setNet] = useState<NetState>(getNetState())
  useEffect(() => onNetState(() => setNet(getNetState())), [])
  const cls = net === 'ONLINE' ? 'net-online' : net === 'RECONNECTING' ? 'net-reconnecting' : 'net-offline'
  return (
    <div className={`net-banner ${cls}`} role="status" aria-live="polite">
      <span className="net-dot" />
      {net === 'OFFLINE' ? 'OFFLINE — LOCAL CACHE' : net}
    </div>
  )
}

interface HeaderProps {
  identity: Identity
  view: View
  setView: (v: View) => void
  unreadTotal: number
  onShowGuide: () => void
  onInstall: (() => void) | null
  onSwitchIdentity: (id: Identity) => void
}

export function Header({ identity, view, setView, unreadTotal, onShowGuide, onInstall, onSwitchIdentity }: HeaderProps) {
  const profile = useLive(() => db.profiles.get(identity.address.toLowerCase()), [identity.address])
  const [switching, setSwitching] = useState(false)

  return (
    <header className="app-header">
      <div className="header-row">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <h1>CRIMECHAT</h1>
        </div>
        <nav className="tabs" aria-label="Main">
          {(['channels', 'board', 'vault'] as View[]).map((v) => (
            <button
              key={v}
              className={view === v ? 'tab active' : 'tab'}
              onClick={() => setView(v)}
              aria-pressed={view === v}
            >
              {v === 'channels' ? 'Channels' : v === 'board' ? 'Board' : 'Vault'}
              {v === 'channels' && unreadTotal > 0 && (
                <span className="unread-badge" aria-label={unreadTotal + ' unread messages'}>{unreadTotal}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <NotifyBell />
          {onInstall && (
            <button className="btn btn-ghost" onClick={onInstall}>
              Install
            </button>
          )}
          <button className="btn btn-ghost" onClick={onShowGuide}>
            Field guide
          </button>
        </div>
      </div>
      <div className="header-row header-row-sub">
        <ConnectionBanner />
        <div className="identity-block">
          <Identicon address={identity.address} size={26} />
          <span className="alias">{profile?.alias ?? identity.alias}</span>
          {profile && (
            <ReputationBar reputation={profile.reputation} disputes={profile.disputes} completed={profile.contracts_completed} />
          )}
          <AddressChip address={identity.address} />
          <button
            className="btn btn-ghost btn-small"
            disabled={switching}
            onClick={() => {
              setSwitching(true)
              void switchIdentity()
                .then(onSwitchIdentity)
                .finally(() => setSwitching(false))
            }}
          >
            {switching ? 'provisioning…' : 'Switch identity'}
          </button>
        </div>
      </div>
    </header>
  )
}
