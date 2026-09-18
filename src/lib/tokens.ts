// Token registry — mirrors the crimechat_tokens seed in the migration.
export interface Token {
  symbol: string
  name: string
  decimals: number
  usd_price: number
}

export const TOKENS: Token[] = [
  { symbol: 'ETH', name: 'Ether', decimals: 18, usd_price: 3421.5 },
  { symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, usd_price: 67400.0 },
  { symbol: 'USDT', name: 'Tether USD', decimals: 6, usd_price: 1.0 },
  { symbol: 'USDC', name: 'USD Coin', decimals: 6, usd_price: 1.0 },
  { symbol: 'DAI', name: 'Dai', decimals: 18, usd_price: 1.0 },
  { symbol: 'LINK', name: 'Chainlink', decimals: 18, usd_price: 17.4 },
  { symbol: 'UNI', name: 'Uniswap', decimals: 18, usd_price: 9.8 },
  { symbol: 'AAVE', name: 'Aave', decimals: 18, usd_price: 152.3 },
  { symbol: 'SHIB', name: 'Shiba Inu', decimals: 18, usd_price: 0.0000212 },
  { symbol: 'PEPE', name: 'Pepe', decimals: 18, usd_price: 0.00000891 },
]

export const TOKEN_MAP: Map<string, Token> = new Map(TOKENS.map((t) => [t.symbol, t]))

// Token badge colors — CSS-only colored badge per token.
export const TOKEN_COLORS: Record<string, string> = {
  ETH: '#8a9cff',
  WBTC: '#f7931a',
  USDT: '#26a17b',
  USDC: '#2775ca',
  DAI: '#f5ac37',
  LINK: '#4a6ff5',
  UNI: '#ff5da2',
  AAVE: '#9c64e6',
  SHIB: '#ffa726',
  PEPE: '#7cb342',
}
