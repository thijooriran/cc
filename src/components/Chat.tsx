import { useEffect, useMemo, useRef, useState } from 'react'
import type { Identity } from '../lib/auth'
import { db, type EscrowRow, type MessageRow, type ThreadRow } from '../lib/db'
import { useLive } from '../lib/store'
import { getNetState, onNetState } from '../lib/net'
import {
  createEscrow,
  escrowTransition,
  sendTextMessage,
  sendTransfer,
  startThread,
} from '../lib/actions'
import { enqueueMessage, retryMessage } from '../lib/outbox'
import { getPresence, onPresence, sendTyping } from '../lib/realtime'
import { unreadByThread, markThreadRead } from '../lib/unread'
import { truncateAddress } from '../lib/identity'
import { formatAmount, relativeTime, tokenUsd, usd } from '../lib/format'
import { TOKENS, TOKEN_MAP } from '../lib/tokens'
import { Identicon, AddressChip, OfflineTooltip, TokenBadge } from './bits'

// ---------------------------------------------------------------------------

export function ChatView({
  identity,
  activeThreadId,
  setActiveThreadId,
}: {
  identity: Identity
  activeThreadId: number | null
  setActiveThreadId: (id: number | null) => void
}) {
  const [showNew, setShowNew] = useState(false)
  const me = identity.address.toLowerCase()

  const threads = useLive(
    async () => {
      const all = await db.threads.toArray()
      return all
        .filter((t) => t.participant_a === me || t.participant_b === me)
        .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))
    },
    [me],
  )
  const unread = useLive(() => unreadByThread(me), [me])

  return (
    <div className={activeThreadId != null ? 'chat-layout has-active' : 'chat-layout'}>
      <aside className="thread-list" aria-label="Channels">
        <div className="thread-list-head">
          <h2>Channels</h2>
          <button className="btn btn-primary btn-small" onClick={() => setShowNew(true)}>
            + New
          </button>
        </div>
        <ul>
          {(threads ?? []).map((t) => (
            <ThreadListItem
              key={t.id}
              thread={t}
              me={me}
              unread={unread?.get(t.id) ?? 0}
              active={t.id === activeThreadId}
              onSelect={() => setActiveThreadId(t.id)}
            />
          ))}
          {threads && threads.length === 0 && <li className="muted thread-empty">No channels yet. Open one by address.</li>}
        </ul>
      </aside>
      {activeThreadId != null ? (
        <ChatPane key={activeThreadId} identity={identity} threadId={activeThreadId} />
      ) : (
        <div className="chat-empty">
          <div className="boot-glyph">◈</div>
          <p>Select a channel, or open a new one by address.</p>
        </div>
      )}
      {showNew && (
        <NewThreadModal
          me={identity.address}
          onClose={() => setShowNew(false)}
          onOpen={(id) => {
            setShowNew(false)
            setActiveThreadId(id)
          }}
        />
      )}
    </div>
  )
}

function ThreadListItem({
  thread,
  me,
  unread,
  active,
  onSelect,
}: {
  thread: ThreadRow
  me: string
  unread: number
  active: boolean
  onSelect: () => void
}) {
  const other = thread.participant_a === me ? thread.participant_b : thread.participant_a
  const profile = useLive(() => db.profiles.get(other), [other])
  const contact = useLive(async () => {
    const all = await db.contacts.toArray()
    return all.find((c) => c.contact_address === other)
  }, [other, thread.id])
  const last = useLive(
    async () => {
      const msgs = await db.messages.where('thread_id').equals(thread.id).sortBy('created_at')
      return msgs[msgs.length - 1]
    },
    [thread.id, thread.last_message_at],
  )
  const presence = usePresenceSnapshot()
  const online = presence.online.has(other)

  return (
    <li>
      <button className={active ? 'thread-item active' : 'thread-item'} onClick={onSelect}>
        <span className={'presence-dot' + (online ? ' on' : '')} title={online ? 'online' : 'offline'} />
        <Identicon address={other} size={32} />
        <span className="thread-meta">
          <span className="thread-alias">{contact?.nickname ?? profile?.alias ?? truncateAddress(other)}</span>
          <span className="thread-preview">
            {last
              ? last.kind === 'text'
                ? last.body
                : last.kind === 'transfer'
                  ? '⇄ transfer moved'
                  : last.kind === 'escrow'
                    ? '◈ escrow update'
                    : '· system'
              : 'no messages yet'}
          </span>
        </span>
        <span className="thread-time mono">{relativeTime(thread.last_message_at)}</span>
        {unread > 0 && <span className="unread-badge" aria-label={unread + ' unread'}>{unread}</span>}
      </button>
    </li>
  )
}

function usePresenceSnapshot() {
  const [p, setP] = useState(getPresence())
  useEffect(() => onPresence(() => setP(getPresence())), [])
  return p
}

// ---------------------------------------------------------------------------

function ChatPane({ identity, threadId }: { identity: Identity; threadId: number }) {
  const me = identity.address.toLowerCase()
  const thread = useLive(() => db.threads.get(threadId), [threadId])
  const other = thread ? (thread.participant_a === me ? thread.participant_b : thread.participant_a) : ''
  const profile = useLive(() => (other ? db.profiles.get(other) : undefined), [other])
  const messages = useLive(
    async () => (await db.messages.where('thread_id').equals(threadId).sortBy('created_at')).filter((m) => m.kind !== 'transfer' || m.thread_id === threadId),
    [threadId],
  )
  const escrows = useLive(async () => (await db.escrows.where('thread_id').equals(threadId).toArray()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [threadId])
  const presence = usePresenceSnapshot()

  // Open thread = read thread, including messages that arrive while it stays open.
  useEffect(() => {
    void markThreadRead(threadId)
  }, [threadId, messages])
  const [sendFlow, setSendFlow] = useState(false)
  const [escrowFlow, setEscrowFlow] = useState(false)
  const offline = getNetState() === 'OFFLINE'
  const [net, setNet] = useState(getNetState())
  useEffect(() => onNetState(() => setNet(getNetState())), [])
  const offlineNow = net === 'OFFLINE'

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages?.length])

  if (!thread) return <div className="chat-empty muted">Channel not found.</div>

  const onlineDot = presence.online.has(other)
  const typing = presence.typing.has(other)

  return (
    <section className="chat-pane" aria-label="Conversation">
      <div className="chat-head">
        <Identicon address={other} size={34} />
        <div className="chat-head-meta">
          <span className="alias">{profile?.alias ?? truncateAddress(other)}</span>
          <span className="chat-head-sub mono">
            <span className={'presence-dot' + (onlineDot ? ' on' : '')} />
            {typing ? 'typing…' : onlineDot ? 'online' : 'last seen ' + relativeTime(profile?.last_seen_at ?? thread.last_message_at)}
          </span>
        </div>
        <AddressChip address={other} />
        <div className="chat-head-actions">
          <OfflineTooltip disabled={offlineNow}>
            <button className="btn btn-ghost" disabled={offlineNow} onClick={() => setSendFlow(true)}>
              Transfer
            </button>
          </OfflineTooltip>
          <OfflineTooltip disabled={offlineNow}>
            <button className="btn btn-ghost" disabled={offlineNow} onClick={() => setEscrowFlow(true)}>
              Escrow
            </button>
          </OfflineTooltip>
        </div>
      </div>

      <EscrowPanel me={identity.address} threadId={threadId} />

      <div className="message-list" ref={listRef}>
        {(messages ?? []).map((m) => (
          <MessageBubble key={String(m.id)} message={m} me={identity.address} />
        ))}
        {messages && messages.length === 0 && <p className="muted chat-empty-note">Say something. Or don’t — but the meter is running.</p>}
      </div>

      <Composer me={identity.address} threadId={threadId} />

      {sendFlow && <SendFlowModal me={identity.address} other={other} threadId={threadId} onClose={() => setSendFlow(false)} />}
      {escrowFlow && <EscrowModal me={identity.address} threadId={threadId} onClose={() => setEscrowFlow(false)} />}
    </section>
  )
}

// ---------------------------------------------------------------------------

function MessageBubble({ message, me }: { message: MessageRow; me: string }) {
  const mine = message.sender_address.toLowerCase() === me.toLowerCase()
  const cls = [
    'msg',
    mine ? 'msg-mine' : 'msg-theirs',
    message.kind !== 'text' ? 'msg-card' : '',
    message.status === 'pending' ? 'msg-pending' : '',
    message.status === 'failed' ? 'msg-failed' : '',
  ].join(' ')

  return (
    <div className={cls}>
      {!mine && <Identicon address={message.sender_address} size={28} />}
      <div className="msg-body">
        <div className="msg-head mono">
          <AddressChip address={message.sender_address} />
          <span className="msg-time">{relativeTime(message.created_at)}</span>
          {message.status === 'pending' && (
            <span className="msg-status" title="queued — will send when reconnected">
              ⧗
            </span>
          )}
          {message.status === 'failed' && (
            <button
              className="msg-retry"
              title={String(message.payload.error ?? 'send failed — retry')}
              onClick={() => message.client_id && void retryMessage(message.client_id)}
            >
              ⚠ retry
            </button>
          )}
        </div>
        {message.kind === 'text' && <p className="msg-text">{message.body}</p>}
        {message.kind === 'transfer' && <TransferCard message={message} me={me} />}
        {message.kind === 'escrow' && <EscrowCard payload={message.payload} />}
        {message.kind === 'system' && <SystemCard message={message} />}
      </div>
    </div>
  )
}

function TransferCard({ message, me }: { message: MessageRow; me: string }) {
  const p = message.payload as {
    token?: string
    amount?: number
    to?: string
    memo?: string
    tx_hash?: string
    block_number?: number
    status?: string
    counterparty?: string
    direction?: string
  }
  const mine = message.sender_address.toLowerCase() === me.toLowerCase()
  const token = p.token ?? '???'
  const amount = p.amount ?? 0
  // The server echo's direction is from the SENDER's perspective — treat a
  // card whose counterparty is us as incoming, regardless of the flag.
  const incoming = !!p.counterparty && p.counterparty.toLowerCase() === me.toLowerCase()
  const out = mine || (p.direction === 'out' && !incoming)
  return (
    <div className={'tx-card' + (p.status === 'pending' ? ' tx-pending' : '')}>
      <div className="tx-row">
        <span className="tx-dir">{out ? '▸ sent' : '▹ received'}</span>
        <TokenBadge symbol={token} />
        <span className="tx-amt mono">{formatAmount(token, amount)}</span>
        <span className="tx-usd mono">{usd(tokenUsd(token, amount))}</span>
      </div>
      {p.memo && <div className="tx-memo">“{p.memo}”</div>}
      {p.tx_hash && (
        <div className="tx-meta mono">
          <span title={p.tx_hash}>tx {p.tx_hash.slice(0, 10)}…{p.tx_hash.slice(-6)}</span>
          <span>block {p.block_number}</span>
          <span className={p.status === 'pending' ? 'tx-state-pending' : 'tx-state-ok'}>
            {p.status === 'pending' ? 'pending…' : 'confirmed'}
          </span>
        </div>
      )}
    </div>
  )
}

function EscrowCard({ payload }: { payload: Record<string, unknown> }) {
  const p = payload as { state?: string; token?: string; amount?: string; payer?: string; payee?: string }
  return (
    <div className="escrow-card">
      <div className="tx-row">
        <span className="tx-dir">◈ escrow</span>
        <TokenBadge symbol={p.token ?? '?'} />
        <span className="tx-amt mono">{formatAmount(p.token ?? '?', Number(p.amount ?? 0))}</span>
        <span className={`escrow-state st-${(p.state ?? '').toLowerCase()}`}>{p.state}</span>
      </div>
      <div className="tx-meta mono">
        <span>payer {truncateAddress(p.payer ?? '')}</span>
        <span>payee {truncateAddress(p.payee ?? '')}</span>
      </div>
    </div>
  )
}

function SystemCard({ message }: { message: MessageRow }) {
  const p = message.payload as {
    contract_id?: number
    contract_title?: string
    contract_blurb?: string
    reward_token?: string
    reward_amount?: number
    region?: string
    risk_tier?: string
  }
  if (p.contract_title) {
    return (
      <div className="contract-context">
        <div className="cc-label">◈ contract context</div>
        <div className="cc-title">{p.contract_title}</div>
        <div className="cc-blurb">{p.contract_blurb}</div>
        <div className="tx-row">
          <TokenBadge symbol={p.reward_token ?? '?'} />
          <span className="tx-amt mono">{formatAmount(p.reward_token ?? '?', p.reward_amount ?? 0)}</span>
          <span className="cc-region">{p.region}</span>
        </div>
      </div>
    )
  }
  return <div className="system-card">{message.body}</div>
}

// ---------------------------------------------------------------------------

function Composer({ me, threadId }: { me: string; threadId: number }) {
  const [text, setText] = useState('')
  const lastTyping = useRef(0)
  const send = () => {
    if (!text.trim()) return
    void sendTextMessage(me, threadId, text)
    setText('')
  }
  return (
    <div className="composer">
      <textarea
        value={text}
        rows={1}
        placeholder="Speak. Or don’t."
        aria-label="Message"
        onChange={(e) => {
          setText(e.target.value)
          const now = Date.now()
          if (now - lastTyping.current > 1500) {
            lastTyping.current = now
            sendTyping(threadId)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
      />
      <button className="btn btn-primary" onClick={send} disabled={!text.trim()}>
        Send
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

function NewThreadModal({ me, onClose, onOpen }: { me: string; onClose: () => void; onOpen: (id: number) => void }) {
  const [addr, setAddr] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    setErr('')
    const { thread, error } = await startThread(me, addr)
    setBusy(false)
    if (error || !thread) setErr(error ?? 'failed to open channel')
    else onOpen(thread.id)
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New channel</h2>
        <p className="muted">Paste a counterparty address. The network will decide if they exist.</p>
        <input
          className="mono"
          placeholder="0x…"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          autoFocus
        />
        {err && <p className="form-error">{err}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !addr.trim()} onClick={() => void open()}>
            {busy ? 'asking around…' : 'Open channel'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function SendFlowModal({ me, other, threadId, onClose }: { me: string; other: string; threadId: number; onClose: () => void }) {
  const [step, setStep] = useState<'pick' | 'review'>('pick')
  const [token, setToken] = useState('ETH')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const balances = useLive(async () => db.balances.toArray(), [])
  const myProfile = useLive(async () => (await db.profiles.toArray()).find((p) => p.address.toLowerCase() === me.toLowerCase()), [me])
  const bal = balances?.find((b) => b.profile_id === myProfile?.id && b.token_symbol === token)
  const amt = parseFloat(amount) || 0
  const t = TOKEN_MAP.get(token)
  const gasEth = 0.00042
  const gasUsd = gasEth * (TOKEN_MAP.get('ETH')?.usd_price ?? 0)

  const confirm = async () => {
    setBusy(true)
    setErr('')
    const r = await sendTransfer(me, { to: other, token, amount: amt, memo, threadId })
    setBusy(false)
    if (!r.ok) {
      setErr(r.error ?? 'transfer failed')
      return
    }
    onClose()
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Transfer</h2>
        {step === 'pick' ? (
          <>
            <label>
              Token
              <select value={token} onChange={(e) => setToken(e.target.value)}>
                {TOKENS.map((tk) => (
                  <option key={tk.symbol} value={tk.symbol}>
                    {tk.symbol} — {tk.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount
              <span className="amount-row">
                <input
                  className="mono"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                />
                <button className="btn btn-ghost btn-small" onClick={() => bal && setAmount(String(bal.amount))}>
                  MAX
                </button>
              </span>
            </label>
            <p className="muted small mono">
              balance: {bal ? formatAmount(token, bal.amount) : '—'}
            </p>
            <label>
              Memo <span className="muted">(optional)</span>
              <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="for services rendered" />
            </label>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={!(amt > 0) || (bal != null && bal.amount < amt)}
                onClick={() => setStep('review')}
              >
                Review
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="review-list">
              <dt>To</dt>
              <dd className="mono">{other}</dd>
              <dt>Amount</dt>
              <dd className="mono">
                {formatAmount(token, amt)} <span className="muted">≈ {usd(tokenUsd(token, amt))}</span>
              </dd>
              <dt>Memo</dt>
              <dd>{memo || '—'}</dd>
              <dt>Gas</dt>
              <dd className="mono">
                {gasEth} ETH <span className="muted">≈ {usd(gasUsd)}</span>
              </dd>
            </dl>
            {err && <p className="form-error">{err}</p>}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setStep('pick')}>
                Back
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>
                {busy ? 'signing…' : 'Confirm transfer'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function EscrowModal({ me, threadId, onClose }: { me: string; threadId: number; onClose: () => void }) {
  const [token, setToken] = useState('ETH')
  const [amount, setAmount] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const amt = parseFloat(amount) || 0

  const go = async () => {
    setBusy(true)
    setErr('')
    const r = await createEscrow(me, threadId, token, amt)
    setBusy(false)
    if (!r.ok) {
      setErr(r.error ?? 'failed')
      return
    }
    onClose()
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Open escrow</h2>
        <p className="muted">PROPOSED → FUNDED → DELIVERED → RELEASED. Disputes and refunds available at the right moments.</p>
        <label>
          Token
          <select value={token} onChange={(e) => setToken(e.target.value)}>
            {TOKENS.map((tk) => (
              <option key={tk.symbol} value={tk.symbol}>
                {tk.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount
          <input className="mono" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
        </label>
        {err && <p className="form-error">{err}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !(amt > 0)} onClick={() => void go()}>
            {busy ? 'opening…' : 'Propose escrow'}
          </button>
        </div>
      </div>
    </div>
  )
}

const ESCROW_STEPS = ['PROPOSED', 'FUNDED', 'DELIVERED', 'RELEASED']

function EscrowPanel({ me, threadId }: { me: string; threadId: number }) {
  const escrows = useLive(async () => (await db.escrows.where('thread_id').equals(threadId).toArray()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [threadId])
  const [net, setNet] = useState(getNetState())
  useEffect(() => onNetState(() => setNet(getNetState())), [])
  const offline = net === 'OFFLINE'
  if (!escrows || escrows.length === 0) return null

  const active = escrows.filter((e) => !['RELEASED', 'REFUNDED'].includes(e.state))
  const locked = active.filter((e) => ['FUNDED', 'DELIVERED', 'DISPUTED'].includes(e.state))
  const lockedUsd = locked.reduce((s, e) => s + tokenUsd(e.token_symbol, e.amount), 0)

  const act = (id: number, t: 'fund' | 'deliver' | 'release' | 'dispute' | 'refund') => {
    void escrowTransition(me, id, t)
  }

  return (
    <div className="escrow-panel">
      <div className="escrow-panel-head">
        <span>Escrow vault</span>
        {locked.length > 0 && (
          <span className="vault-total mono">
            {locked.map((e) => formatAmount(e.token_symbol, e.amount)).join(' + ')} ≈ {usd(lockedUsd)} locked
          </span>
        )}
      </div>
      {active.map((e) => (
        <EscrowStepper key={e.id} e={e} me={me} offline={offline} onAct={act} />
      ))}
    </div>
  )
}

function EscrowStepper({
  e,
  me,
  offline,
  onAct,
}: {
  e: EscrowRow
  me: string
  offline: boolean
  onAct: (id: number, t: 'fund' | 'deliver' | 'release' | 'dispute' | 'refund') => void
}) {
  const isPayer = e.payer_address.toLowerCase() === me.toLowerCase()
  const stepIdx = ESCROW_STEPS.indexOf(e.state)
  const stepper = (
    <div className="stepper" aria-label={'Escrow state ' + e.state}>
      {ESCROW_STEPS.map((s, i) => (
        <span key={s} className={'step' + (i < stepIdx ? ' done' : i === stepIdx ? ' current' : '') + (e.state === 'DISPUTED' && i === stepIdx ? ' disputed' : '')}>
          {s}
        </span>
      ))}
      {e.state === 'DISPUTED' && <span className="step disputed current">DISPUTED</span>}
      {e.state === 'REFUNDED' && <span className="step disputed current">REFUNDED</span>}
    </div>
  )

  const btn = (label: string, t: 'fund' | 'deliver' | 'release' | 'dispute' | 'refund', danger = false) => (
    <OfflineTooltip key={t} disabled={offline}>
      <button className={danger ? 'btn btn-danger btn-small' : 'btn btn-primary btn-small'} disabled={offline} onClick={() => onAct(e.id, t)}>
        {label}
      </button>
    </OfflineTooltip>
  )

  return (
    <div className="escrow-item">
      <div className="tx-row">
        <TokenBadge symbol={e.token_symbol} />
        <span className="tx-amt mono">{formatAmount(e.token_symbol, e.amount)}</span>
        <span className="muted small">{isPayer ? 'you pay' : 'you receive'}</span>
      </div>
      {stepper}
      <div className="escrow-actions">
        {e.state === 'PROPOSED' && isPayer && btn('Fund', 'fund')}
        {e.state === 'PROPOSED' && !isPayer && <span className="muted small">waiting for the payer to fund…</span>}
        {e.state === 'FUNDED' && !isPayer && btn('Mark delivered', 'deliver')}
        {e.state === 'FUNDED' && isPayer && btn('Dispute', 'dispute', true)}
        {e.state === 'DELIVERED' && isPayer && btn('Release', 'release')}
        {e.state === 'DELIVERED' && isPayer && btn('Dispute', 'dispute', true)}
        {e.state === 'DELIVERED' && !isPayer && <span className="muted small">waiting for the payer to release…</span>}
        {e.state === 'DISPUTED' && isPayer && btn('Refund', 'refund')}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Preload a contract context card into a thread (used by the Board). */
export async function preloadContractCard(me: string, threadId: number, c: {
  id: number
  title: string
  blurb: string
  reward_token: string
  reward_amount: number
  region: string
  risk_tier: string
}): Promise<void> {
  await enqueueMessage({
    thread_id: threadId,
    sender_address: me,
    body: 'contract',
    kind: 'system',
    payload: {
      contract_id: c.id,
      contract_title: c.title,
      contract_blurb: c.blurb,
      reward_token: c.reward_token,
      reward_amount: c.reward_amount,
      region: c.region,
      risk_tier: c.risk_tier,
    },
  })
}
