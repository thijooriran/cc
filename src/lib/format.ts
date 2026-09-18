import { TOKEN_MAP } from './tokens'

export function uuid(): string {
  return crypto.randomUUID()
}

export function fakeTxHash(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return '0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function usd(value: number): string {
  if (value >= 1000) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (value >= 1) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (value === 0) return '$0'
  return '$' + value.toPrecision(3)
}

export function tokenUsd(symbol: string, amount: number): number {
  const t = TOKEN_MAP.get(symbol)
  return t ? amount * t.usd_price : 0
}

export function formatAmount(symbol: string, amount: number): string {
  const t = TOKEN_MAP.get(symbol)
  const max = t ? Math.min(t.decimals, 4) : 4
  const s = amount.toLocaleString('en-US', { maximumFractionDigits: max })
  return `${s} ${symbol}`
}

export function relativeTime(ts: number | string | Date): string {
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const diff = Date.now() - t
  const s = Math.max(0, Math.floor(diff / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function deadlineText(ts: number | string | Date): string {
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const diff = t - Date.now()
  if (diff <= 0) return 'expired'
  const d = Math.floor(diff / 86400000)
  if (d >= 1) return `${d}d left`
  const h = Math.floor(diff / 3600000)
  if (h >= 1) return `${h}h left`
  return `${Math.max(1, Math.floor(diff / 60000))}m left`
}
