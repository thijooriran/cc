import { addressBytes } from './identity'

// Deterministic 8x8 symmetric identicon rendered as an inline SVG.
// Hue comes from the first address byte; cells from a byte stream.
export function identiconDataUri(address: string, size = 40): string {
  const bytes = addressBytes(address)
  const hue = bytes[0] * 1.41 // 0..360
  const cell = size / 8
  const sat = 62
  const light = 56
  let rects = ''
  // left 4 columns; mirror for the right 4
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      const on = (bytes[2 + y] >> x) & 1
      if (!on) continue
      const l = x * cell
      const r = size - (x + 1) * cell
      rects += `<rect x="${l}" y="${y * cell}" width="${cell}" height="${cell}"/>`
      if (x !== 3) rects += `<rect x="${r}" y="${y * cell}" width="${cell}" height="${cell}"/>`
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="hsl(${hue} ${sat}% ${light}%)"/>` +
    `<g fill="hsl(${hue} ${sat}% 16%)">${rects}</g></svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

export function identiconHue(address: string): number {
  return Math.round(addressBytes(address)[0] * 1.41)
}
