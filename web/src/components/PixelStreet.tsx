import { useEffect, useRef } from "react";

/**
 * The street the shop opens onto.
 *
 * This is a backdrop, not a picture. It is anchored to the bottom of the opening
 * screen, it runs the full width, and its alpha ramps to nothing on the way up,
 * so the headline is set on plain bone and the market simply accumulates
 * underneath it. There is no rectangle anywhere for the eye to catch on, which
 * is the whole difference between art that belongs on a page and art that has
 * been stuck to one.
 *
 * It is also the only thing on this screen now. A rail of product photographs
 * used to run through the middle of it, and between the two of them the page had
 * nothing to rest on. With the rail gone the street can be what a customer looks
 * at while deciding what to type, which is worth drawing properly: three trees
 * deep, stalls with cloth and baskets and a lantern, somebody sweeping, steam off
 * the chai pot, and clouds that take the better part of a minute to cross.
 *
 * Built in three baked layers with the moving parts drawn between them, so a
 * frame costs three blits and a few dozen rectangles rather than redrawing a
 * market: sky, then clouds and birds, then the street, then the people walking
 * in it, then the near trees they pass behind, then the fade over everything.
 */

/** CSS pixels per scene pixel — the unit every pixel surface here shares. */
const PIXEL = 4;
const STEP = 4;

/**
 * Scene rows. The strip is a fixed height in CSS — ART * PIXEL — rather than
 * stretched to fill the opening screen, because stretching a 4px grid over
 * whatever height the viewport happens to be gives tall rectangles, not pixels.
 */
const ART = 112;
const GROUND = 100; // the line the market stands on
const HORIZON = 66; // where walls and trees meet the sky
/** Full strength from here down; above it the art is being erased. */
const SOLID = 58;

/** Twelve frames a second. Pixel art moving at sixty reads as video of pixel
 *  art; at twelve it reads as animation, and costs a fifth as much. */
const FRAME_MS = 1000 / 12;

const P = {
  sky: "#a9e2f8",
  skyPale: "#cdeefb",
  sun: "#fdf3d0",
  cloud: "#ffffff",
  cloudShade: "#dceffb",

  canopyDark: "#22483a",
  canopy: "#2f5a49",
  canopyLit: "#3f6b5a",
  canopySun: "#527f68",
  trunk: "#5b4433",

  wall: "#e6dac2",
  wallShade: "#cdbf9f",
  wallDark: "#a2947a",
  pane: "#8fc4d8",
  paneLit: "#b9dcea",

  postDark: "#6b5942",
  table: "#c9b596",
  tableDark: "#9c8a6e",
  basket: "#b98b4e",
  basketDark: "#8d672f",

  rust: "#c25539",
  gold: "#e0a92c",
  green: "#2f8f6a",
  maroon: "#9c3a56",
  indigo: "#3f5bab",
  teal: "#2fa39a",
  cream: "#f2e7d0",

  earth: "#c8b79a",
  earthLit: "#d6c7ac",
  earthDark: "#ab9a7e",
  grass: "#679c48",
  grassSun: "#84b747",

  steam: "#eef4f2",
  skin: "#c99a72",
  skinAlt: "#8d6249",
} as const;

const AWNING = [P.rust, P.gold, P.green, P.maroon, P.indigo, P.teal];
const GOODS = [P.rust, P.gold, P.green, P.maroon, P.indigo, P.teal, P.cream];
const CLOTH = [P.maroon, P.indigo, P.teal, P.gold, P.rust];
const WEAR = ["#3c3a44", "#5a4a52", "#7a4636", "#3f5bab", "#9c3a56", "#2f5a49"];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;
const dot = (c: Ctx, x: number, y: number, fill: string, w = 1, h = 1) => {
  c.fillStyle = fill;
  c.fillRect(Math.round(x), Math.round(y), w, h);
};

function layer(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d")!;
  c.imageSmoothingEnabled = false;
  return [canvas, c];
}

/** Sky and sun. Nothing here ever changes, and everything else sits on it. */
function bakeSky(w: number) {
  const [canvas, c] = layer(w, ART);
  /* Flat haze first, then a dithered ramp confined to the top of the frame.
     A fifty-percent dither is a checkerboard at this grid, and anywhere the
     fade is not already erasing it that reads as static rather than as air —
     which is exactly what happened when the street grew tall enough to show
     its own middle. It stays above SOLID, where it is being rubbed out anyway. */
  dot(c, 0, 0, P.skyPale, w, GROUND);
  const band = SOLID - 8;
  for (let y = 0; y < band; y += 1) {
    const t = 1 - y / band;
    for (let x = 0; x < w; x += 1)
      if (t > BAYER[(y % 4) * 4 + (x % 4)]! / 16) dot(c, x, y, P.sky);
  }

  const sunX = Math.round(w * 0.8);
  const sunY = 14;
  const r = 6;
  for (let dy = -r * 2; dy <= r * 2; dy += 1) {
    for (let dx = -r * 2; dx <= r * 2; dx += 1) {
      const d = Math.hypot(dx, dy);
      const y = sunY + dy;
      if (y < 0 || y >= HORIZON) continue;
      if (d <= r) dot(c, sunX + dx, y, P.sun);
      else if (
        d <= r * 2 &&
        (d - r) / r < BAYER[(y % 4) * 4 + ((sunX + dx) % 4)]! / 16
      )
        dot(c, sunX + dx, y, P.sun);
    }
  }
  return canvas;
}

/** The street itself: far trees, shopfronts, ground, stalls. */
function bakeBack(w: number) {
  const [canvas, c] = layer(w, ART);
  const random = rng(20260218);

  // Far trees, standing behind the roofs.
  for (let tx = -6; tx < w + 8;) {
    const r = 6 + Math.floor(random() * 5);
    const cy = HORIZON - r + 2 + Math.floor(random() * 6);
    const lit = random();
    const body = lit > 0.62 ? P.canopySun : lit > 0.3 ? P.canopyLit : P.canopy;
    dot(c, tx - 1, cy, P.trunk, 2, GROUND - cy);
    for (let dy = -r; dy <= r; dy += 1) {
      const span = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      if (cy + dy >= 0) dot(c, tx - span, cy + dy, body, span * 2 + 1, 1);
    }
    for (let dy = -r; dy <= -Math.floor(r * 0.3); dy += 1) {
      const span = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)) * 0.55);
      if (cy + dy >= 0)
        dot(c, tx - span - 1, cy + dy, P.canopySun, Math.max(1, span), 1);
    }
    tx += r + 2 + Math.floor(random() * 7);
  }

  /* A shopfront here and there — not a terrace. At this scale an unbroken row
     of them is one beige slab that swallows the trees, and the street stops
     having any depth at all. */
  for (let bx = -4; bx < w + 6;) {
    const bw = 13 + Math.floor(random() * 15);
    if (random() > 0.42) {
      const bh = 14 + Math.floor(random() * 8);
      const roof = GROUND - bh;
      dot(c, bx, roof, P.wallShade, bw, bh);
      dot(c, bx + 1, roof + 1, P.wall, bw - 2, bh - 1);
      dot(c, bx, roof, P.wallDark, bw, 1);
      dot(c, bx - 1, roof, P.wallDark, bw + 2, 1); // an eave, so it has a roof
      for (let wx = bx + 3; wx < bx + bw - 4; wx += 7) {
        dot(c, wx, roof + 5, P.wallDark, 5, 6);
        dot(c, wx, roof + 5, random() > 0.45 ? P.paneLit : P.pane, 4, 5);
        dot(c, wx, roof + 7, P.wallDark, 4, 1); // a glazing bar
      }
    }
    bx += bw + 2 + Math.floor(random() * 8);
  }

  // Ground.
  dot(c, 0, GROUND, P.earth, w, ART - GROUND);
  dot(c, 0, GROUND + 5, P.earthLit, w, ART - GROUND - 5);
  for (let y = GROUND + 3; y < GROUND + 5; y += 1)
    for (let x = 0; x < w; x += 1)
      if ((y - GROUND - 3) / 2 > BAYER[(y % 4) * 4 + (x % 4)]! / 16)
        dot(c, x, y, P.earthLit);
  dot(c, 0, GROUND - 1, P.grass, w, 1);
  for (let x = 0; x < w; x += 1)
    if (random() > 0.55) dot(c, x, GROUND - 2, P.grassSun);
  // Sparse: a stone every dozen pixels reads as ground, a stone every other
  // pixel reads as a broken screen.
  for (let i = 0; i < w * 0.12; i += 1)
    dot(
      c,
      Math.floor(random() * w),
      GROUND + 2 + Math.floor(random() * 7),
      P.earthDark,
    );
  for (let i = 0; i < w * 0.07; i += 1)
    dot(
      c,
      Math.floor(random() * w),
      GROUND + 1 + Math.floor(random() * 7),
      P.earthLit,
      3,
      1,
    );

  /* The stalls. An awning up top, two posts, and a table below — with the
     middle left open on purpose. That gap is what stops the row reading as a
     fence: you see trees and sky and the next stall along through it. */
  for (let sx = -5; sx < w + 8;) {
    const sw = 19 + Math.floor(random() * 13);
    const sh = 22 + Math.floor(random() * 11); // a spread, or the awnings line
    // up into one stripe running the width of the page
    const roof = GROUND - sh;
    const deck = GROUND - 9; // tables are table height, whatever the awning does

    dot(c, sx + 2, roof + 6, P.postDark, 2, GROUND - roof - 6);
    dot(c, sx + sw - 4, roof + 6, P.postDark, 2, GROUND - roof - 6);

    // Bolts of cloth hung off the frame, filling some of the open middle.
    if (random() > 0.45) {
      const hx = sx + 5 + Math.floor(random() * Math.max(1, sw - 12));
      const hl = 6 + Math.floor(random() * 8);
      dot(c, hx, roof + 7, CLOTH[Math.floor(random() * CLOTH.length)]!, 3, hl);
    }

    dot(c, sx + 3, deck, P.tableDark, sw - 6, GROUND - deck);
    dot(c, sx + 3, deck, P.table, sw - 6, 2);
    for (let gx = sx + 4; gx < sx + sw - 5;) {
      const gw = 2 + Math.floor(random() * 3);
      const gh = 2 + Math.floor(random() * 5);
      dot(
        c,
        gx,
        deck - gh,
        GOODS[Math.floor(random() * GOODS.length)]!,
        gw,
        gh,
      );
      gx += gw + 1;
    }

    // A basket or two on the ground at the front of the pitch.
    if (random() > 0.5) {
      const bx = sx + 4 + Math.floor(random() * Math.max(1, sw - 10));
      dot(c, bx, GROUND - 4, P.basketDark, 5, 4);
      dot(c, bx + 1, GROUND - 4, P.basket, 3, 3);
      dot(
        c,
        bx + 1,
        GROUND - 5,
        GOODS[Math.floor(random() * GOODS.length)]!,
        3,
        1,
      );
    }

    const stripe = AWNING[Math.floor(random() * AWNING.length)]!;
    for (let i = 0; i < 5; i += 1)
      dot(c, sx - 1, roof + i, i % 2 === 0 ? stripe : P.cream, sw + 2, 1);
    dot(c, sx - 2, roof + 5, P.cream, sw + 4, 1);
    for (let fx = sx - 2; fx < sx + sw + 2; fx += 3)
      dot(c, fx, roof + 6, stripe, 2, 1);

    // A lantern on the corner post of some pitches.
    if (random() > 0.6) {
      dot(c, sx + sw - 4, roof + 8, P.postDark, 1, 2);
      dot(c, sx + sw - 5, roof + 10, P.gold, 3, 3);
      dot(c, sx + sw - 5, roof + 12, P.rust, 3, 1);
    }

    sx += sw + 4 + Math.floor(random() * 7);
  }

  /* Bunting, strung the length of the street and sagging between the posts. It
     hangs high enough to be half-erased by the fade, which is the point — it is
     the first thing to arrive as the eye travels down the page. */
  const buntY = GROUND - 40;
  const span = 30;
  for (let x = 0; x < w; x += 1) {
    const sag = Math.round(Math.sin(((x % span) / span) * Math.PI) * 5);
    dot(c, x, buntY + sag, P.postDark);
    if (x % 4 === 0)
      dot(
        c,
        x,
        buntY + sag + 1,
        AWNING[Math.floor(random() * AWNING.length)]!,
        2,
        2,
      );
  }
  return canvas;
}

/**
 * The near trees, drawn on their own layer so people can walk behind them.
 *
 * Without them everything sits on one plane at one distance and the awnings and
 * the canopies each collapse into a stripe running the width of the page. One
 * occlusion tells you which of two things is closer, and the stripes stop being
 * stripes.
 */
function bakeFront(w: number) {
  const [canvas, c] = layer(w, ART);
  const random = rng(70413);
  for (let fx = 14 + Math.floor(random() * 46); fx < w + 16;) {
    const r = 10 + Math.floor(random() * 4);
    const cy = GROUND - 28 - Math.floor(random() * 7);
    dot(c, fx - 1, cy, P.trunk, 3, GROUND - cy);
    dot(c, fx + 2, cy + 5, P.trunk, 2, 3); // a low branch, so it is not a lamp post
    dot(c, fx - 3, cy + 9, P.trunk, 2, 2);
    for (let dy = -r; dy <= r; dy += 1) {
      const span = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      if (cy + dy >= 0)
        dot(c, fx - span, cy + dy, P.canopyDark, span * 2 + 1, 1);
    }
    for (let dy = -r; dy <= -Math.floor(r * 0.25); dy += 1) {
      const span = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)) * 0.6);
      if (cy + dy >= 0)
        dot(c, fx - span - 1, cy + dy, P.canopy, Math.max(1, span), 1);
    }
    // Lit clumps, so the canopy has leaves rather than being a disc.
    for (let i = 0; i < 12; i += 1) {
      const a = random() * Math.PI * 2;
      const d = random() * r * 0.72;
      dot(c, fx + Math.cos(a) * d, cy + Math.sin(a) * d - 2, P.canopyLit, 2, 2);
    }
    fx += 66 + Math.floor(random() * 54);
  }
  return canvas;
}

interface Cloud {
  x: number;
  y: number;
  rows: number[];
  speed: number;
}
interface Bird {
  x: number;
  y: number;
  speed: number;
  phase: number;
}
interface Walker {
  x: number;
  speed: number;
  wear: string;
  skin: string;
  tall: number;
  carry: string | null;
}

function movers(w: number) {
  const random = rng(881207);
  const clouds: Cloud[] = [];
  for (let i = 0; i < 4; i += 1) {
    const len = 8 + Math.floor(random() * 12);
    const rows: number[] = [];
    for (let r = 0; r < 4; r += 1)
      rows.push(Math.max(2, Math.round(len * (0.4 + random() * 0.6))));
    clouds.push({
      x: random() * (w + 60) - 30,
      y: 6 + Math.floor(random() * 26),
      rows,
      speed: 0.08 + random() * 0.12, // scene pixels per frame: a minute to cross
    });
  }
  const birds: Bird[] = [];
  for (let i = 0; i < 5; i += 1)
    birds.push({
      x: random() * w,
      y: 10 + Math.floor(random() * 30),
      speed: 0.5 + random() * 0.7,
      phase: Math.floor(random() * 4),
    });
  const walkers: Walker[] = [];
  for (let i = 0; i < 7; i += 1) {
    const dir = random() > 0.5 ? 1 : -1;
    walkers.push({
      x: random() * w,
      speed: dir * (0.22 + random() * 0.3),
      wear: WEAR[Math.floor(random() * WEAR.length)]!,
      skin: random() > 0.5 ? P.skin : P.skinAlt,
      tall: 11 + Math.floor(random() * 4),
      carry:
        random() > 0.6 ? GOODS[Math.floor(random() * GOODS.length)]! : null,
    });
  }
  return { clouds, birds, walkers };
}

function drawCloud(c: Ctx, cloud: Cloud) {
  cloud.rows.forEach((len, i) => {
    const inset = Math.round(Math.abs(i - 1.5));
    dot(
      c,
      cloud.x + inset,
      cloud.y + i,
      i === 3 ? P.cloudShade : P.cloud,
      len,
      1,
    );
  });
}

function drawBird(c: Ctx, bird: Bird, tick: number) {
  const up = (tick + bird.phase) % 4 < 2;
  const x = bird.x;
  const y = bird.y;
  dot(c, x, y, P.canopy);
  dot(c, x + 2, y, P.canopy);
  dot(c, x + 1, up ? y + 1 : y - 1, P.canopy);
}

function drawWalker(c: Ctx, walker: Walker, tick: number) {
  const x = Math.round(walker.x);
  const top = GROUND - walker.tall;
  dot(c, x, top, walker.skin, 3, 3); // head — in the coat colour it reads as a post
  dot(c, x, top, walker.wear, 3, 1); // and hair on top of it
  dot(c, x, top + 3, walker.wear, 4, walker.tall - 6); // body
  // Two-frame walk: the legs swap, which at twelve frames a second is plenty.
  const stride = (tick + x) % 4 < 2;
  dot(c, x, GROUND - 3, walker.wear, 1, 3);
  dot(c, x + 2, GROUND - 3, walker.wear, 1, stride ? 3 : 2);
  if (walker.carry)
    dot(c, walker.speed > 0 ? x + 4 : x - 2, top + 5, walker.carry, 2, 3);
}

function paintFade(c: Ctx, w: number, h: number) {
  c.globalCompositeOperation = "destination-out";
  const up = c.createLinearGradient(0, 0, 0, SOLID);
  up.addColorStop(0, "rgba(0,0,0,1)");
  up.addColorStop(0.62, "rgba(0,0,0,0.95)"); // the copy sits in here
  up.addColorStop(0.82, "rgba(0,0,0,0.5)");
  up.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = up;
  c.fillRect(0, 0, w, SOLID);
  // The near edge of the ground dissolves rather than stopping, so the street
  // runs out of the frame instead of being cut off by it.
  const down = c.createLinearGradient(0, h - 7, 0, h);
  down.addColorStop(0, "rgba(0,0,0,0)");
  down.addColorStop(1, "rgba(0,0,0,1)");
  c.fillStyle = down;
  c.fillRect(0, h - 7, w, 7);
  c.globalCompositeOperation = "source-over";
}

export function PixelStreet() {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = wrap.current;
    const canvas = ref.current;
    if (!host || !canvas) return;
    const c = canvas.getContext("2d");
    if (!c) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let sky: HTMLCanvasElement | null = null;
    let back: HTMLCanvasElement | null = null;
    let front: HTMLCanvasElement | null = null;
    let parts = movers(0);
    let width = 0;
    let tick = 0;
    let raf = 0;
    let last = 0;
    let acc = 0;

    const draw = () => {
      if (!sky || !back || !front) return;
      c.clearRect(0, 0, width, ART);
      c.imageSmoothingEnabled = false;
      c.drawImage(sky, 0, 0);
      for (const cloud of parts.clouds) drawCloud(c, cloud);
      for (const bird of parts.birds) drawBird(c, bird, tick);
      c.drawImage(back, 0, 0);
      for (const walker of parts.walkers) drawWalker(c, walker, tick);
      c.drawImage(front, 0, 0);
      paintFade(c, width, ART);
    };

    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (document.hidden) return;
      acc += now - (last || now);
      last = now;
      if (acc < FRAME_MS) return;
      acc = Math.min(acc % FRAME_MS, FRAME_MS);
      tick += 1;
      for (const cloud of parts.clouds) {
        cloud.x += cloud.speed;
        if (cloud.x > width + 24) cloud.x = -28;
      }
      for (const bird of parts.birds) {
        bird.x += bird.speed;
        if (bird.x > width + 4) bird.x = -4;
      }
      for (const walker of parts.walkers) {
        walker.x += walker.speed;
        if (walker.x > width + 6) walker.x = -6;
        if (walker.x < -6) walker.x = width + 6;
      }
      draw();
    };

    let key = "";
    const layout = () => {
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      // A fixed pixel *size* with a variable grid: the art keeps its chunk at
      // every width instead of stretching to fit one.
      const w = Math.max(
        80,
        Math.min(460, Math.round(rect.width / PIXEL / STEP) * STEP),
      );
      if (`${w}` === key) return;
      key = `${w}`;
      width = w;
      canvas.width = w;
      canvas.height = ART;
      sky = bakeSky(w);
      back = bakeBack(w);
      front = bakeFront(w);
      parts = movers(w);
      draw(); // paint synchronously; a backgrounded tab never reaches rAF
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
    <div className="pixel-street" ref={wrap} aria-hidden="true">
      <canvas ref={ref} className="pixel-street-canvas" />
    </div>
  );
}
