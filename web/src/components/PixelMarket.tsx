import { useEffect, useRef } from 'react'

/**
 * The hero field: a market street at dusk, drawn as pixel art.
 *
 * Convo is a row of independent shops under one roof, so the hero is a row of
 * independent shops under one string of lights. It says marketplace before the
 * headline does, which is the only job a hero image has.
 *
 * It is a live canvas rather than a video file. The look is identical — a low
 * resolution scaled up with `image-rendering: pixelated`, so every pixel stays
 * a hard square — but the whole scene costs a few kilobytes of code instead of
 * a multi-megabyte webm, needs no poster frame, and can be re-lit by editing a
 * palette rather than re-rendering an asset.
 *
 * What is fixed here is the size of a pixel, not the size of the grid. A fixed
 * grid gets the worst of both ends: stretched into an egg where it cannot match
 * the frame's aspect, and barely pixelated at all on a phone, where 320 scene
 * pixels across a 375px screen is a scale of one. Fixing the pixel at four CSS
 * px instead means the grid is whatever shape the hero is, the picture is never
 * stretched or cropped, and a pixel is the same size on every device.
 *
 * The scene is deterministic: a seeded generator lays out the shops, the stars
 * and the bulbs, so the street is the same street on every load and only the
 * light moves.
 */

/** CSS pixels per scene pixel. The one thing that does not change. */
const PIXEL = 4
/** Grid dimensions snap to this, so a few pixels of reflow rebuild nothing. */
const STEP = 8
const MIN_W = 88
const MAX_W = 420
const MIN_H = 72
const MAX_H = 400

/*
 * A dusk palette, deliberately small.
 *
 * Pixel art reads as pixel art because of what it leaves out: a limited set of
 * colours, no anti-aliasing, and gradients made by dithering two of them
 * against each other rather than by interpolating.
 */
const P = {
  sky0: '#0a0e1b',
  sky1: '#111729',
  sky2: '#1a2238',
  sky3: '#26314c',
  sky4: '#3a4666',
  haze: '#5f6480',
  ember: '#8a6a72',
  star: '#c8d2ec',

  far: '#101625',
  mid: '#161d31',

  shop: '#1f2740',
  shopEdge: '#2a3350',
  sill: '#39435f',

  street: '#090d18',
  streetEdge: '#131a2b',

  glow: '#f6c98a',
  glowMid: '#dda062',
  glowDim: '#a1703f',
  bulbOn: '#ffe9b8',
  bulbOff: '#584f42',
  wire: '#242b41',

  moonLit: '#fffaea',
  moonMid: '#f0dcae',
  moonDark: '#d8c295',

  // Awnings and hanging cloth: the goods on the shelf, in the colours the
  // catalogue is actually full of.
  rust: '#a8452f',
  gold: '#c39a24',
  green: '#1b6b54',
  teal: '#23886a',
  maroon: '#7a2f4a',
  indigo: '#33487e',
} as const

const CLOTH = [P.rust, P.gold, P.green, P.maroon, P.teal, P.indigo]
const AWNING = [P.rust, P.green, P.maroon, P.gold, P.teal, P.indigo]

/** A 4×4 Bayer matrix, for dithering one colour into another. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Deterministic, so the street is the same street on every load. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Shop {
  x: number
  w: number
  top: number
  awning: string
  cloths: { x: number; w: number; len: number; colour: string }[]
  windows: { x: number; y: number; w: number; h: number }[]
  /** Each shop's light wavers on its own clock, so the street is never uniform. */
  phase: number
  flicker: number
}

interface Lantern {
  x: number
  y: number
  speed: number
  drift: number
  phase: number
  size: number
}

interface Scene {
  w: number
  h: number
  ground: number
  shops: Shop[]
  bulbs: { x: number; y: number; phase: number }[]
  motes: { x: number; y: number; speed: number; drift: number; phase: number }[]
  stars: { x: number; y: number; phase: number; bright: boolean }[]
  lanterns: Lantern[]
  skyTop: number
  backdrop: HTMLCanvasElement
}

function buildScene(w: number, h: number): Scene {
  const random = rng(20260905)

  /*
   * Laid out in proportions, and in proportion to the *width*.
   *
   * The street is the subject, so it gets a fixed share of the floor of the
   * picture and the sky takes whatever is left. Shop sizes are derived from
   * the grid width rather than fixed, so a shop is a shop at any scale: on a
   * phone the street is eight coarse shops across, on a desktop it is a dozen
   * finer ones, and neither is a row of towers.
   */
  const ground = h - Math.min(Math.round(h * 0.12), Math.round(w * 0.14))
  const shopMin = Math.max(14, Math.round(w * 0.16))
  const shopMax = Math.max(shopMin + 6, Math.round(w * 0.24))
  const roofMax = Math.max(Math.round(h * 0.16), ground - shopMax)
  const roofMin = Math.max(roofMax + 4, ground - shopMin)

  // ── Shops ─────────────────────────────────────────────────────────────────
  const shops: Shop[] = []
  const wMin = Math.max(9, Math.round(w * 0.09))
  const wMax = Math.max(wMin + 4, Math.round(w * 0.16))
  const awningH = Math.max(4, Math.round(w * 0.016))
  let x = -Math.round(wMin / 2)
  while (x < w + 8) {
    const sw = wMin + Math.floor(random() * (wMax - wMin))
    const top = roofMax + Math.floor(random() * Math.max(1, roofMin - roofMax))
    const bodyTop = top + awningH + 4

    /*
     * The shop front, divided top to bottom.
     *
     * Cloth hangs from the awning across the top third, windows sit in the
     * middle, the door takes the bottom. An earlier version let the windows
     * run the full height of the body, which turned every shop into a pair of
     * floor-to-ceiling light boxes and buried the goods hanging in front of
     * them — the one part of this scene that is actually about what is for
     * sale.
     */
    const bodyH = ground - bodyTop
    const clothZone = Math.max(2, Math.round(bodyH * 0.36))

    const windows: Shop['windows'] = []
    const count = sw > wMax * 0.8 ? 3 : 2
    const pad = Math.max(2, Math.round(sw * 0.1))
    const cellW = (sw - pad * 2) / count
    const winH = Math.max(2, Math.round(bodyH * 0.28))
    for (let i = 0; i < count; i += 1) {
      const ww = Math.max(2, Math.floor(cellW) - 2)
      windows.push({
        x: x + pad + Math.floor(i * cellW),
        y: bodyTop + clothZone,
        w: ww,
        h: winH,
      })
    }

    // Bolts of cloth hung under the awning: the reason to look at the shop.
    const cloths: Shop['cloths'] = []
    const bolts = 2 + Math.floor(random() * 3)
    for (let i = 0; i < bolts; i += 1) {
      const cw = Math.max(1, Math.round(sw * 0.1))
      cloths.push({
        x: x + 2 + Math.floor(random() * Math.max(1, sw - cw - 4)),
        w: cw,
        len: Math.max(2, Math.round(clothZone * (0.55 + random() * 0.45))),
        colour: CLOTH[Math.floor(random() * CLOTH.length)]!,
      })
    }

    shops.push({
      x,
      w: sw,
      top,
      awning: AWNING[Math.floor(random() * AWNING.length)]!,
      cloths,
      windows,
      phase: random() * Math.PI * 2,
      flicker: 0.4 + random() * 0.6,
    })
    x += sw + 1
  }

  // ── Festoon lights ────────────────────────────────────────────────────────
  // One sagging string across the street, hung above the tallest shops so it
  // reads as spanning them rather than sitting on them.
  const bulbs: Scene['bulbs'] = []
  const wireTop = Math.max(8, roofMax - Math.round(w * 0.05))
  const spacing = Math.max(3, Math.round(w * 0.016))
  const sag = Math.max(3, Math.round(w * 0.025))
  for (let seg = 0; seg < 5; seg += 1) {
    const x0 = (w / 5) * seg
    const x1 = (w / 5) * (seg + 1)
    const y0 = wireTop + (seg % 2) * 3
    const y1 = wireTop + ((seg + 1) % 2) * 3
    for (let px = x0; px < x1; px += spacing) {
      const t = (px - x0) / (x1 - x0)
      bulbs.push({
        x: Math.round(px),
        y: Math.round(y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * sag),
        phase: random() * Math.PI * 2,
      })
    }
  }

  // Embers rising off the street. Confined to the lower half, because a mote
  // drifting across a headline is not atmosphere, it is a smudge.
  const motes: Scene['motes'] = []
  for (let i = 0; i < Math.round(w * 0.1); i += 1) {
    motes.push({
      x: random() * w,
      y: ground - random() * (ground - roofMax) * 0.8,
      speed: 0.04 + random() * 0.12,
      drift: 0.2 + random() * 0.7,
      phase: random() * Math.PI * 2,
    })
  }

  /*
   * Stars, thinning downward.
   *
   * Scattered evenly they read as dust on the lens, and the densest part of
   * the sky is exactly where the headline sits. Weighting them toward the top
   * of the frame puts them where a sky actually looks like a sky and keeps
   * them off the text.
   */
  const stars: Scene['stars'] = []
  const skyDepth = Math.max(8, wireTop - 4)
  for (let i = 0; i < Math.round(skyDepth * 0.3); i += 1) {
    const bias = random() * random() // clusters toward zero
    stars.push({
      x: Math.floor(random() * w),
      y: Math.floor(bias * skyDepth),
      phase: random() * Math.PI * 2,
      bright: random() > 0.84,
    })
  }

  /*
   * Sky lanterns.
   *
   * A tall hero leaves a lot of sky, and an empty sky is just a dark rectangle
   * behind a headline. Stars alone do not fill it — they read as grain. These
   * do: warm, slow, drifting up and across, and the right thing to be floating
   * over a night market rather than a generic particle.
   */
  const lanterns: Lantern[] = []
  const lanternField = Math.max(30, roofMax - 6)
  for (let i = 0; i < Math.max(6, Math.round(lanternField / 22)); i += 1) {
    lanterns.push({
      x: random() * w,
      y: random() * lanternField,
      speed: 0.5 + random() * 0.9,
      drift: 0.6 + random() * 1.4,
      phase: random() * Math.PI * 2,
      // One pixel on a coarse grid, two on a fine one: a lantern should read
      // as a distant light, and at four CSS pixels a side it already does.
      size: w > 200 && random() > 0.62 ? 2 : 1,
    })
  }

  return {
    w,
    h,
    ground,
    shops,
    bulbs,
    motes,
    stars,
    lanterns,
    skyTop: lanternField,
    backdrop: paintStatic(w, h, ground, roofMax, awningH, shops),
  }
}

/**
 * Everything that never moves, drawn once into an offscreen canvas.
 *
 * The sky, the skyline and the buildings are blitted whole on each frame; the
 * per-frame work is the hundred or so small rectangles that actually change.
 * That is what keeps a full-bleed animated background off the profiler.
 */
function paintStatic(
  w: number,
  h: number,
  ground: number,
  roofMax: number,
  awningH: number,
  shops: Shop[],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')!
  c.imageSmoothingEnabled = false

  const horizon = ground - Math.round((ground - roofMax) * 0.22)

  // ── Sky ───────────────────────────────────────────────────────────────────
  // Flat bands with a short dithered seam between them, rather than a dither
  // across the whole gradient. Dithering everything turns the sky into a
  // visible grid; dithering only the joins is how the technique is meant to be
  // used, and leaves clean fields of colour to look at. The seam is capped, so
  // the cost of this does not grow with the height of the frame.
  const ramp = [P.sky0, P.sky1, P.sky2, P.sky3, P.sky4, P.haze, P.ember]
  const stops = ramp.map((_, i) => Math.round((horizon * i) / (ramp.length - 1)))
  for (let i = 0; i < ramp.length - 1; i += 1) {
    const from = ramp[i]!
    const to = ramp[i + 1]!
    const y0 = stops[i]!
    const y1 = stops[i + 1]!
    const seam = Math.min(14, Math.max(3, Math.round((y1 - y0) * 0.42)))
    c.fillStyle = from
    c.fillRect(0, y0, w, y1 - y0 - seam)
    for (let y = Math.max(y0, y1 - seam); y < y1; y += 1) {
      const t = (y - (y1 - seam)) / seam
      for (let x = 0; x < w; x += 1) {
        const threshold = BAYER[(y % 4) * 4 + (x % 4)]! / 16
        c.fillStyle = t > threshold ? to : from
        c.fillRect(x, y, 1, 1)
      }
    }
  }

  // ── Moon ──────────────────────────────────────────────────────────────────
  // One focal point in a large sky, set right of centre so it sits behind the
  // demo panel rather than behind the headline.
  // High and to the right. Placed against the top of the frame rather than a
  // fraction of the horizon: on a phone the horizon is a long way down, and a
  // moon a fifth of the way to it lands squarely on the second line of the
  // headline.
  const moonR = Math.max(4, Math.round(w * 0.034))
  const moonX = Math.round(w * 0.78)
  const moonY = Math.max(moonR + 3, Math.round(h * 0.075))
  for (let dy = -moonR; dy <= moonR; dy += 1) {
    for (let dx = -moonR; dx <= moonR; dx += 1) {
      if (Math.sqrt(dx * dx + dy * dy) > moonR) continue
      /*
       * Lit from the upper left, with a dithered terminator rather than a hard
       * one. An earlier version combined the shade test and the dither test
       * with an `or`, which drew a visible diagonal seam straight across the
       * disc — the dither has to live inside the transition band, not across
       * the whole face.
       */
      const shade = (dx + dy) / (moonR * 2) + 0.5
      const threshold = BAYER[((moonY + dy) % 4) * 4 + ((moonX + dx) % 4)]! / 16
      c.fillStyle =
        shade < 0.56
          ? P.moonLit
          : shade < 0.8
            ? threshold > (shade - 0.56) / 0.24
              ? P.moonLit
              : P.moonMid
            : P.moonDark
      c.fillRect(moonX + dx, moonY + dy, 1, 1)
    }
  }
  // Craters, kept to the lit face where they read as detail rather than dirt.
  if (moonR >= 7) {
    c.fillStyle = P.moonMid
    c.fillRect(moonX - Math.round(moonR * 0.45), moonY - Math.round(moonR * 0.36), 3, 2)
    c.fillRect(moonX + Math.round(moonR * 0.1), moonY - Math.round(moonR * 0.55), 2, 2)
    c.fillRect(moonX - Math.round(moonR * 0.18), moonY + Math.round(moonR * 0.1), 2, 2)
  }
  // A soft halo, so the moon lights the sky around it rather than sitting on it.
  c.globalAlpha = 0.13
  c.fillStyle = P.moonMid
  const halo = Math.max(2, Math.round(moonR * 0.36))
  for (let dy = -moonR - halo; dy <= moonR + halo; dy += 1) {
    for (let dx = -moonR - halo; dx <= moonR + halo; dx += 1) {
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= moonR || d > moonR + halo) continue
      c.fillRect(moonX + dx, moonY + dy, 1, 1)
    }
  }
  c.globalAlpha = 1

  // ── Distant roofline ──────────────────────────────────────────────────────
  // Two silhouetted layers, the further one lighter, which is the cheapest
  // depth cue pixel art has.
  const far = rng(77)
  const farUnit = Math.max(5, Math.round(w * 0.03))
  let fx = -6
  while (fx < w + 8) {
    const fw = farUnit + Math.floor(far() * farUnit * 2)
    const fh = Math.round(farUnit * (0.8 + far() * 1.8))
    c.fillStyle = P.far
    c.fillRect(fx, horizon - fh, fw, fh + 6)
    // A lit window or two in the far city, so it is a city and not a wall.
    if (far() > 0.55 && fw > 6) {
      c.fillStyle = P.glowDim
      c.fillRect(fx + 2 + Math.floor(far() * (fw - 4)), horizon - fh + 2 + Math.floor(far() * 5), 1, 1)
    }
    fx += fw + Math.floor(far() * 4)
  }
  let mx = -10
  while (mx < w + 8) {
    const mw = farUnit + Math.floor(far() * farUnit * 2.2)
    const mh = Math.round(farUnit * (0.6 + far() * 1.2))
    c.fillStyle = P.mid
    c.fillRect(mx, horizon - mh + 6, mw, mh + 12)
    mx += mw + Math.floor(far() * 5)
  }

  // ── Street ────────────────────────────────────────────────────────────────
  c.fillStyle = P.street
  c.fillRect(0, ground, w, h - ground)
  c.fillStyle = P.streetEdge
  c.fillRect(0, ground, w, 1)

  // ── Shops ─────────────────────────────────────────────────────────────────
  for (const shop of shops) {
    const bodyTop = shop.top + awningH + 4

    c.fillStyle = P.shop
    c.fillRect(shop.x, bodyTop, shop.w, ground - bodyTop)
    // A lit left edge, so each shop separates from its neighbour.
    c.fillStyle = P.shopEdge
    c.fillRect(shop.x, bodyTop, 1, ground - bodyTop)

    for (const cloth of shop.cloths) {
      c.fillStyle = cloth.colour
      c.fillRect(cloth.x, bodyTop, cloth.w, cloth.len)
      // A darker last row reads as the weight of the hem.
      c.fillStyle = P.street
      c.fillRect(cloth.x, bodyTop + cloth.len - 1, cloth.w, 1)
    }

    // Awning: a striped canopy jutting past the shop on both sides.
    const aw = shop.w + 4
    for (let i = 0; i < awningH; i += 1) {
      c.fillStyle = i % 2 === 0 ? shop.awning : P.sill
      c.fillRect(shop.x - 2, shop.top + 3 + i, aw, 1)
    }
    // Scalloped lower edge, every four across.
    c.fillStyle = shop.awning
    for (let i = 0; i < aw; i += 4) c.fillRect(shop.x - 2 + i, shop.top + 3 + awningH, 2, 1)
    c.fillStyle = P.sill
    c.fillRect(shop.x - 1, shop.top + 1, shop.w + 2, 2)

    // Door.
    const dw = Math.max(2, Math.round(shop.w * 0.2))
    const dh = Math.max(2, Math.round((ground - bodyTop) * 0.26))
    c.fillStyle = P.street
    c.fillRect(shop.x + Math.round(shop.w / 2) - Math.round(dw / 2), ground - dh, dw, dh)
  }

  return canvas
}

export function PixelMarket() {
  const wrap = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const host = wrap.current
    if (!canvas || !host) return
    const c = canvas.getContext('2d')
    if (!c) return

    const still = window.matchMedia('(prefers-reduced-motion: reduce)')
    let scene: Scene | null = null
    let raf = 0
    let last = 0

    function draw(t: number) {
      if (!scene) return
      const ctx = c!
      ctx.drawImage(scene.backdrop, 0, 0)
      const { ground } = scene

      // ── Stars ───────────────────────────────────────────────────────────
      for (const star of scene.stars) {
        const b = Math.sin(t * 0.0011 + star.phase)
        if (b < -0.25) continue
        ctx.fillStyle = star.bright && b > 0.7 ? '#ffffff' : P.star
        ctx.fillRect(star.x, star.y, 1, 1)
      }

      // ── Shop windows ────────────────────────────────────────────────────
      // A warm rectangle with a brighter core and a pool of light on the
      // street beneath. The waver is small: a shop that pulses is on fire.
      for (const shop of scene.shops) {
        const waver = 0.9 + Math.sin(t * 0.0015 + shop.phase) * 0.06 * shop.flicker
        for (const win of shop.windows) {
          ctx.globalAlpha = Math.min(1, waver)
          ctx.fillStyle = P.glowMid
          ctx.fillRect(win.x, win.y, win.w, win.h)
          ctx.fillStyle = P.glow
          ctx.fillRect(win.x + 1, win.y + 1, Math.max(1, win.w - 2), Math.max(1, win.h - 2))
          if (win.w >= 5) {
            // Mullion, so a window reads as a window and not as a swatch.
            ctx.fillStyle = P.shop
            ctx.fillRect(win.x + Math.floor(win.w / 2), win.y, 1, win.h)
          }
        }
        // Light spilling out of the doorway onto the street.
        const dx = shop.x + Math.round(shop.w / 2)
        const spill = Math.max(4, Math.round(shop.w * 0.5))
        ctx.globalAlpha = 0.5 * waver
        ctx.fillStyle = P.glowDim
        ctx.fillRect(dx - Math.round(spill / 2), ground, spill, 2)
        ctx.globalAlpha = 0.22 * waver
        ctx.fillRect(dx - spill, ground + 2, spill * 2, 2)
        ctx.globalAlpha = 1
      }

      // ── Festoon lights ──────────────────────────────────────────────────
      ctx.fillStyle = P.wire
      for (let i = 0; i < scene.bulbs.length - 1; i += 1) {
        const a = scene.bulbs[i]!
        const b = scene.bulbs[i + 1]!
        const steps = Math.max(1, Math.abs(b.x - a.x))
        for (let s = 0; s < steps; s += 1) {
          const u = s / steps
          ctx.fillRect(Math.round(a.x + (b.x - a.x) * u), Math.round(a.y + (b.y - a.y) * u), 1, 1)
        }
      }
      for (const bulb of scene.bulbs) {
        const lit = Math.sin(t * 0.002 + bulb.phase) * 0.5 + 0.5
        ctx.fillStyle = lit > 0.35 ? P.bulbOn : P.bulbOff
        ctx.fillRect(bulb.x, bulb.y + 1, 1, 1)
        if (lit > 0.82) {
          ctx.globalAlpha = 0.3
          ctx.fillStyle = P.glow
          ctx.fillRect(bulb.x - 1, bulb.y, 3, 3)
          ctx.globalAlpha = 1
        }
      }

      // ── Sky lanterns ────────────────────────────────────────────────────
      // Drawn before the embers so a lantern never sits on top of a spark
      // rising off the street, which would read as the wrong depth.
      for (const lamp of scene.lanterns) {
        const span = scene.skyTop + 30
        const travelled = ((t * lamp.speed) / 900) % span
        const y = lamp.y - travelled
        const wrapped = y < -8 ? y + span : y
        const x = (lamp.x + Math.sin(t * 0.00035 + lamp.phase) * lamp.drift * 6 + scene.w) % scene.w
        const px = Math.round(x)
        const py = Math.round(wrapped)
        const b = 0.7 + Math.sin(t * 0.0013 + lamp.phase) * 0.3
        const sz = lamp.size

        ctx.globalAlpha = 0.12 * b
        ctx.fillStyle = P.glow
        ctx.fillRect(px - 1, py - 1, sz + 2, sz + 3)
        ctx.globalAlpha = Math.min(1, 0.7 * b)
        ctx.fillRect(px, py, sz, sz + 1)
        ctx.globalAlpha = 0.45 * b
        ctx.fillStyle = P.glowMid
        ctx.fillRect(px, py + sz + 1, sz, 1)
        ctx.globalAlpha = 1
      }

      // ── Embers ──────────────────────────────────────────────────────────
      // Slow, upward, never quite straight — the one thing on screen genuinely
      // drifting rather than blinking.
      const rise = Math.max(20, ground * 0.5)
      for (const mote of scene.motes) {
        const travelled = ((t * mote.speed) / 16) % rise
        const y = mote.y - travelled
        const x = mote.x + Math.sin(t * 0.0006 + mote.phase) * mote.drift * 3
        // Fade out as it climbs, so it dies rather than vanishing at an edge.
        const life = 1 - travelled / rise
        const b = Math.sin(t * 0.0017 + mote.phase) * 0.5 + 0.5
        ctx.globalAlpha = (0.18 + b * 0.4) * life
        ctx.fillStyle = P.glow
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1)
        ctx.globalAlpha = 1
      }
    }

    function loop(now: number) {
      raf = requestAnimationFrame(loop)
      if (document.hidden) return
      // Pixel art is traditionally animated on twos or threes, and a hero
      // background has no business asking for sixty frames a second.
      if (now - last < 1000 / 14) return
      last = now
      draw(now)
    }

    function start() {
      cancelAnimationFrame(raf)
      if (still.matches) draw(performance.now())
      else raf = requestAnimationFrame(loop)
    }

    function layout() {
      const rect = host!.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      /*
       * The grid is the hero's own shape at a fixed pixel size, snapped to a
       * step so a few pixels of reflow rebuild nothing — the hero's height
       * moves as the demo panel beside the copy plays through its script, and
       * rebuilding a whole scene for four pixels is both wasteful and visible.
       */
      const snap = (v: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(hi, Math.round(v / PIXEL / STEP) * STEP))
      const w = snap(rect.width, MIN_W, MAX_W)
      const h = snap(rect.height, MIN_H, MAX_H)
      if (scene && scene.w === w && scene.h === h) return

      canvas!.width = w
      canvas!.height = h
      c!.imageSmoothingEnabled = false
      scene = buildScene(w, h)
      /*
       * Paint one frame synchronously before starting the loop.
       *
       * Setting canvas.width clears it, and the loop's first paint is a frame
       * away — which is fine until the frame is not. A backgrounded tab
       * throttles requestAnimationFrame to nothing, so a resize while the page
       * is not being looked at would otherwise leave the hero a flat black
       * rectangle for as long as it stayed that way.
       */
      draw(performance.now())
      start()
    }

    layout()
    const observer = new ResizeObserver(layout)
    observer.observe(host)
    still.addEventListener('change', start)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      still.removeEventListener('change', start)
    }
  }, [])

  return (
    <div className="pixel-field" ref={wrap} aria-hidden="true">
      <canvas ref={ref} className="pixel-canvas" />
      {/* Contrast insurance: the headline sits over sky, but a bright shop
          window drifting behind a descender is still a bright shop window. */}
      <div className="pixel-vignette" />
    </div>
  )
}
