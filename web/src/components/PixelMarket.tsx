import { useEffect, useRef } from 'react'

/**
 * The hero field: a market under trees on a bright afternoon, drawn as pixel art.
 *
 * Convo is a row of independent shops under one roof, so the hero is a row of
 * independent stalls under one canopy. It says marketplace before the headline
 * does, which is the only job a hero image has.
 *
 * It is a live canvas rather than a video file. The look is identical — a low
 * resolution scaled up with `image-rendering: pixelated`, so every pixel stays
 * a hard square — but the whole scene costs a few kilobytes of code instead of
 * a multi-megabyte webm, needs no poster frame, and can be re-lit by editing a
 * palette rather than re-rendering an asset.
 *
 * What is fixed here is the size of a pixel, not the size of the grid. A fixed
 * grid gets the worst of both ends: stretched where it cannot match the frame's
 * aspect, and barely pixelated at all on a phone, where 320 scene pixels across
 * a 375px screen is a scale of one. Fixing the pixel instead means the grid is
 * whatever shape the hero is, the picture is never stretched or cropped, and a
 * pixel is the same size on every device.
 *
 * The scene is deterministic: a seeded generator lays out the canopy, the
 * stalls and the flowers, so it is the same picture on every load and only the
 * weather moves.
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
 * Broad daylight, and a small palette.
 *
 * Pixel art reads as pixel art because of what it leaves out: a limited set of
 * colours, no anti-aliasing, and gradients made by dithering two of them
 * against each other rather than by interpolating. Foliage gets six greens
 * because foliage is most of the picture; everything else gets two or three.
 */
const P = {
  sky0: '#1a8ae7',
  sky1: '#1e9ef1',
  sky2: '#27a6f7',
  sky3: '#46b8f8',
  sky4: '#7fd0f7',
  haze: '#b4e8f4',

  cloudLit: '#ffffff',
  cloud: '#dcf2fb',
  cloudMid: '#b4e8f4',
  cloudLow: '#8ec9e4',

  leafDark: '#16302b',
  leafDeep: '#1a3a34',
  leaf: '#284738',
  leafMid: '#355939',
  leafLit: '#467656',
  leafSun: '#5f8f52',

  barkDark: '#4a3f30',
  bark: '#6b5c46',
  barkLit: '#8f7c5b',

  grassDark: '#31573b',
  grass: '#3f6b3f',
  grassMid: '#4f8244',
  grassLit: '#679c48',
  grassSun: '#84b747',

  // The stalls: canvas in the shade, awnings in the colours the catalogue is
  // actually full of.
  stall: '#e8dcc4',
  stallShade: '#c2b394',
  stallDark: '#8d8068',
  rust: '#c25539',
  gold: '#e0a92c',
  green: '#2f8f6a',
  maroon: '#9c3a56',
  indigo: '#3f5bab',
  teal: '#2fa39a',

  flowerA: '#e05252',
  flowerB: '#f6efd2',
  flowerC: '#f0c749',
} as const

const AWNING = [P.rust, P.gold, P.green, P.maroon, P.indigo, P.teal]

/** A 4×4 Bayer matrix, for dithering one colour into another. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/** Deterministic, so it is the same picture on every load. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

type Ctx = CanvasRenderingContext2D

/** A filled disc of hard pixels. The unit foliage and cloud are built from. */
function blob(c: Ctx, cx: number, cy: number, r: number, colour: string) {
  c.fillStyle = colour
  const ri = Math.max(1, Math.round(r))
  for (let dy = -ri; dy <= ri; dy += 1) {
    const span = Math.floor(Math.sqrt(Math.max(0, ri * ri - dy * dy)))
    c.fillRect(Math.round(cx) - span, Math.round(cy) + dy, span * 2 + 1, 1)
  }
}

/** A disc with a ragged dithered rim, so foliage does not read as a circle. */
function roughBlob(c: Ctx, cx: number, cy: number, r: number, colour: string) {
  c.fillStyle = colour
  const ri = Math.max(1, Math.round(r))
  const ox = Math.round(cx)
  const oy = Math.round(cy)
  for (let dy = -ri; dy <= ri; dy += 1) {
    for (let dx = -ri; dx <= ri; dx += 1) {
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > ri) continue
      // The outermost ring is dithered away, which is what breaks the outline.
      if (d > ri - 1.2) {
        const bx = ((ox + dx) % 4 + 4) % 4
        const by = ((oy + dy) % 4 + 4) % 4
        if (BAYER[by * 4 + bx]! / 16 > 0.42) continue
      }
      c.fillRect(ox + dx, oy + dy, 1, 1)
    }
  }
}

interface Bird {
  x: number
  y: number
  speed: number
  phase: number
}

interface Scene {
  w: number
  h: number
  horizon: number
  canopyDepth: number
  backdrop: HTMLCanvasElement
  /** The canopy alone, so it can be laid back over the drifting sky. */
  canopy: HTMLCanvasElement
  /** Twice the grid width, so it can be blitted end to end while it drifts. */
  clouds: HTMLCanvasElement
  birds: Bird[]
  glints: { x: number; y: number; phase: number; colour: string }[]
  shafts: { x: number; w: number; phase: number }[]
}

function buildScene(w: number, h: number): Scene {
  const random = rng(20260905)
  const horizon = Math.round(h * 0.62)
  const canopyDepth = Math.max(10, Math.round(h * 0.26))

  const painted = paintStatic(w, h, horizon, canopyDepth)

  // ── Clouds, on their own strip so they can drift ──────────────────────────
  const clouds = document.createElement('canvas')
  clouds.width = w * 2
  clouds.height = Math.max(8, horizon)
  const cc = clouds.getContext('2d')!
  cc.imageSmoothingEnabled = false
  const cloudCount = Math.max(5, Math.round(w / 22))
  for (let i = 0; i < cloudCount; i += 1) {
    const cx = random() * clouds.width
    const scale = (0.6 + random() * 1.0) * Math.max(6, w * 0.07)
    /*
     * Kept to the top third of the sky.
     *
     * A cumulus drifting through the middle of the headline is a cumulus in
     * the wrong place — the scrim can hold white text against sky, but not
     * against a white cloud. Up here they read as weather and stay out of the
     * way of the words.
     */
    const cy = scale * 0.7 + random() * Math.max(4, clouds.height * 0.34)
    const lobes = 3 + Math.floor(random() * 3)
    const base = cy + scale * 0.5

    // A cumulus is three or four discs on a line with a flat base, so it is
    // drawn as one mass and then squared off underneath.
    const lobeAt = (j: number) => {
      const t = j / (lobes - 1) - 0.5
      return {
        x: cx + t * scale * 2,
        y: cy + Math.abs(t) * scale * 0.34,
        r: scale * (0.55 + Math.cos(t * 2.4) * 0.42),
      }
    }
    for (let j = 0; j < lobes; j += 1) {
      const l = lobeAt(j)
      roughBlob(cc, l.x, l.y, l.r, P.cloudMid)
    }
    cc.globalCompositeOperation = 'destination-out'
    cc.fillStyle = '#000'
    cc.fillRect(Math.round(cx - scale * 2.6), Math.round(base), Math.round(scale * 5.2), clouds.height)
    cc.globalCompositeOperation = 'source-over'
    cc.fillStyle = P.cloudLow
    cc.fillRect(Math.round(cx - scale * 1.4), Math.round(base) - 1, Math.round(scale * 2.8), 1)
    for (let j = 0; j < lobes; j += 1) {
      const l = lobeAt(j)
      roughBlob(cc, l.x, l.y - l.r * 0.32, l.r * 0.6, P.cloud)
      roughBlob(cc, l.x - l.r * 0.22, l.y - l.r * 0.48, l.r * 0.28, P.cloudLit)
    }
  }

  const birds: Bird[] = []
  for (let i = 0; i < 3; i += 1) {
    birds.push({
      x: random() * w,
      y: 6 + random() * Math.max(8, canopyDepth * 0.8),
      speed: 1.4 + random() * 1.6,
      phase: random() * Math.PI * 2,
    })
  }

  // Flowers and sun on the grass.
  const glints: Scene['glints'] = []
  const flowers = [P.flowerA, P.flowerB, P.flowerC]
  for (let i = 0; i < Math.round(w * 0.18); i += 1) {
    glints.push({
      x: Math.floor(random() * w),
      y: horizon + 3 + Math.floor(random() * Math.max(2, h - horizon - 4)),
      phase: random() * Math.PI * 2,
      colour: flowers[Math.floor(random() * flowers.length)]!,
    })
  }

  const shafts: Scene['shafts'] = []
  for (let i = 0; i < 3; i += 1) {
    shafts.push({
      x: Math.round(w * (0.12 + i * 0.3) + random() * w * 0.06),
      w: Math.max(3, Math.round(w * (0.03 + random() * 0.04))),
      phase: random() * Math.PI * 2,
    })
  }

  return {
    w,
    h,
    horizon,
    canopyDepth,
    backdrop: painted.backdrop,
    canopy: painted.canopy,
    clouds,
    birds,
    glints,
    shafts,
  }
}

/**
 * Everything that never moves, drawn once into offscreen canvases.
 *
 * Two of them: the world, and the canopy on its own. The clouds drift between
 * the two, so the foliage has to be laid back over the sky each frame — and a
 * second bitmap is much cheaper than redrawing a few hundred leaves.
 */
function paintStatic(w: number, h: number, horizon: number, canopyDepth: number) {
  const backdrop = document.createElement('canvas')
  backdrop.width = w
  backdrop.height = h
  const c = backdrop.getContext('2d')!
  c.imageSmoothingEnabled = false

  const random = rng(20260905)

  // ── Sky ───────────────────────────────────────────────────────────────────
  // Flat bands with a short dithered seam between them, rather than a dither
  // across the whole gradient. Dithering everything turns the sky into a
  // visible grid; dithering only the joins is how the technique is meant to be
  // used, and leaves clean fields of colour to look at.
  const band = (ramp: readonly string[], y0: number, y1: number) => {
    const stops = ramp.map((_, i) => Math.round(y0 + ((y1 - y0) * i) / (ramp.length - 1)))
    for (let i = 0; i < ramp.length - 1; i += 1) {
      const from = ramp[i]!
      const to = ramp[i + 1]!
      const a = stops[i]!
      const b = stops[i + 1]!
      const seam = Math.min(14, Math.max(2, Math.round((b - a) * 0.5)))
      c.fillStyle = from
      c.fillRect(0, a, w, Math.max(0, b - a - seam))
      for (let y = Math.max(a, b - seam); y < b; y += 1) {
        const t = (y - (b - seam)) / seam
        for (let x = 0; x < w; x += 1) {
          c.fillStyle = t > BAYER[(y % 4) * 4 + (x % 4)]! / 16 ? to : from
          c.fillRect(x, y, 1, 1)
        }
      }
    }
  }
  band([P.sky0, P.sky1, P.sky2, P.sky3, P.sky4, P.haze], 0, horizon)

  // ── Distant treeline ──────────────────────────────────────────────────────
  // Hazy and low-contrast, so it sits behind everything without competing.
  const tl = rng(313)
  for (let tx = -6; tx < w + 8; ) {
    const tr = Math.max(3, Math.round(w * (0.02 + tl() * 0.032)))
    blob(c, tx, horizon - tr * 0.5, tr, P.leafLit)
    tx += Math.max(3, tr)
  }
  c.fillStyle = P.leafLit
  c.fillRect(0, horizon - 2, w, 3)

  // ── Grass ─────────────────────────────────────────────────────────────────
  // Bands from shadow at the treeline to full sun at the front, each seam
  // dithered so the ground reads as lit rather than as stripes.
  band([P.grassDark, P.grass, P.grassMid, P.grassLit, P.grassSun], horizon, h)
  const gr = rng(881)
  for (let i = 0; i < Math.round(w * 1.6); i += 1) {
    const gx = Math.floor(gr() * w)
    const gy = horizon + 2 + Math.floor(gr() * Math.max(1, h - horizon - 3))
    const depth = (gy - horizon) / Math.max(1, h - horizon)
    c.fillStyle = gr() > 0.5 ? (depth > 0.5 ? P.grassSun : P.grassLit) : P.grassDark
    c.fillRect(gx, gy, 1, 1)
  }

  // ── Stalls ────────────────────────────────────────────────────────────────
  // A row along the treeline, in the shade of the canopy: canvas bodies,
  // striped awnings, bolts of cloth hung out front.
  const sMin = Math.max(10, Math.round(w * 0.1))
  const sMax = Math.max(sMin + 5, Math.round(w * 0.17))
  const stallBase = horizon + Math.round((h - horizon) * 0.32)
  for (let sx = -Math.round(sMin / 2); sx < w + 8; ) {
    const sw = sMin + Math.floor(random() * (sMax - sMin))
    const sh = Math.max(8, Math.round(sw * 0.66))
    const top = stallBase - sh
    const ah = Math.max(3, Math.round(sw * 0.17))
    const bodyTop = top + ah

    c.fillStyle = P.stallShade
    c.fillRect(sx, bodyTop, sw, stallBase - bodyTop)
    c.fillStyle = P.stall
    c.fillRect(sx + 1, bodyTop, sw - 2, Math.max(1, Math.round((stallBase - bodyTop) * 0.55)))
    c.fillStyle = P.stallDark
    c.fillRect(sx, stallBase - 1, sw, 1)

    const bolts = 2 + Math.floor(random() * 3)
    for (let i = 0; i < bolts; i += 1) {
      const bw = Math.max(1, Math.round(sw * 0.1))
      c.fillStyle = AWNING[Math.floor(random() * AWNING.length)]!
      c.fillRect(
        sx + 2 + Math.floor(random() * Math.max(1, sw - bw - 3)),
        bodyTop,
        bw,
        Math.max(2, Math.round(sh * (0.3 + random() * 0.34))),
      )
    }

    const awning = AWNING[Math.floor(random() * AWNING.length)]!
    const aw = sw + 4
    for (let i = 0; i < ah; i += 1) {
      c.fillStyle = i % 2 === 0 ? awning : P.stall
      c.fillRect(sx - 2, top + i, aw, 1)
    }
    c.fillStyle = awning
    for (let i = 0; i < aw; i += 4) c.fillRect(sx - 2 + i, top + ah, 2, 1)

    sx += sw + Math.max(2, Math.round(w * 0.012))
  }

  // ── The tree ──────────────────────────────────────────────────────────────
  // One trunk on the right, rising out of the grass into the canopy. It is
  // what gives the frame a foreground and a sense of scale.
  const trunkW = Math.max(7, Math.round(w * 0.1))
  const trunkX = Math.round(w * 0.83)
  const trunkTop = Math.round(canopyDepth * 0.5)
  const trunkBase = horizon + Math.round((h - horizon) * 0.46)
  for (let y = trunkTop; y < trunkBase; y += 1) {
    const t = (y - trunkTop) / Math.max(1, trunkBase - trunkTop)
    const half = Math.max(2, Math.round((trunkW / 2) * (0.72 + t * 0.55)))
    const shadow = Math.max(1, Math.round(half * 0.45))
    c.fillStyle = P.bark
    c.fillRect(trunkX - half, y, half * 2, 1)
    c.fillStyle = P.barkDark
    c.fillRect(trunkX + half - shadow, y, shadow, 1)
    c.fillStyle = P.barkLit
    c.fillRect(trunkX - half, y, Math.max(1, Math.round(half * 0.22)), 1)
    // Bark: long broken vertical striations, following the trunk rather than
    // scattered across it — speckles read as dirt, lines read as grain.
    if (y % 3 === 0) {
      const lane = 2 + ((Math.floor(y / 11) * 5) % Math.max(1, half * 2 - 3))
      c.fillStyle = P.barkDark
      c.fillRect(trunkX - half + lane, y, 1, 3)
    }
  }
  for (let i = 0; i < 4; i += 1) {
    const dir = i % 2 === 0 ? -1 : 1
    const len = Math.round(trunkW * (0.6 + (i / 4) * 1.1))
    c.fillStyle = P.bark
    c.fillRect(trunkX + (dir < 0 ? -len : 0), trunkBase - 2 - i, len, 2)
  }

  // ── Canopy ────────────────────────────────────────────────────────────────
  // Foliage hanging into the frame from the top, which is what turns a sky
  // into somewhere you are standing. Painted onto its own canvas so it can be
  // laid back over the drifting clouds, then stamped onto the backdrop too.
  const canopy = document.createElement('canvas')
  canopy.width = w
  canopy.height = canopyDepth
  const cy = canopy.getContext('2d')!
  cy.imageSmoothingEnabled = false

  const unit = Math.max(4, Math.round(w * 0.052))
  const cn = rng(1207)
  const puffs: { x: number; y: number; r: number }[] = []
  for (let x = -unit; x < w + unit; x += Math.max(2, Math.round(unit * 0.6))) {
    const r = unit * (0.72 + cn() * 0.8)
    puffs.push({ x, y: cn() * canopyDepth * 0.5 - r * 0.2, r })
  }
  /*
   * Four passes, darkest first, each smaller and pushed up-left toward the
   * sun. The first version stopped after two and left a silhouette: a canopy
   * is mostly light with shadow under it, not shadow with a little light on
   * top, and the ratio is what makes it read as leaves rather than as a hole
   * in the sky.
   */
  for (const p of puffs) roughBlob(cy, p.x, p.y, p.r * 1.1, P.leafDeep)
  for (const p of puffs) roughBlob(cy, p.x, p.y - p.r * 0.16, p.r * 0.94, P.leaf)
  for (const p of puffs) roughBlob(cy, p.x - p.r * 0.16, p.y - p.r * 0.3, p.r * 0.72, P.leafMid)
  for (const p of puffs) {
    if (cn() > 0.72) continue
    roughBlob(cy, p.x - p.r * 0.26, p.y - p.r * 0.44, p.r * 0.46, P.leafLit)
    if (cn() > 0.45) roughBlob(cy, p.x - p.r * 0.34, p.y - p.r * 0.56, p.r * 0.24, P.leafSun)
  }
  // Loose leaves below the mass, so the edge is not a hard line.
  for (let i = 0; i < Math.round(w * 0.6); i += 1) {
    const lx = Math.floor(cn() * w)
    const ly = Math.round(canopyDepth * (0.34 + cn() * 0.62))
    cy.fillStyle = cn() > 0.6 ? P.leafMid : P.leaf
    cy.fillRect(lx, ly, 1, 1)
    if (cn() > 0.72) cy.fillRect(lx + 1, ly + 1, 1, 1)
  }
  // Foliage where the trunk meets the canopy, so it belongs to the tree.
  roughBlob(cy, trunkX, canopyDepth - 2, trunkW * 1.5, P.leafDeep)
  roughBlob(cy, trunkX - trunkW * 0.6, canopyDepth - 5, trunkW, P.leaf)

  c.drawImage(canopy, 0, 0)

  return { backdrop, canopy }
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
      const { w, horizon, canopyDepth } = scene

      ctx.drawImage(scene.backdrop, 0, 0)

      // ── Clouds ──────────────────────────────────────────────────────────
      // One strip twice the grid width, blitted twice at a scrolling offset,
      // which buys real drift for the price of two draw calls. Clipped to the
      // sky so it never crosses the treeline.
      const offset = ((t * 0.5) / 1000) % scene.clouds.width
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, w, Math.max(0, horizon - 2))
      ctx.clip()
      ctx.drawImage(scene.clouds, -offset, 0)
      ctx.drawImage(scene.clouds, scene.clouds.width - offset, 0)

      // ── Birds ───────────────────────────────────────────────────────────
      for (const bird of scene.birds) {
        const x = ((bird.x + (t * bird.speed) / 220) % (w + 12)) - 6
        const y = bird.y + Math.sin(t * 0.0008 + bird.phase) * 2
        // Two pixels up or two pixels flat: a wingbeat, at this size.
        const up = Math.sin(t * 0.006 + bird.phase) > 0
        ctx.fillStyle = P.leafDeep
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1)
        ctx.fillRect(Math.round(x) - 1, Math.round(y) + (up ? -1 : 0), 1, 1)
        ctx.fillRect(Math.round(x) + 1, Math.round(y) + (up ? -1 : 0), 1, 1)
      }
      ctx.restore()

      // The canopy goes back on top, so foliage stays in front of the weather.
      ctx.drawImage(scene.canopy, 0, 0)

      // ── Light shafts ────────────────────────────────────────────────────
      // Slanting down out of the canopy, breathing very slowly. The one thing
      // here that is atmosphere rather than an object.
      for (const shaft of scene.shafts) {
        ctx.globalAlpha = 0.025 + (Math.sin(t * 0.0004 + shaft.phase) * 0.5 + 0.5) * 0.035
        ctx.fillStyle = '#fff6d0'
        const top = Math.round(canopyDepth * 0.6)
        for (let i = 0; i < scene.h - top; i += 1) {
          ctx.fillRect(shaft.x + Math.round(i * 0.26), top + i, shaft.w, 1)
        }
        ctx.globalAlpha = 1
      }

      // ── Flowers in the grass ────────────────────────────────────────────
      for (const glint of scene.glints) {
        ctx.globalAlpha = 0.55 + (Math.sin(t * 0.0014 + glint.phase) * 0.5 + 0.5) * 0.45
        ctx.fillStyle = glint.colour
        ctx.fillRect(glint.x, glint.y, 1, 1)
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
       * is not being looked at would otherwise leave the hero blank for as
       * long as it stayed that way.
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
      {/* The scene is bright, so the headline brings its own shade rather than
          relying on the picture to be dark where the words happen to fall. */}
      <div className="pixel-vignette" />
    </div>
  )
}
