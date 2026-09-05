import { useEffect, useRef } from "react";

/**
 * The yard behind the shop, for the foot of the navigation drawer.
 *
 * The drawer already had a hole in it: links at the top, the brand and the
 * sign-out at the bottom, and a tall empty column between them that read as
 * something having failed to load. This fills it — but the shape of the space
 * decides the picture, and that space is narrow and tall, so it is not another
 * horizontal strip of market. It is one pitch of ground seen close: a wall, a
 * tree leaning over it, pots along the foot, a line of washing.
 *
 * Round the back rather than out front, which is the right side of the product
 * for this panel. The street is where a shopper browses; this is where the
 * stock lives. Same world, private side of it.
 *
 * Edgeless, like everything else that sits inside a working surface — it fades
 * upward into the panel, so there is no rectangle for the eye to catch.
 */

const W = 56;
const H = 46;
const GROUND = 38;
/** Full strength from here down; above it the art is being erased. */
const SOLID = 20;

const P = {
  sky: "#d7ecf7",
  skyPale: "#e8f4fb",

  canopy: "#2f5a49",
  canopyLit: "#527f68",
  trunk: "#5b4433",

  wall: "#ddd2ba",
  wallLit: "#ebe2ce",
  cap: "#c3b697",

  pot: "#b5643f",
  potDark: "#8d4a2c",
  leaf: "#4f8a52",
  leafLit: "#6ba85f",
  bloom: "#d4645f",

  cloth: "#f2e7d0",
  clothAlt: "#8fb8c9",
  line: "#8a7355",

  earth: "#c8b79a",
  earthLit: "#d6c7ac",
  grass: "#679c48",
} as const;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function hash(n: number, seed: number): number {
  let h = (n * 374761393 + seed * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function paint(canvas: HTMLCanvasElement) {
  const c = canvas.getContext("2d");
  if (!c) return;
  canvas.width = W;
  canvas.height = H;
  c.clearRect(0, 0, W, H);
  c.imageSmoothingEnabled = false;
  const px = (x: number, y: number, fill: string, dw = 1, dh = 1) => {
    c.fillStyle = fill;
    c.fillRect(Math.round(x), Math.round(y), dw, dh);
  };

  px(0, 0, P.skyPale, W, GROUND);
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < W; x += 1)
      if (1 - y / 8 > BAYER[(y % 4) * 4 + (x % 4)]! / 16) px(x, y, P.sky);

  /* The tree leans in from the right and is cut off by the edge — a whole tree
     centred in a panel this narrow is a logo, not a place. */
  const tx = 46;
  const ty = 12;
  const r = 12;
  px(tx - 1, ty, P.trunk, 3, GROUND - ty);
  for (let dy = -r; dy <= r; dy += 1) {
    const span = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
    if (ty + dy >= 0) px(tx - span, ty + dy, P.canopy, span * 2 + 1, 1);
  }
  for (let i = 0; i < 14; i += 1) {
    const a = hash(i, 9) * Math.PI * 2;
    const d = hash(i, 10) * r * 0.72;
    px(tx + Math.cos(a) * d, ty + Math.sin(a) * d - 1, P.canopyLit, 2, 2);
  }

  // The wall, with a capping course along the top.
  const wallTop = GROUND - 12;
  px(0, wallTop, P.wall, W, GROUND - wallTop);
  px(0, wallTop + 1, P.wallLit, W, 2);
  px(0, wallTop, P.cap, W, 1);
  // Courses, broken so it reads as stone rather than as ruled paper.
  for (let y = wallTop + 4; y < GROUND; y += 4)
    for (let x = 0; x < W; x += 1)
      if (hash(x + y * 31, 17) > 0.35) px(x, y, P.cap);

  // A washing line across the top of the wall, sagging between two posts.
  const lineY = wallTop - 7;
  for (let x = 2; x < 44; x += 1) {
    const sag = Math.round(Math.sin(((x - 2) / 42) * Math.PI) * 3);
    px(x, lineY + sag, P.line);
  }
  for (const [cx, tone, len] of [
    [8, P.cloth, 6],
    [17, P.clothAlt, 5],
    [27, P.cloth, 7],
    [35, P.clothAlt, 5],
  ] as Array<[number, string, number]>) {
    const sag = Math.round(Math.sin(((cx - 2) / 42) * Math.PI) * 3);
    px(cx, lineY + sag + 1, tone, 4, len);
  }

  // Ground, then pots along the foot of the wall.
  px(0, GROUND, P.earth, W, H - GROUND);
  px(0, GROUND + 3, P.earthLit, W, H - GROUND - 3);
  px(0, GROUND - 1, P.grass, W, 1);

  for (const [ox, tall] of [
    [4, 4],
    [12, 3],
    [22, 5],
    [33, 3],
  ] as Array<[number, number]>) {
    const potTop = GROUND - 4;
    px(ox, potTop, P.potDark, 6, 4);
    px(ox + 1, potTop, P.pot, 4, 3);
    px(ox, potTop, P.pot, 6, 1);
    // What is growing in it.
    for (let i = 0; i < tall; i += 1) {
      px(ox + 2, potTop - 1 - i, P.leaf, 2, 1);
      if (i % 2 === 0)
        px(ox + (i % 4 === 0 ? 0 : 4), potTop - 1 - i, P.leafLit, 2, 1);
    }
    if (tall > 3) px(ox + 1, potTop - tall - 1, P.bloom, 3, 2);
  }

  /* Erase upward, so the yard emerges from the panel rather than starting at a
     line across it. */
  c.globalCompositeOperation = "destination-out";
  const up = c.createLinearGradient(0, 0, 0, SOLID);
  up.addColorStop(0, "rgba(0,0,0,1)");
  up.addColorStop(0.5, "rgba(0,0,0,0.92)");
  up.addColorStop(0.82, "rgba(0,0,0,0.4)");
  up.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = up;
  c.fillRect(0, 0, W, SOLID);
  c.globalCompositeOperation = "source-over";
}

export function PixelYard() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paint(ref.current);
  }, []);
  // No inline size: the canvas has an intrinsic 56x46, so `width: 100%` with
  // `height: auto` scales it to the panel and keeps the pixels square. A fixed
  // W * PIXEL would be wider than the drawer once its padding is counted.
  return <canvas ref={ref} className="pixel-yard" aria-hidden="true" />;
}
