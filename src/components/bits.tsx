import { useState } from 'react'
import { identiconDataUri } from '../lib/identicon'
import { truncateAddress } from '../lib/identity'
import { TOKEN_COLORS } from '../lib/tokens'

export function Identicon({ address, size = 36 }: { address: string; size?: number }) {
  return (
    <img
      className="identicon"
      src={identiconDataUri(address, size * 2)}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  )
}

export function AddressChip({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="addr-chip mono"
      title={address}
      aria-label={'Copy address ' + address}
      onClick={() => {
        void navigator.clipboard?.writeText(address)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'copied' : truncateAddress(address)}
    </button>
  )
}

export function TokenBadge({ symbol }: { symbol: string }) {
  const color = TOKEN_COLORS[symbol] ?? '#8892a0'
  return (
    <span className="token-badge mono" style={{ ['--tk' as string]: color }}>
      {symbol}
    </span>
  )
}

export function ReputationBar({ reputation, disputes, completed }: { reputation: number; disputes?: number; completed?: number }) {
  const band = reputation >= 70 ? 'good' : reputation >= 40 ? 'mid' : 'bad'
  return (
    <span className={`rep-bar rep-${band}`} title={`reputation ${reputation}/100${completed != null ? ` · ${completed} contracts` : ''}${disputes != null ? ` · ${disputes} disputes` : ''}`}>
      <span className="rep-track">
        <span className="rep-fill" style={{ width: reputation + '%' }} />
      </span>
      <span className="rep-num mono">{reputation}</span>
    </span>
  )
}

export function RiskChip({ tier }: { tier: string }) {
  const cls = tier === 'EXTREME' ? 'risk-extreme' : tier === 'MEDIUM' ? 'risk-medium' : 'risk-low'
  return <span className={`risk-chip ${cls}`}>{tier}</span>
}

export function OfflineTooltip({ children, disabled }: { children: React.ReactNode; disabled: boolean }) {
  if (!disabled) return <>{children}</>
  return (
    <span className="offline-wrap" data-tip="Offline — balance changes are disabled on the local cache.">
      {children}
    </span>
  )
}
