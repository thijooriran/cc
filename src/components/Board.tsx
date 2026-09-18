import { useEffect, useMemo, useState } from 'react'
import type { Identity } from '../lib/auth'
import { db, type ContractRow } from '../lib/db'
import { useLive } from '../lib/store'
import { getNetState, onNetState } from '../lib/net'
import { addContact, postContract, startThread } from '../lib/actions'
import { preloadContractCard } from './Chat'
import { deadlineText, formatAmount, tokenUsd, usd } from '../lib/format'
import { TOKENS } from '../lib/tokens'
import { truncateAddress } from '../lib/identity'
import { Identicon, OfflineTooltip, RiskChip, TokenBadge } from './bits'

export function BoardView({ identity, onOpenChannel }: { identity: Identity; onOpenChannel: (threadId: number) => void }) {
  const contracts = useLive(async () => (await db.contracts.toArray()).sort((a, b) => b.created_at.localeCompare(a.created_at)), [])
  const profiles = useLive(async () => db.profiles.toArray(), [])
  const [tokenFilter, setTokenFilter] = useState('ALL')
  const [riskFilter, setRiskFilter] = useState('ALL')
  const [sort, setSort] = useState<'reward' | 'deadline'>('reward')
  const [showPost, setShowPost] = useState(false)
  const [net, setNet] = useState(getNetState())
  useEffect(() => onNetState(() => setNet(getNetState())), [])
  const offline = net === 'OFFLINE'

  const filtered = useMemo(() => {
    let list = (contracts ?? []).filter((c) => c.open)
    if (tokenFilter !== 'ALL') list = list.filter((c) => c.reward_token === tokenFilter)
    if (riskFilter !== 'ALL') list = list.filter((c) => c.risk_tier === riskFilter)
    list = [...list].sort((a, b) =>
      sort === 'reward'
        ? tokenUsd(b.reward_token, b.reward_amount) - tokenUsd(a.reward_token, a.reward_amount)
        : new Date(a.deadline).getTime() - new Date(b.deadline).getTime(),
    )
    return list
  }, [contracts, tokenFilter, riskFilter, sort])

  const aliasOf = (address: string) => profiles?.find((p) => p.address.toLowerCase() === address.toLowerCase())?.alias

  const openChannel = async (c: ContractRow) => {
    const { thread, error } = await startThread(identity.address, c.poster_address, c.id)
    if (!thread) {
      alert(error ?? 'failed to open channel')
      return
    }
    await preloadContractCard(identity.address, thread.id, c)
    onOpenChannel(thread.id)
  }

  return (
    <div className="board">
      <div className="board-head">
        <h2>Contract board</h2>
        <div className="board-filters">
          <select value={tokenFilter} onChange={(e) => setTokenFilter(e.target.value)} aria-label="Filter by token">
            <option value="ALL">All tokens</option>
            {TOKENS.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
          <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)} aria-label="Filter by risk">
            <option value="ALL">All risk</option>
            <option>LOW</option>
            <option>MEDIUM</option>
            <option>EXTREME</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as 'reward' | 'deadline')} aria-label="Sort">
            <option value="reward">By reward value</option>
            <option value="deadline">By deadline</option>
          </select>
          <OfflineTooltip disabled={offline}>
            <button className="btn btn-primary" disabled={offline} onClick={() => setShowPost(true)}>
              Post a contract
            </button>
          </OfflineTooltip>
        </div>
      </div>
      <div className="contract-grid">
        {filtered.map((c) => (
          <article className="contract-card" key={c.id}>
            <header>
              <h3>{c.title}</h3>
              <RiskChip tier={c.risk_tier} />
            </header>
            <p className="contract-blurb">{c.blurb}</p>
            <div className="contract-poster">
              <Identicon address={c.poster_address} size={22} />
              <span className="mono poster-addr" title={c.poster_address}>
                {aliasOf(c.poster_address) ?? truncateAddress(c.poster_address)}
              </span>
              <span className="muted">{c.region}</span>
            </div>
            <div className="contract-foot">
              <span className="reward mono">
                <TokenBadge symbol={c.reward_token} />
                {formatAmount(c.reward_token, c.reward_amount)}
                <span className="muted"> ≈ {usd(tokenUsd(c.reward_token, c.reward_amount))}</span>
              </span>
              <span className={'deadline mono' + (deadlineText(c.deadline) === 'expired' ? ' expired' : '')}>
                {deadlineText(c.deadline)}
              </span>
            </div>
            <button className="btn btn-ghost btn-block" onClick={() => void openChannel(c)}>
              Open channel
            </button>
          </article>
        ))}
        {filtered.length === 0 && <p className="muted">Nothing on the board matches. The underworld is quiet. Too quiet.</p>}
      </div>
      {showPost && <PostContractModal me={identity.address} onClose={() => setShowPost(false)} />}
    </div>
  )
}

function PostContractModal({ me, onClose }: { me: string; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [blurb, setBlurb] = useState('')
  const [token, setToken] = useState('ETH')
  const [amount, setAmount] = useState('')
  const [region, setRegion] = useState('')
  const [days, setDays] = useState('7')
  const [risk, setRisk] = useState('LOW')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setErr('')
    const deadline = new Date(Date.now() + (parseInt(days) || 7) * 86400000).toISOString()
    const r = await postContract(me, { title, blurb, token, amount: parseFloat(amount) || 0, region, deadline, risk })
    setBusy(false)
    if (!r.ok) {
      setErr(r.error ?? 'failed to post')
      return
    }
    onClose()
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Post a contract</h2>
        <p className="muted">Visible to every operative on the network. Euphemisms appreciated, instructions not.</p>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The Unwilling Briefcase" />
        </label>
        <label>
          Blurb
          <textarea rows={3} value={blurb} onChange={(e) => setBlurb(e.target.value)} placeholder="One or two sentences of pulp-noir. Theatrical, obviously invented." />
        </label>
        <div className="form-row">
          <label>
            Reward token
            <select value={token} onChange={(e) => setToken(e.target.value)}>
              {TOKENS.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input className="mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="4.2" />
          </label>
        </div>
        <div className="form-row">
          <label>
            Region
            <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Harbor District" />
          </label>
          <label>
            Days until deadline
            <input className="mono" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))} />
          </label>
          <label>
            Risk tier
            <select value={risk} onChange={(e) => setRisk(e.target.value)}>
              <option>LOW</option>
              <option>MEDIUM</option>
              <option>EXTREME</option>
            </select>
          </label>
        </div>
        {err && <p className="form-error">{err}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'posting…' : 'Post contract'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Nickname a counterparty from the board card context (used in channels too). */
export function useNicknameForm(userId: string) {
  const [open, setOpen] = useState(false)
  const [addr, setAddr] = useState('')
  const [nick, setNick] = useState('')
  const form = open ? (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add contact</h2>
        <label>
          Address
          <input className="mono" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" />
        </label>
        <label>
          Nickname
          <input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="The Dentist" />
        </label>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              void addContact(userId, addr, nick)
              setOpen(false)
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  ) : null
  return { form, openForm: (a: string) => { setAddr(a); setNick(''); setOpen(true) } }
}
