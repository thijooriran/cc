import { keccak256 } from './keccak'

// ---------------------------------------------------------------------------
// Mock wallet identity: random 20 bytes as 0x + 40 hex chars with
// EIP-55-style mixed-case checksumming. Deterministic alias + reputation
// are derived from the address bytes so a fresh user always looks the same.
// ---------------------------------------------------------------------------

const ALIASES = [
  'The Locksmith', 'Pale Horse', 'Number Nine', 'Glass Jaw', 'Vesper',
  'Quiet Room', 'The Undertaker', 'Halfmoon', 'Cinder', 'Low Tide',
  'Moth', 'The Cartographer', 'Bramble', 'Night Clerk', 'Solvent',
  'Blue Hour', 'The Alibi', 'Tin Star', 'Rook', 'Signal Fade',
]

export function randomAddress(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return checksumAddress(bytes)
}

export function checksumAddress(bytes: Uint8Array): string {
  const lower = '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  const hash = Array.from(keccak256(new TextEncoder().encode(lower)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i + 2].toUpperCase() : lower[i + 2]
  }
  return out
}

export function isValidAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v.trim())
}

export function addressBytes(address: string): Uint8Array {
  const out = new Uint8Array(20)
  for (let i = 0; i < 20; i++) out[i] = parseInt(address.slice(2 + 2 * i, 4 + 2 * i), 16)
  return out
}

export function deterministicAlias(address: string): string {
  const b = addressBytes(address)
  return ALIASES[b[1] % ALIASES.length]
}

export function deterministicReputation(address: string): number {
  const b = addressBytes(address)
  return 20 + ((b[2] * 256 + b[3]) % 71) // 20..90
}

export function deterministicCounts(address: string): { completed: number; disputes: number } {
  const b = addressBytes(address)
  return { completed: b[4] % 14, disputes: b[5] % 3 }
}

export function truncateAddress(address: string): string {
  return address.slice(0, 6) + '…' + address.slice(-4)
}
