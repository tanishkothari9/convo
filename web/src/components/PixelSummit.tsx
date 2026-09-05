import { useEffect, useRef } from "react";

/**
 * Above the cloud line, at first light. The backdrop for signing in.
 *
 * Deliberately not the market. Every other pixel surface here is the street a
 * shopper walks down, and reusing it behind the merchant's front door would say
 * the two are the same place when they are opposite ends of the product — one
 * is where you browse, this is where you go to work. So: ridges, a sea of cloud
 * moving underneath them, and a sun that has just cleared the horizon. Wide,
 * quiet, and nothing in it to read.
 *
 * The palette is still the site's. Bone-family clouds, bottle-green ridges, a
 * warm sky — a genuinely new scene rather than a new set of colours.
 *
 * Baked once per resize, with only the cloud banks and the birds redrawn on the
 * frame. Ten frames a second: this sits behind a form somebody is typing into,
 * and anything faster would be motion competing with a password field.
 */

const PIXEL = 4;
const FRAME_MS = 1000 / 10;

const P = {
  skyHigh: "#9dc2e4",
  skyMid: "#c2d9ea",
  skyLow: "#e6dfe2",
  skyWarm: "#f6e2c6",

  sunCore: "#fff4d8",
  sunHalo: "#ffe6b4",

  ridgeFar: "#93a7a0",
  ridgeFarLit: "#a8b9b2",
  ridgeMid: "#5f7c72",
  ridgeMidLit: "#71907f",
  ridgeNear: "#37564a",
  ridgeNearLit: "#456757",
  snow: "#f4f1e8",

  cloudLit: "#fdfaf3",
  cloud: "#ece5d8",
  cloudShade: "#d3ccbe",

  bird: "#3d5a4e",
} as const;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function hash(n: number, seed: number): number {
  let h = (n * 374761393 + seed * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in one dimension — enough for a skyline, and cheap. */
function noise(x: number, seed: number, scale: number): number {
  const p = x / scale;
  const i = Math.floor(p);
  const f = p - i;
  const s = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - s) + hash(i + 1, seed) * s;
}

function ridgeHeight(x: number, seed: number, scale: number): number {
  return (
    noise(x, seed, scale) * 0.6 +
    noise(x, seed + 91, scale / 2.7) * 0.28 +
    noise(x, seed + 7, scale / 8) * 0.12
  );
}

type Ctx = CanvasRenderingContext2D;

function bake(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d")!;
  c.imageSmoothingEnabled = false;
  const px = (x: number, y: number, fill: string, dw = 1, dh = 1) => {
    c.fillStyle = fill;
    c.fillRect(x, y, dw, dh);
  };

  /* Sky: four bands, each seam dithered into the next. A plain gradient goes
     smooth and stops being pixel art; the dither is what keeps the banding
     deliberate instead of accidental. */
  const stops: Array<[number, string]> = [
    [0, P.skyHigh],
    [0.38, P.skyMid],
    [0.66, P.skyLow],
    [1, P.skyWarm],
  ];
  const horizon = Math.round(h * 0.62);
  /* Flat bands, dithered only across a narrow seam where two of them meet.
     Dithering the full height instead gives a fifty-percent checkerboard across
     the whole sky, which at four pixels reads as screen noise rather than as
     air — the same mistake the market street made before it was fixed. */
  const seam = Math.max(3, Math.round(horizon * 0.06));
  for (let i = 0; i < stops.length - 1; i += 1) {
    const from = Math.round(stops[i]![0] * horizon);
    const to = Math.round(stops[i + 1]![0] * horizon);
    px(0, from, stops[i]![1], w, to - from);
    for (let y = Math.max(0, to - seam); y < to; y += 1) {
      const mix = (y - (to - seam)) / seam;
      for (let x = 0; x < w; x += 1) {
        if (mix > BAYER[(y % 4) * 4 + (x % 4)]! / 16)
          px(x, y, stops[i + 1]![1]);
      }
    }
  }
  px(0, horizon, P.skyWarm, w, h - horizon);

  // The sun, just clear of the ridges, with a dithered halo rather than a rim.
  // Upper left, well clear of the panel that sits in the middle of this page.
  const sx = Math.round(w * 0.17);
  const sy = Math.round(horizon * 0.3);
  const r = Math.max(6, Math.round(Math.min(w, h) * 0.055));
  const halo = r * 2.1;
  for (let dy = -halo; dy <= halo; dy += 1) {
    for (let dx = -halo; dx <= halo; dx += 1) {
      const d = Math.hypot(dx, dy);
      const y = sy + dy;
      if (y < 0 || y >= h) continue;
      if (d <= r) px(sx + dx, y, P.sunCore);
      else if (d <= halo) {
        // Squared falloff, so the halo thins fast and the outer ring is a
        // suggestion rather than a scatter of loose dots around a disc.
        const fade = (1 - (d - r) / (halo - r)) ** 2;
        if (fade > BAYER[(y % 4) * 4 + ((sx + dx) % 4)]! / 16)
          px(sx + dx, y, P.sunHalo);
      }
    }
  }

  /* Three ridges, receding. Each is a noise skyline filled to the bottom, in a
     paler tint the further back it stands — haze does the depth, not detail. */
  const layers = [
    {
      seed: 11,
      scale: w / 2.6,
      amp: 0.16,
      base: 0.5,
      body: P.ridgeFar,
      lit: P.ridgeFarLit,
      snow: false,
    },
    {
      seed: 47,
      scale: w / 3.4,
      amp: 0.2,
      base: 0.63,
      body: P.ridgeMid,
      lit: P.ridgeMidLit,
      snow: true,
    },
    {
      seed: 83,
      scale: w / 4.6,
      amp: 0.24,
      base: 0.78,
      body: P.ridgeNear,
      lit: P.ridgeNearLit,
      snow: true,
    },
  ];
  for (const layer of layers) {
    let previous = 0;
    for (let x = 0; x < w; x += 1) {
      const top = Math.round(
        h * (layer.base - ridgeHeight(x, layer.seed, layer.scale) * layer.amp),
      );
      px(x, top, layer.body, 1, h - top);
      /* The sun is up and to the left, so the lit faces are the ones climbing
         towards it — where the skyline is still rising as x increases, which is
         `top` getting smaller. Lighting the falling side instead puts the
         highlight on the shadowed slope, which is hard to name and easy to see. */
      if (x > 0 && top < previous)
        px(x, top, layer.lit, 1, Math.min(4, previous - top + 1));
      /* Snow near the summits only, and patchy even there. A height test on its
         own traces the whole crest, and the ridge ends up outlined in white
         like piping rather than capped. */
      if (
        layer.snow &&
        top < h * (layer.base - layer.amp * 0.82) &&
        hash(x, layer.seed + 3) > 0.28
      ) {
        px(x, top, P.snow, 1, 1 + Math.floor(hash(x, layer.seed) * 2));
      }
      previous = top;
    }
  }
  return canvas;
}

interface Bank {
  /** Row the bank sits on, and how far it has drifted. */
  y: number;
  x: number;
  speed: number;
  depth: number;
  seed: number;
  scale: number;
  body: string;
  lit: string;
}

function banks(w: number, h: number): Bank[] {
  const rows = [0.7, 0.82, 0.96];
  const body = [P.cloudShade, P.cloud, P.cloudLit];
  const lit = [P.cloud, P.cloudLit, "#ffffff"];
  return rows.map((row, i) => ({
    y: Math.round(h * row),
    x: hash(i, 5) * w,
    // The far bank crawls; the near one moves enough to notice if you watch.
    speed: 0.04 + i * 0.07,
    depth: Math.round(h * (0.07 + i * 0.035)),
    seed: 200 + i * 37,
    // Lobes wider than they are tall, or the bank reads as a hedge.
    scale: Math.max(8, Math.round(w / (7 - i * 1.4))),
    body: body[i]!,
    lit: lit[i]!,
  }));
}

/*
 * The top edge of a cloud bank, as overlapping lobes rather than a noise line.
 *
 * Noise gives you a coastline; cloud is round. Each bank is a row of ellipses
 * at irregular spacing and the edge is whichever of them reaches highest at
 * this column, which is what makes the bank read as heaped rather than as a
 * beige terrace with a wobbly top.
 */
function lobeTop(x: number, bank: Bank): number {
  const at = x + bank.x;
  const i = Math.floor(at / bank.scale);
  let rise = 0;
  for (let k = i - 1; k <= i + 1; k += 1) {
    const cx = k * bank.scale + hash(k, bank.seed) * bank.scale * 0.55;
    const rx = bank.scale * (0.42 + hash(k, bank.seed + 1) * 0.4);
    const ry = bank.depth * (0.45 + hash(k, bank.seed + 2) * 0.55);
    const d = (at - cx) / rx;
    if (Math.abs(d) < 1) rise = Math.max(rise, ry * Math.sqrt(1 - d * d));
  }
  return bank.y - Math.round(rise);
}

function drawBank(c: Ctx, bank: Bank, w: number, h: number) {
  for (let x = 0; x < w; x += 1) {
    const top = lobeTop(x, bank);
    c.fillStyle = bank.body;
    c.fillRect(x, top, 1, h - top);
    // A lit crest and a shaded belly: the light is up and to the left, and a
    // bank with one flat tone is a shape, not a cloud.
    c.fillStyle = bank.lit;
    c.fillRect(x, top, 1, 3);
    // Two rows of dither above the crest: the edge of cloud is not a line.
    for (let d = 1; d <= 3; d += 1) {
      const y = top - d;
      if (y < 0) continue;
      if (1 - d / 4 > BAYER[(y % 4) * 4 + (x % 4)]! / 16) {
        c.fillStyle = bank.body;
        c.fillRect(x, y, 1, 1);
      }
    }
  }
}

interface Bird {
  x: number;
  y: number;
  speed: number;
  phase: number;
}

export function PixelSummit() {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = wrap.current;
    const canvas = ref.current;
    if (!host || !canvas) return;
    const c = canvas.getContext("2d");
    if (!c) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let backdrop: HTMLCanvasElement | null = null;
    let sky: Bank[] = [];
    let birds: Bird[] = [];
    let w = 0;
    let h = 0;
    let tick = 0;
    let raf = 0;
    let last = 0;
    let acc = 0;

    const draw = () => {
      if (!backdrop) return;
      c.imageSmoothingEnabled = false;
      c.drawImage(backdrop, 0, 0);
      for (const bird of birds) {
        const up = (tick + bird.phase) % 4 < 2;
        c.fillStyle = P.bird;
        c.fillRect(Math.round(bird.x), bird.y, 1, 1);
        c.fillRect(Math.round(bird.x) + 2, bird.y, 1, 1);
        c.fillRect(Math.round(bird.x) + 1, up ? bird.y + 1 : bird.y - 1, 1, 1);
      }
      for (const bank of sky) drawBank(c, bank, w, h);
    };

    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (document.hidden) return;
      acc += now - (last || now);
      last = now;
      if (acc < FRAME_MS) return;
      acc = Math.min(acc % FRAME_MS, FRAME_MS);
      tick += 1;
      for (const bank of sky) bank.x += bank.speed;
      for (const bird of birds) {
        bird.x += bird.speed;
        if (bird.x > w + 4) bird.x = -4;
      }
      draw();
    };

    let key = "";
    const layout = () => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const next = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
      if (next === key) return;
      key = next;
      w = Math.max(80, Math.min(520, Math.round(rect.width / PIXEL)));
      h = Math.max(80, Math.min(400, Math.round(rect.height / PIXEL)));
      canvas.width = w;
      canvas.height = h;
      backdrop = bake(w, h);
      sky = banks(w, h);
      birds = Array.from({ length: 4 }, (_, i) => ({
        x: hash(i, 900) * w,
        y: Math.round(h * (0.12 + hash(i, 901) * 0.2)),
        speed: 0.25 + hash(i, 902) * 0.35,
        phase: Math.floor(hash(i, 903) * 4),
      }));
      draw(); // paint before the loop; a backgrounded tab never reaches rAF
    };

    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(host);
    if (!still) raf = requestAnimationFrame(step);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="pixel-summit" ref={wrap} aria-hidden="true">
      <canvas ref={ref} className="pixel-summit-canvas" />
    </div>
  );
}
