import { useEffect, useMemo, useState } from 'react'
import type { Identity } from '../lib/auth'
import { db } from '../lib/db'
import { useLive } from '../lib/store'
import { relativeTime, tokenUsd, usd } from '../lib/format'
import { TOKENS } from '../lib/tokens'
import { truncateAddress } from '../lib/identity'
import { TokenBadge } from './bits'

export function VaultView({ identity }: { identity: Identity }) {
  const [tab, setTab] = useState<'portfolio' | 'history'>('portfolio')
  return (
    <div className="vault">
      <div className="board-head">
        <h2>Vault</h2>
        <nav className="tabs" aria-label="Vault">
          <button className={tab === 'portfolio' ? 'tab active' : 'tab'} onClick={() => setTab('portfolio')}>
            Portfolio
          </button>
          <button className={tab === 'history' ? 'tab active' : 'tab'} onClick={() => setTab('history')}>
            Transfers
          </button>
        </nav>
      </div>
      {tab === 'portfolio' ? <Portfolio identity={identity} /> : <History me={identity.address} />}
    </div>
  )
}

function Portfolio({ identity }: { identity: Identity }) {
  const rows = useLive(async () => {
    const profile = await db.profiles.get(identity.address.toLowerCase())
    const all = await db.balances.where('profile_id').equals(profile?.id ?? '').toArray()
    return all
      .map((b) => ({ ...b, usd: tokenUsd(b.token_symbol, b.amount) }))
      .sort((a, b) => b.usd - a.usd)
  }, [identity.address])
  const total = (rows ?? []).reduce((s, r) => s + r.usd, 0)

  return (
    <div className="portfolio">
      <div className="portfolio-total">
        <span className="muted">Total simulated value</span>
        <span className="portfolio-total-num mono">{usd(total)}</span>
      </div>
      <table className="ledger">
        <thead>
          <tr>
            <th>Token</th>
            <th className="num">Balance</th>
            <th className="num">Price</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.token_symbol}>
              <td>
                <TokenBadge symbol={r.token_symbol} />
              </td>
              <td className="num mono">{r.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
              <td className="num mono">{usd(tokenUsd(r.token_symbol, 1))}</td>
              <td className="num mono">{usd(r.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Balances are seeded per identity and move only through confirmed transfers and escrows. All values are simulated.</p>
    </div>
  )
}

function History({ me }: { me: string }) {
  const [tokenFilter, setTokenFilter] = useState('ALL')
  const transfers = useLive(
    async () => (await db.transfers.toArray()).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [],
  )
  const profiles = useLive(async () => db.profiles.toArray(), [])
  const aliasOf = (a: string) => profiles?.find((p) => p.address.toLowerCase() === a.toLowerCase())?.alias

  const list = useMemo(() => {
    let l = transfers ?? []
    if (tokenFilter !== 'ALL') l = l.filter((t) => t.token_symbol === tokenFilter)
    return l.filter((t) => t.from_address.toLowerCase() === me.toLowerCase() || t.to_address.toLowerCase() === me.toLowerCase())
  }, [transfers, tokenFilter, me])

  return (
    <div className="history">
      <div className="board-filters">
        <select value={tokenFilter} onChange={(e) => setTokenFilter(e.target.value)} aria-label="Filter by token">
          <option value="ALL">All tokens</option>
          {TOKENS.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol}
            </option>
          ))}
        </select>
      </div>
      <table className="ledger">
        <thead>
          <tr>
            <th>When</th>
            <th>Direction</th>
            <th>Counterparty</th>
            <th>Token</th>
            <th className="num">Amount</th>
            <th>Tx</th>
            <th className="num">Block</th>
          </tr>
        </thead>
        <tbody>
          {list.map((t) => {
            const out = t.from_address.toLowerCase() === me.toLowerCase()
            return (
              <tr key={t.id}>
                <td className="mono">{relativeTime(t.created_at)}</td>
                <td>
                  <span className={out ? 'dir-out' : 'dir-in'}>{out ? '▸ out' : '▹ in'}</span>
                </td>
                <td className="mono" title={out ? t.to_address : t.from_address}>
                  {aliasOf(out ? t.to_address : t.from_address) ?? truncateAddress(out ? t.to_address : t.from_address)}
                </td>
                <td>
                  <TokenBadge symbol={t.token_symbol} />
                </td>
                <td className="num mono">{t.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                <td className="mono" title={t.tx_hash}>
                  {t.tx_hash.slice(0, 8)}…
                </td>
                <td className="num mono">{t.block_number}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {list.length === 0 && <p className="muted">No transfers yet. Money is like silence — best moved rarely.</p>}
    </div>
  )
}
