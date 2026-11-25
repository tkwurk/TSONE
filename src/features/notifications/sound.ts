/**
 * In-app chime for kitchen requests that arrive while TSONE is open.
 *
 * System notifications can't carry a custom sound (no browser supports it);
 * they use the device's notification sound. Inside the app we can play our
 * own: two short tones made with Web Audio (no audio file to download).
 * Browsers only allow audio after the user has interacted with the page, so
 * the audio context is unlocked on the first tap/keypress.
 */
const KEY = 'ts4.notify.sound'

let ctx: AudioContext | null = null

export function soundOn(): boolean {
  return localStorage.getItem(KEY) !== '0'
}

export function setSoundOn(on: boolean): void {
  if (on) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, '0')
}

function audio(): AudioContext | null {
  if (ctx) return ctx
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  ctx = new AC()
  return ctx
}

/** Unlock audio on the first user gesture (autoplay rules). Returns a cleanup. */
export function primeSound(): () => void {
  const unlock = () => {
    const a = audio()
    if (a?.state === 'suspended') a.resume().catch(() => {})
    cleanup()
  }
  const cleanup = () => {
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
  return cleanup
}

/** Two rising tones (~0.6 s) plus a short vibration where supported. */
export function playChime(): void {
  if (!soundOn()) return
  try {
    navigator.vibrate?.([200, 100, 200])
  } catch {
    /* not allowed yet */
  }
  const a = audio()
  if (!a) return
  if (a.state === 'suspended') a.resume().catch(() => {})
  const now = a.currentTime
  ;[
    { f: 880, at: 0 },
    { f: 1320, at: 0.22 },
  ].forEach(({ f, at }) => {
    const osc = a.createOscillator()
    const gain = a.createGain()
    osc.type = 'sine'
    osc.frequency.value = f
    gain.gain.setValueAtTime(0.0001, now + at)
    gain.gain.exponentialRampToValueAtTime(0.35, now + at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35)
    osc.connect(gain).connect(a.destination)
    osc.start(now + at)
    osc.stop(now + at + 0.4)
  })
}
