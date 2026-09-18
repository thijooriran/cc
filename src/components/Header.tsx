import { useEffect, useState } from 'react'
import { Identicon, AddressChip, ReputationBar } from './bits'
import type { Identity } from '../lib/auth'
import { useLive } from '../lib/store'
import { db } from '../lib/db'
import { getNetState, onNetState, type NetState } from '../lib/net'
import { switchIdentity } from '../lib/auth'

export type View = 'channels' | 'board' | 'vault'

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
  onShowGuide: () => void
  onInstall: (() => void) | null
  onSwitchIdentity: (id: Identity) => void
}

export function Header({ identity, view, setView, onShowGuide, onInstall, onSwitchIdentity }: HeaderProps) {
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
            </button>
          ))}
        </nav>
        <div className="header-actions">
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
