// Compact Keccak-256 (pre-SHA3 padding) implemented with BigInt lanes —
// used for EIP-55 address checksumming. No external crypto dependency.
// Verified against the standard test vectors (empty string, "abc").

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

// rotation offsets indexed x + 5*y
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
]

const M64 = (1n << 64n) - 1n

const rotl = (x: bigint, n: number): bigint =>
  n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64

function keccakF(s: bigint[]): void {
  for (let r = 0; r < 24; r++) {
    // theta
    const C: bigint[] = []
    for (let x = 0; x < 5; x++) C.push(s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20])
    const D: bigint[] = []
    for (let x = 0; x < 5; x++) D.push(C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1))
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] ^= D[x]
    // rho + pi
    const B: bigint[] = new Array(25).fill(0n)
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y])
      }
    }
    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        s[x + 5 * y] = B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & B[(x + 2) % 5 + 5 * y])
      }
    }
    // iota
    s[0] ^= RC[r]
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136 // bytes, for 256-bit output
  const s: bigint[] = new Array(25).fill(0n)

  let offset = 0
  while (offset + rate <= data.length) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n
      for (let j = 0; j < 8; j++) lane |= BigInt(data[offset + 8 * i + j]) << BigInt(8 * j)
      s[i] ^= lane
    }
    keccakF(s)
    offset += rate
  }

  const block = new Uint8Array(rate)
  block.set(data.subarray(offset))
  block[data.length - offset] |= 0x01 // Keccak domain separation (not SHA3's 0x06)
  block[rate - 1] |= 0x80
  for (let i = 0; i < rate / 8; i++) {
    let lane = 0n
    for (let j = 0; j < 8; j++) lane |= BigInt(block[8 * i + j]) << BigInt(8 * j)
    s[i] ^= lane
  }
  keccakF(s)

  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 8; j++) out[8 * i + j] = Number((s[i] >> BigInt(8 * j)) & 0xffn)
  }
  return out
}
