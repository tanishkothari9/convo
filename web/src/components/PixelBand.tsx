import { useEffect, useRef } from 'react'

/**
 * A thin strip of the market, for the foot of the page.
 *
 * The hero and the closing panel both show the street; this is the same street
 * seen from further off, cropped to its rooftops. It is a separate component
 * rather than a mode of the big one because a band eighty pixels tall wants a
 * different composition, not the same composition squeezed — the canopy and
 * the sky have nowhere to go, so they are simply not in it.
 *
 * Static: nothing on it moves. The page has two animated canvases already, and
 * a third at the very bottom would be motion nobody asked for in the place
 * people are least looking.
 */

/** CSS pixels per scene pixel — the same unit the rest of the art uses. */
const PIXEL = 4
const STEP = 8

const P = {
  sky0: '#7fd0f7',
  sky1: '#a5e0f9',
  haze: '#cdeefb',

  far: '#3f6b5a',
  mid: '#2f5a49',

  stall: '#e8dcc4',
  stallShade: '#c2b394',
  stallDark: '#8d8068',

  rust: '#c25539',
  gold: '#e0a92c',
  green: '#2f8f6a',
  maroon: '#9c3a56',
  indigo: '#3f5bab',
  teal: '#2fa39a',

  grassLit: '#679c48',
  grassSun: '#84b747',
} as const

const AWNING = [P.rust, P.gold, P.green, P.maroon, P.indigo, P.teal]
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function paint(canvas: HTMLCanvasElement, w: number, h: number) {
  const c = canvas.getContext('2d')
  if (!c) return
  canvas.width = w
  canvas.height = h
  c.imageSmoothingEnabled = false

  const random = rng(4711)
  const ground = h - Math.max(2, Math.round(h * 0.14))

  // Sky: two bands with a dithered seam, the same way the big scene does it.
  const seam = Math.max(2, Math.round(h * 0.28))
  c.fillStyle = P.haze
  c.fillRect(0, 0, w, Math.max(0, ground - seam * 2))
  c.fillStyle = P.sky1
  c.fillRect(0, Math.max(0, ground - seam * 2), w, seam)
  for (let y = Math.max(0, ground - seam); y < ground; y += 1) {
    const t = (y - (ground - seam)) / seam
    for (let x = 0; x < w; x += 1) {
      c.fillStyle = t > BAYER[(y % 4) * 4 + (x % 4)]! / 16 ? P.sky0 : P.sky1
      c.fillRect(x, y, 1, 1)
    }
  }

  // Ground.
  c.fillStyle = P.grassLit
  c.fillRect(0, ground, w, h - ground)
  c.fillStyle = P.grassSun
  c.fillRect(0, ground + Math.max(1, Math.round((h - ground) * 0.5)), w, h - ground)

  // A distant treeline, so the stalls have something to stand against.
  for (let tx = -4; tx < w + 6; ) {
    const tr = Math.max(2, Math.round(h * (0.1 + random() * 0.14)))
    c.fillStyle = random() > 0.5 ? P.far : P.mid
    for (let dy = -tr; dy <= tr; dy += 1) {
      const span = Math.floor(Math.sqrt(Math.max(0, tr * tr - dy * dy)))
      c.fillRect(tx - span, ground - tr + dy + Math.round(tr * 0.5), span * 2 + 1, 1)
    }
    tx += Math.max(3, tr)
  }

  // The stalls: awning, body, a bolt of cloth. Small enough that three strokes
  // is the whole vocabulary.
  const sMin = Math.max(6, Math.round(w * 0.035))
  const sMax = Math.max(sMin + 3, Math.round(w * 0.06))
  for (let sx = -4; sx < w + 6; ) {
    const sw = sMin + Math.floor(random() * (sMax - sMin))
    const sh = Math.max(4, Math.round((ground - 2) * (0.42 + random() * 0.3)))
    const top = ground - sh
    const ah = Math.max(2, Math.round(sh * 0.26))

    c.fillStyle = P.stallShade
    c.fillRect(sx, top + ah, sw, ground - top - ah)
    c.fillStyle = P.stall
    c.fillRect(sx + 1, top + ah, sw - 2, Math.max(1, Math.round((ground - top - ah) * 0.5)))
    c.fillStyle = P.stallDark
    c.fillRect(sx, ground - 1, sw, 1)

    const awning = AWNING[Math.floor(random() * AWNING.length)]!
    for (let i = 0; i < ah; i += 1) {
      c.fillStyle = i % 2 === 0 ? awning : P.stall
      c.fillRect(sx - 1, top + i, sw + 2, 1)
    }

    if (sw > 7) {
      c.fillStyle = AWNING[Math.floor(random() * AWNING.length)]!
      c.fillRect(sx + 2, top + ah, Math.max(1, Math.round(sw * 0.16)), Math.round(sh * 0.4))
    }
    sx += sw + Math.max(1, Math.round(w * 0.008))
  }
}

export function PixelBand() {
  const wrap = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = wrap.current
    const canvas = ref.current
    if (!host || !canvas) return

    let last = ''
    const layout = () => {
      const rect = host.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const snap = (v: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(hi, Math.round(v / PIXEL / STEP) * STEP))
      const w = snap(rect.width, 80, 520)
      const h = snap(rect.height, 12, 60)
      const key = `${w}x${h}`
      if (key === last) return
      last = key
      paint(canvas, w, h)
    }

    layout()
    const observer = new ResizeObserver(layout)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="pixel-band" ref={wrap} aria-hidden="true">
      <canvas ref={ref} className="pixel-band-canvas" />
    </div>
  )
}
