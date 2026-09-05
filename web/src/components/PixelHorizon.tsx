import { useEffect, useRef } from "react";

/**
 * The far edge of town, at the foot of a working page.
 *
 * This replaces the band that used to close the dashboard and the docs. That
 * band was a hard-edged rectangle with its own sky colour, dropped in directly
 * under whatever the page ended with — on the settings screen it landed flush
 * against the Save button, and a strip of blue butted up against a form control
 * reads as a sticker no matter what is drawn on it.
 *
 * So this has no edge. The alpha ramps to nothing on the way up, which means
 * there is no line where the page stops and the picture starts; it just gets
 * greener towards the bottom of the scroll. It is also full-bleed and flush
 * with the very bottom of the page, so the ground is the end of the document
 * rather than an object sitting near it.
 *
 * Quieter than the market, too. This is the horizon seen from the office: a
 * treeline, a few roofs among it, a field in front. Nothing to look at, which
 * is the point at the bottom of a page somebody is working on.
 */

const PIXEL = 4;
const ART = 44;
const GROUND = 30;
/** Full strength from here down; above it the art is being erased. */
const SOLID = 26;

const P = {
  sky: "#cfe9f7",
  skyPale: "#e2f1fa",

  far: "#7f9a92",
  mid: "#557a6c",
  near: "#38574a",
  nearLit: "#456857",
  trunk: "#5b4433",

  roof: "#b06a4c",
  roofDark: "#8c5138",
  wall: "#e6dac2",
  wallShade: "#cdbf9f",

  field: "#8fae5f",
  fieldLit: "#a3c06d",
  fieldDark: "#6f8f4a",
  hedge: "#4d6b3c",
} as const;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function hash(n: number, seed: number): number {
  let h = (n * 374761393 + seed * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function paint(canvas: HTMLCanvasElement, w: number) {
  const c = canvas.getContext("2d");
  if (!c) return;
  canvas.width = w;
  canvas.height = ART;
  c.clearRect(0, 0, w, ART);
  c.imageSmoothingEnabled = false;
  const px = (x: number, y: number, fill: string, dw = 1, dh = 1) => {
    c.fillStyle = fill;
    c.fillRect(Math.round(x), Math.round(y), dw, dh);
  };

  // Sky. Flat, with the seam dithered — a full-height dither at this grid is a
  // checkerboard, not air.
  px(0, 0, P.skyPale, w, GROUND);
  for (let y = 0; y < 10; y += 1)
    for (let x = 0; x < w; x += 1)
      if (1 - y / 10 > BAYER[(y % 4) * 4 + (x % 4)]! / 16) px(x, y, P.sky);

  // A roof or two, back among the trees rather than in front of them.
  for (let bx = 2; bx < w; bx += 26 + Math.floor(hash(bx, 3) * 22)) {
    const bw = 8 + Math.floor(hash(bx, 4) * 6);
    const bh = 5 + Math.floor(hash(bx, 5) * 3);
    const top = GROUND - 4 - bh;
    px(bx, top + 2, P.wallShade, bw, bh);
    px(bx + 1, top + 3, P.wall, bw - 2, bh - 1);
    for (let i = 0; i < 3; i += 1)
      px(bx - 1 + i, top + i, P.roof, bw + 2 - i * 2, 1);
    px(bx - 1, top + 2, P.roofDark, bw + 2, 1);
  }

  // The treeline: two depths, the nearer one darker and taller.
  for (const layer of [
    { seed: 11, body: P.far, r: 3, base: GROUND - 4, step: 4 },
    { seed: 29, body: P.mid, r: 4, base: GROUND - 3, step: 5 },
    { seed: 53, body: P.near, r: 5, base: GROUND - 1, step: 7 },
  ]) {
    for (let tx = -3; tx < w + 5;) {
      const r = layer.r + Math.floor(hash(tx, layer.seed) * 3);
      const cy = layer.base - r + 1;
      px(tx - 1, cy, P.trunk, 2, GROUND - cy);
      for (let dy = -r; dy <= r; dy += 1) {
        const span = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
        if (cy + dy >= 0) px(tx - span, cy + dy, layer.body, span * 2 + 1, 1);
      }
      if (layer.body === P.near) {
        for (let dy = -r; dy <= -1; dy += 1) {
          const span = Math.floor(
            Math.sqrt(Math.max(0, r * r - dy * dy)) * 0.55,
          );
          if (cy + dy >= 0)
            px(tx - span - 1, cy + dy, P.nearLit, Math.max(1, span), 1);
        }
      }
      tx += layer.step + Math.floor(hash(tx, layer.seed + 1) * 4);
    }
  }

  // A hedge along the field's far side, then the field itself.
  px(0, GROUND - 2, P.hedge, w, 2);
  px(0, GROUND, P.field, w, ART - GROUND);
  px(0, GROUND + 4, P.fieldLit, w, ART - GROUND - 4);
  for (let y = GROUND + 2; y < GROUND + 4; y += 1)
    for (let x = 0; x < w; x += 1)
      if ((y - GROUND - 2) / 2 > BAYER[(y % 4) * 4 + (x % 4)]! / 16)
        px(x, y, P.fieldLit);
  // Furrows, faint, so the field is ploughed rather than painted.
  for (let x = 0; x < w; x += 1)
    if (hash(x, 71) > 0.72)
      px(x, GROUND + 5 + Math.floor(hash(x, 72) * 6), P.fieldDark, 4, 1);

  /* No top edge anywhere: erase upward on a ramp so the picture arrives out of
     the page instead of starting at a line. */
  c.globalCompositeOperation = "destination-out";
  const up = c.createLinearGradient(0, 0, 0, SOLID);
  up.addColorStop(0, "rgba(0,0,0,1)");
  up.addColorStop(0.55, "rgba(0,0,0,0.95)");
  up.addColorStop(0.85, "rgba(0,0,0,0.45)");
  up.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = up;
  c.fillRect(0, 0, w, SOLID);
  c.globalCompositeOperation = "source-over";
}

export function PixelHorizon() {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = wrap.current;
    const canvas = ref.current;
    if (!host || !canvas) return;
    let key = "";
    const layout = () => {
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      // A fixed pixel size with a variable grid, like every other pixel surface
      // here: the art keeps its chunk at any width instead of stretching.
      const w = Math.max(40, Math.min(460, Math.round(rect.width / PIXEL)));
      if (`${w}` === key) return;
      key = `${w}`;
      paint(canvas, w);
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="pixel-horizon" ref={wrap} aria-hidden="true">
      <canvas ref={ref} className="pixel-horizon-canvas" />
    </div>
  );
}
