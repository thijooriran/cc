// Two-note chime for incoming traffic. Generated with WebAudio — no asset,
// ~0.35s, quiet enough to not wear out its welcome. The AudioContext is
// created lazily and resumed on every call so autoplay policies are covered
// once the user has interacted with the page (the Enter button counts).
let ctx: AudioContext | null = null

export function playMessageSound(): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4)
    gain.connect(ctx.destination)
    for (const [freq, at, dur] of [
      [587.33, 0, 0.14],
      [880, 0.11, 0.24],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t0 + at)
      osc.connect(gain)
      osc.start(t0 + at)
      osc.stop(t0 + at + dur)
    }
  } catch {
    /* no audio device / policy block — silence is on brand anyway */
  }
}
