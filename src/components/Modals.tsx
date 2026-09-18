import { useState } from 'react'

export function BootModal({ onEnter }: { onEnter: () => void }) {
  const [open, setOpen] = useState(() => !localStorage.getItem('crimechat-entered'))
  if (!open) return null
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Network notice">
      <div className="modal boot-modal">
        <div className="boot-glyph">◈</div>
        <h2>CRIMECHAT</h2>
        <p>
          You were not invited here. You were vouched for. Channels are address-to-address,
          settlement is escrowed, and nothing on this network forgets. Conduct yourself
          accordingly.
        </p>
        <button
          className="btn btn-primary"
          onClick={() => {
            localStorage.setItem('crimechat-entered', '1')
            setOpen(false)
            onEnter()
          }}
        >
          Enter
        </button>
      </div>
    </div>
  )
}

const SCRIPT: { n: number; title: string; body: string }[] = [
  { n: 1, title: 'Meet your operative', body: 'Open the preset channel from Pale Horse and read the welcome. Reply anything — the network answers.' },
  { n: 2, title: 'Open a channel by address', body: 'Hit “New channel”, paste another operative’s 0x address, and watch the channel open without a refresh. Try a nonsense address to see the network refuse you.' },
  { n: 3, title: 'Read the board', body: 'Switch to the Board. Filter by risk tier, sort by reward, and open a channel straight from a listing — a context card lands in the thread.' },
  { n: 4, title: 'Move money', body: 'In a channel, hit “Transfer”. Pick a token, amount (try MAX), add a memo, review the gas, confirm — the card flips pending → confirmed in ~2s and lands in both histories.' },
  { n: 5, title: 'Run an escrow', body: 'Open an escrow in a channel: propose → fund → mark delivered → release. Watch the stepper advance and the vault total move — the other party sees it live too.' },
  { n: 6, title: 'Pull the cable', body: 'Kill the connection mid-session. The banner reads OFFLINE — LOCAL CACHE, transfers disable themselves, and new messages queue. Reconnect and watch the outbox flush exactly once.' },
]

export function FieldGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Field guide" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Field guide</h2>
        <p className="muted">Six things a newcomer should try, in order.</p>
        <ol className="field-guide">
          {SCRIPT.map((s) => (
            <li key={s.n}>
              <strong>{s.title}</strong>
              <span>{s.body}</span>
            </li>
          ))}
        </ol>
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

export function ReloadPrompt({ onReload }: { onReload: () => void }) {
  return (
    <div className="reload-prompt" role="status">
      <span>An update is ready.</span>
      <button className="btn btn-primary btn-small" onClick={onReload}>
        Reload
      </button>
    </div>
  )
}
