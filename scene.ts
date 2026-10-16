// Draws the pond, seen from above, at a low logical resolution that the browser
// scales up with `image-rendering: pixelated`. The strip is an illustration with
// its own palette per time of day and season, not themed app chrome.

import {
  bodyPoint,
  seededRng,
  type Drift,
  type Koi,
  type Pond,
  type Season,
  type TimeOfDay,
  type VarietyId,
} from "./koi.ts";

/** Logical pixels; the strip is SCENE_HEIGHT * PIXEL_SCALE CSS pixels tall. */
export const SCENE_HEIGHT = 32;
export const PIXEL_SCALE = 3;
/** First row of water below the bank. */
export const WATER_TOP = 7;
const LANTERN_MIN_WIDTH = 110;

// ---------------------------------------------------------------- colors

type Rgb = readonly [number, number, number];
const parsed = new Map<string, Rgb>();
const mixed = new Map<string, string>();

function rgb(hex: string): Rgb {
  let value = parsed.get(hex);
  if (!value) {
    const n = Number.parseInt(hex.slice(1), 16);
    value = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    parsed.set(hex, value);
  }
  return value;
}

/** Mixes two colors in twentieths, which keeps the palette small and pixel-y. */
function mix(a: string, b: string, t: number): string {
  const step = Math.round(Math.min(1, Math.max(0, t)) * 20);
  if (step === 0) return a;
  if (step === 20) return b;
  const key = `${a}${b}${step}`;
  let value = mixed.get(key);
  if (!value) {
    const [ar, ag, ab] = rgb(a);
    const [br, bg, bb] = rgb(b);
    const f = step / 20;
    const channel = (x: number, y: number) =>
      Math.round(x + (y - x) * f)
        .toString(16)
        .padStart(2, "0");
    value = `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
    mixed.set(key, value);
  }
  return value;
}

type Water = { top: string; bottom: string; sparkle: string; shadow: string };

const WATER: Record<TimeOfDay, Water> = {
  dawn: { top: "#6f98a0", bottom: "#2f5868", sparkle: "#ffe2bf", shadow: "#1f3a4a" },
  day: { top: "#56a7a3", bottom: "#1e5e6c", sparkle: "#e0f7f1", shadow: "#123e4a" },
  dusk: { top: "#5f7192", bottom: "#29375a", sparkle: "#f7bd86", shadow: "#18203a" },
  night: { top: "#1f3a4e", bottom: "#0b1a2a", sparkle: "#8fb6d6", shadow: "#050c16" },
};

/** How far land, pads, and koi fade into the light of each time of day. */
const DIM: Record<TimeOfDay, { color: string; amount: number }> = {
  dawn: { color: "#4a3a5e", amount: 0.15 },
  day: { color: "#000000", amount: 0 },
  dusk: { color: "#2e2444", amount: 0.3 },
  night: { color: "#08101e", amount: 0.55 },
};

type Land = {
  grass: string;
  grassDark: string;
  accents: readonly string[];
  stone: string;
  stoneLight: string;
  stoneDark: string;
  /** Snow on top of the stones. */
  cap: string | null;
  pad: string;
  padLight: string;
  padDark: string;
  lotus: boolean;
};

const STONES = { stone: "#a9a395", stoneLight: "#cfc9ba", stoneDark: "#7d786d" };

const LAND: Record<Season, Land> = {
  spring: {
    grass: "#78a85a",
    grassDark: "#5a8a45",
    accents: ["#f4b6c8", "#fbe0e8"],
    ...STONES,
    cap: null,
    pad: "#5d9a4e",
    padLight: "#7cb865",
    padDark: "#3f7438",
    lotus: true,
  },
  summer: {
    grass: "#5f9a48",
    grassDark: "#467a37",
    accents: ["#f2dc6a", "#ffffff"],
    ...STONES,
    cap: null,
    pad: "#4f9446",
    padLight: "#6fb35c",
    padDark: "#356b33",
    lotus: true,
  },
  autumn: {
    grass: "#a39a52",
    grassDark: "#80783e",
    accents: ["#d8622b", "#e9a23b", "#b8402a"],
    ...STONES,
    cap: null,
    pad: "#7f8f45",
    padLight: "#a0a957",
    padDark: "#5c6a33",
    lotus: false,
  },
  winter: {
    grass: "#e6ecef",
    grassDark: "#c9d4db",
    accents: ["#ffffff"],
    ...STONES,
    cap: "#f2f6f8",
    pad: "#6f8a6a",
    padLight: "#8aa384",
    padDark: "#52684f",
    lotus: false,
  },
};

const LOTUS = { petal: "#f2a3bc", tip: "#fde1ea", center: "#f3d36b" };
const LANTERN_LIGHT = "#ffd27a";
const FOOD = ["#c6824a", "#e8b070"];
const DRIFT_COLORS: Record<Drift["kind"], readonly string[]> = {
  petal: ["#f6b9c9", "#fcdde6", "#f19ab2"],
  leaf: ["#d9622b", "#e9a23b", "#b8402a"],
  snow: ["#ffffff", "#eef4f8", "#ffffff"],
  firefly: ["#eaf59b", "#f8f2a8", "#d9f08a"],
};

// 4x4 ordered dither, in sixteenths.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

function bayer(x: number, y: number): number {
  return BAYER[y & 3]![x & 3]! / 16;
}

// ---------------------------------------------------------------- koi

type KoiColors = { body: string; fin: string };

const WHITE = "#f4f0e6";
const RED = "#d9452b";
const BLACK = "#24211f";

function hash(seed: number, x: number, y: number): number {
  let h = (seed * 374761393 + x * 668265263 + y * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, for patches that follow the body. */
function noise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(seed, ix, iy) + (hash(seed, ix + 1, iy) - hash(seed, ix, iy)) * sx;
  const bottom =
    hash(seed, ix, iy + 1) + (hash(seed, ix + 1, iy + 1) - hash(seed, ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * One body pixel's color. `u` runs from the head (0) to the tail (1), `v` across
 * the body from one side (-1) to the other (1).
 */
function koiColor(koi: Koi, u: number, v: number, px: number, py: number): string {
  const seed = koi.seed;
  const patch = noise(seed, u * 4.5, v * 1.2 + 3);
  const fleck = noise(seed + 7, u * 7, v * 2 + 9);
  const across = Math.abs(v);
  const checker = (px + py) & 1;
  switch (koi.variety as VarietyId) {
    case "kohaku":
      return patch > 0.48 && u < 0.92 ? RED : WHITE;
    case "tancho":
      return Math.hypot((u - 0.14) * 3.2, v * 0.7) < 0.42 ? RED : WHITE;
    case "sanke":
      if (fleck > 0.72 && u > 0.2) return BLACK;
      return patch > 0.52 && u < 0.92 ? RED : WHITE;
    case "showa":
      if (patch > 0.5 && u < 0.9) return RED;
      return fleck > 0.58 ? WHITE : BLACK;
    case "ogon":
      return across < 0.3 ? "#f8db82" : "#e5ad3e";
    case "yamabuki":
      return across < 0.3 ? "#fde98f" : "#efcb45";
    case "asagi":
      if (u < 0.12) return "#d6e0e4";
      if (across > 0.62) return "#e07a3a";
      return checker ? "#5f7f99" : "#7898b0";
    case "chagoi":
      if (across < 0.25) return "#b88552";
      return checker ? "#94643a" : "#a87645";
    case "shiro-utsuri":
      return patch > 0.46 ? WHITE : BLACK;
    case "kumonryu":
      return noise(seed + 3, u * 6, v * 1.6) > 0.5 ? WHITE : BLACK;
  }
}

function koiFin(koi: Koi): string {
  switch (koi.variety) {
    case "ogon":
      return "#f2c862";
    case "yamabuki":
      return "#f7dc72";
    case "chagoi":
      return "#c49464";
    case "showa":
    case "shiro-utsuri":
    case "kumonryu":
      return "#5a5651";
    case "asagi":
      return "#e89a62";
    default:
      return "#fbf6ee";
  }
}

/** Half-width of the body at `u`: a rounded head, broad shoulders, slim tail. */
function radiusAt(u: number): number {
  if (u < 0.12) return 1.5 + (u / 0.12) * 0.9;
  if (u < 0.33) return 2.4 + ((u - 0.12) / 0.21) * 0.35;
  return 2.75 - ((u - 0.33) / 0.67) * 2.1;
}

type KoiPixels = Map<number, KoiColors["body"]>;
const KEY_WIDTH = 1 << 14;
const KEY_OFFSET = 64;
const keyOf = (x: number, y: number) => (y + KEY_OFFSET) * KEY_WIDTH + (x + KEY_OFFSET);
const xOf = (key: number) => (key % KEY_WIDTH) - KEY_OFFSET;
const yOf = (key: number) => Math.floor(key / KEY_WIDTH) - KEY_OFFSET;

/** Rasterizes one koi: tail and fins first, so the body and head sit on top. */
function rasterizeKoi(koi: Koi): KoiPixels {
  const pixels: KoiPixels = new Map();
  const length = koi.length;
  const fin = koiFin(koi);
  const sway = (u: number) => Math.sin(koi.phase - u * 3.2) * 0.7 * u * u;

  // Tail: a fan that opens behind the body and sways a beat after it.
  const tail = bodyPoint(koi, length);
  const before = bodyPoint(koi, length - 1);
  const back = unit(tail.x - before.x, tail.y - before.y);
  const side = { x: -back.y, y: back.x };
  const flick = Math.sin(koi.phase - 3.6) * 0.9;
  for (let k = 0.5; k <= 3.5; k += 0.5) {
    const spread = 0.5 + k * 0.6;
    for (let across = -spread; across <= spread; across += 0.5) {
      // A shallow notch in the middle of the fan's trailing edge.
      if (k > 2.5 && Math.abs(across) < 0.8) continue;
      const x = Math.floor(tail.x + back.x * k + side.x * (across + flick * (k / 3.5)));
      const y = Math.floor(tail.y + back.y * k + side.y * (across + flick * (k / 3.5)));
      pixels.set(keyOf(x, y), fin);
    }
  }

  // Pectoral fins, which beat slowly.
  const shoulder = bodyPoint(koi, length * 0.22);
  const ahead = bodyPoint(koi, length * 0.22 - 1);
  const forward = unit(ahead.x - shoulder.x, ahead.y - shoulder.y);
  const normal = { x: -forward.y, y: forward.x };
  const beat = Math.sin(koi.phase * 0.7) * 0.5 + 0.5;
  for (const sign of [-1, 1]) {
    for (let k = 0; k <= 1.5; k += 0.5) {
      const reach = radiusAt(0.22) + 0.4 + k * (0.6 + beat * 0.4);
      const x = Math.floor(shoulder.x + normal.x * sign * reach - forward.x * (k + 0.5));
      const y = Math.floor(shoulder.y + normal.y * sign * reach - forward.y * (k + 0.5));
      pixels.set(keyOf(x, y), fin);
    }
  }

  for (let s = length; s >= 0; s -= 0.5) {
    const u = s / length;
    const point = bodyPoint(koi, s);
    const next = bodyPoint(koi, Math.max(0, s - 0.75));
    const direction = s === 0 ? { x: Math.cos(koi.heading), y: Math.sin(koi.heading) } : unit(next.x - point.x, next.y - point.y);
    const across = { x: -direction.y, y: direction.x };
    const offset = sway(u);
    const cx = point.x + across.x * offset;
    const cy = point.y + across.y * offset;
    const r = radiusAt(u);
    for (let py = Math.floor(cy - r - 1); py <= Math.ceil(cy + r); py++) {
      for (let px = Math.floor(cx - r - 1); px <= Math.ceil(cx + r); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy > r * r + 0.15) continue;
        const v = (dx * across.x + dy * across.y) / Math.max(0.6, r);
        let color = koiColor(koi, u, v, px, py);
        // A little roundness: the flanks sit in shade.
        if (Math.abs(v) > 0.78) color = mix(color, "#000000", 0.18);
        pixels.set(keyOf(px, py), color);
      }
    }
  }
  return pixels;
}

function unit(x: number, y: number) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

export type KoiStyle = {
  /** The water the koi swims in, for depth and fins. */
  water: string;
  shadow: string | null;
  dim: { color: string; amount: number };
  /** Rows above this stay empty (the bank, or air above a rising flood). */
  clipTop: number;
  alpha: number;
};

export function drawKoi(ctx: CanvasRenderingContext2D, koi: Koi, style: KoiStyle) {
  const pixels = rasterizeKoi(koi);
  const fin = koiFin(koi);
  if (style.shadow) {
    const lift = 1 - koi.depth;
    const ox = Math.round(1 + lift);
    const oy = Math.round(1 + lift * 1.5);
    ctx.globalAlpha = 0.3 * (1 - koi.depth * 0.6) * style.alpha;
    ctx.fillStyle = style.shadow;
    for (const key of pixels.keys()) {
      const y = yOf(key) + oy;
      if (y >= style.clipTop) ctx.fillRect(xOf(key) + ox, y, 1, 1);
    }
  }
  ctx.globalAlpha = style.alpha;
  for (const [key, color] of pixels) {
    const y = yOf(key);
    if (y < style.clipTop) continue;
    let shade = color === fin ? mix(color, style.water, 0.35) : color;
    shade = mix(shade, style.water, koi.depth * 0.55);
    if (style.dim.amount > 0) shade = mix(shade, style.dim.color, style.dim.amount * 0.6);
    ctx.fillStyle = shade;
    ctx.fillRect(xOf(key), y, 1, 1);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- the strip

export type DrawInput = {
  pond: Pond;
  season: Season;
  timeOfDay: TimeOfDay;
  now: number;
};

export class PondScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #base = document.createElement("canvas");
  readonly #pads = document.createElement("canvas");
  #cacheKey = "";
  width = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d")!;
  }

  /** Matches the logical width to the strip's CSS width and returns it. */
  resize(cssWidth: number): number {
    const width = Math.max(40, Math.ceil(cssWidth / PIXEL_SCALE));
    if (width !== this.width) {
      this.width = width;
      this.#canvas.width = width;
      this.#canvas.height = SCENE_HEIGHT;
      this.#cacheKey = "";
    }
    return width;
  }

  /** Where a click on the strip lands, in pond pixels. */
  toPond(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / Math.max(1, rect.width)) * this.width,
      y: ((clientY - rect.top) / Math.max(1, rect.height)) * SCENE_HEIGHT,
    };
  }

  draw({ pond, season, timeOfDay, now }: DrawInput) {
    const ctx = this.#ctx;
    const width = this.width;
    const water = WATER[timeOfDay];
    const dim = DIM[timeOfDay];
    const land = LAND[season];
    const key = `${width}:${season}:${timeOfDay}`;
    if (key !== this.#cacheKey) {
      this.#cacheKey = key;
      paintBase(this.#base, width, water, land, dim, timeOfDay);
      paintPads(this.#pads, width, land, dim);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.drawImage(this.#base, 0, 0);

    drawSparkles(ctx, width, SCENE_HEIGHT, WATER_TOP + 2, water.sparkle, now);
    const lantern = lanternX(width);
    if (lantern !== null && timeOfDay !== "day") {
      drawGlow(ctx, lantern + 3, WATER_TOP + 2, 7, LANTERN_LIGHT, 0.16, now, WATER_TOP);
    }

    const style: KoiStyle = {
      water: water.bottom,
      shadow: water.shadow,
      dim,
      clipTop: WATER_TOP,
      alpha: 1,
    };
    const byDepth = [...pond.koi].sort((a, b) => b.depth - a.depth);
    for (const koi of byDepth) drawKoi(ctx, koi, style);

    for (const food of pond.food) {
      ctx.globalAlpha = Math.max(0.2, 1 - food.ageMs / 30_000);
      ctx.fillStyle = FOOD[(food.id & 1) as 0 | 1]!;
      ctx.fillRect(Math.round(food.x), Math.round(food.y), 1, 1);
    }
    ctx.globalAlpha = 1;

    ctx.drawImage(this.#pads, 0, 0);
    drawRipples(ctx, pond, water.sparkle, WATER_TOP);
    drawDrifts(ctx, pond, now, WATER_TOP);
  }
}

function lanternX(width: number): number | null {
  return width >= LANTERN_MIN_WIDTH ? width - 24 : null;
}

function paintBase(
  canvas: HTMLCanvasElement,
  width: number,
  water: Water,
  land: Land,
  dim: { color: string; amount: number },
  time: TimeOfDay,
) {
  canvas.width = width;
  canvas.height = SCENE_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  const dimmed = (color: string) => mix(color, dim.color, dim.amount);
  const px = (x: number, y: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  };

  // Water: four bands, dithered into each other.
  const stops = [0, 1, 2, 3].map((i) => mix(water.top, water.bottom, i / 3));
  const rows = SCENE_HEIGHT - WATER_TOP;
  for (let y = WATER_TOP; y < SCENE_HEIGHT; y++) {
    const t = (y - WATER_TOP) / Math.max(1, rows - 1);
    for (let x = 0; x < width; x++) {
      const level = Math.max(0, Math.min(3, Math.round(t * 3 + bayer(x, y) - 0.5)));
      let color = stops[level]!;
      // The bank's shade on the water right below it.
      if (y < WATER_TOP + 2) color = mix(color, water.shadow, y === WATER_TOP ? 0.45 : 0.2);
      px(x, y, color);
    }
  }

  // Grass along the bank.
  const grass = dimmed(land.grass);
  const grassDark = dimmed(land.grassDark);
  for (let y = 0; y < WATER_TOP; y++) {
    for (let x = 0; x < width; x++) {
      px(x, y, bayer(x, y) < 0.3 ? grassDark : grass);
    }
  }
  const rng = seededRng(width * 31 + 7);
  for (let index = 0; index < width / 6; index++) {
    const color = land.accents[Math.floor(rng() * land.accents.length)]!;
    px(Math.floor(rng() * width), Math.floor(rng() * 3), dimmed(color));
  }

  // A row of rounded stones at the water's edge.
  const stone = dimmed(land.stone);
  const stoneLight = dimmed(land.stoneLight);
  const stoneDark = dimmed(land.stoneDark);
  const cap = land.cap ? dimmed(land.cap) : null;
  let x = -2 - Math.floor(rng() * 3);
  while (x < width) {
    const w = 4 + Math.floor(rng() * 6);
    const h = 3 + Math.floor(rng() * 2);
    const top = WATER_TOP - h + 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const corner = (dy === 0 || dy === h - 1) && (dx === 0 || dx === w - 1);
        if (corner) continue;
        let color = stone;
        if (dy === 0) color = cap ?? stoneLight;
        else if (dy === h - 1 || dx === w - 1) color = stoneDark;
        else if (dx === 0) color = stoneLight;
        px(x + dx, top + dy, color);
      }
    }
    x += w + Math.floor(rng() * 3);
  }

  const lantern = lanternX(width);
  if (lantern !== null) paintLantern(ctx, lantern, land, dimmed, time);
}

/** A small stone lantern on the bank, lit from dusk to dawn. */
function paintLantern(
  ctx: CanvasRenderingContext2D,
  left: number,
  land: Land,
  dimmed: (color: string) => string,
  time: TimeOfDay,
) {
  const stone = dimmed(land.stone);
  const light = dimmed(land.stoneLight);
  const dark = dimmed(land.stoneDark);
  const lit = time !== "day";
  const window = lit ? LANTERN_LIGHT : dimmed("#4a4740");
  // Rows top to bottom; a space leaves the bank showing through.
  const shape = [
    "  LLL  ",
    "LLLLLLL",
    " DWWWD ",
    "SSSSSSS",
    "  SDS  ",
    " SSSSD ",
    " DDDDD ",
  ];
  const colors: Record<string, string> = {
    L: land.cap ? dimmed(land.cap) : light,
    S: stone,
    D: dark,
    W: window,
  };
  shape.forEach((row, dy) => {
    [...row].forEach((cell, dx) => {
      const color = colors[cell];
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(left + dx, dy, 1, 1);
    });
  });
}

function paintPads(
  canvas: HTMLCanvasElement,
  width: number,
  land: Land,
  dim: { color: string; amount: number },
) {
  canvas.width = width;
  canvas.height = SCENE_HEIGHT;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, SCENE_HEIGHT);
  const dimmed = (color: string) => mix(color, dim.color, dim.amount);
  const rng = seededRng(width * 13 + 101);
  const count = Math.max(2, Math.floor(width / 70));
  for (let index = 0; index < count; index++) {
    const cx = ((index + 0.5) * width) / count + (rng() - 0.5) * 30;
    const cy = WATER_TOP + 6 + rng() * (SCENE_HEIGHT - WATER_TOP - 10);
    const radius = 3.6 + rng() * 1.6;
    paintPad(ctx, cx, cy, radius, rng() * Math.PI * 2, land, dimmed);
    // A smaller pad alongside, now and then.
    if (rng() < 0.6) {
      const angle = rng() * Math.PI * 2;
      const gap = radius + 2.5;
      paintPad(
        ctx,
        cx + Math.cos(angle) * gap,
        cy + Math.sin(angle) * gap * 0.8,
        1.8 + rng(),
        rng() * Math.PI * 2,
        land,
        dimmed,
      );
    }
    const flower = rng();
    if (land.lotus && flower < 0.75) {
      paintLotus(ctx, Math.round(cx - 0.5), Math.round(cy - 0.5), flower < 0.5, dimmed);
    }
  }
}

function paintPad(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  notch: number,
  land: Land,
  dimmed: (color: string) => string,
) {
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius); y++) {
    if (y < WATER_TOP + 1) continue;
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const angle = Math.atan2(Math.sin(Math.atan2(dy, dx) - notch), Math.cos(Math.atan2(dy, dx) - notch));
      if (Math.abs(angle) < 0.35 && distance > 0.8) continue;
      let color = land.pad;
      if (distance > radius - 1) color = dx + dy > 0 ? land.padDark : land.padLight;
      ctx.fillStyle = dimmed(color);
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function paintLotus(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  bloom: boolean,
  dimmed: (color: string) => string,
) {
  const shape = bloom
    ? ["  T  ", " TPT ", "TPCPT", " TPT ", "  T  "]
    : [" T ", "TPT", " P "];
  const colors: Record<string, string> = { T: LOTUS.tip, P: LOTUS.petal, C: LOTUS.center };
  const half = Math.floor(shape.length / 2);
  shape.forEach((row, dy) => {
    [...row].forEach((cell, dx) => {
      const color = colors[cell];
      if (!color) return;
      // Flowers catch what light there is, so they dim half as much.
      ctx.fillStyle = mix(color, dimmed(color), 0.5);
      ctx.fillRect(x - half + dx, y - half + dy, 1, 1);
    });
  });
}

function drawSparkles(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  top: number,
  color: string,
  now: number,
) {
  const count = Math.max(4, Math.floor(width / 12));
  ctx.fillStyle = color;
  for (let index = 0; index < count; index++) {
    const a = hash(17, index, 1);
    const b = hash(17, index, 2);
    const c = hash(17, index, 3);
    const twinkle = Math.sin(now * 0.0016 * (0.6 + b) + index * 1.7);
    if (twinkle < 0.55) continue;
    const x = Math.floor((a * width + now * 0.003 * (0.4 + c)) % width);
    const y = Math.floor(top + c * (height - top - 2) + Math.sin(now * 0.0006 + index));
    ctx.globalAlpha = Math.min(0.75, (twinkle - 0.55) * 2.2);
    ctx.fillRect(x, y, twinkle > 0.88 ? 2 : 1, 1);
  }
  ctx.globalAlpha = 1;
}

function drawGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  strength: number,
  now: number,
  clipTop: number,
) {
  const flicker = 0.85 + Math.sin(now * 0.0031) * 0.08 + Math.sin(now * 0.0117) * 0.05;
  ctx.fillStyle = color;
  for (let ring = radius; ring >= 1; ring -= 2) {
    ctx.globalAlpha = strength * flicker * (1 - ring / (radius + 1)) * 0.6;
    for (let y = Math.floor(cy - ring); y <= cy + ring; y++) {
      if (y < clipTop) continue;
      const half = Math.floor(Math.sqrt(Math.max(0, ring * ring - (y - cy) ** 2)) * 1.3);
      ctx.fillRect(Math.round(cx - half), y, half * 2 + 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

function drawRipples(ctx: CanvasRenderingContext2D, pond: Pond, color: string, clipTop: number) {
  ctx.fillStyle = color;
  for (const ripple of pond.ripples) {
    const radius = (ripple.ageMs / 1000) * ripple.speed;
    if (radius < 0.5) continue;
    const fade = 1 - radius / ripple.maxRadius;
    const drawn = new Set<number>();
    const ring = (r: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      const steps = Math.max(8, Math.ceil(r * 7));
      for (let index = 0; index < steps; index++) {
        const angle = (index / steps) * Math.PI * 2;
        const x = Math.round(ripple.x + Math.cos(angle) * r);
        const y = Math.round(ripple.y + Math.sin(angle) * r * 0.8);
        const key = keyOf(x, y);
        if (y < clipTop || drawn.has(key)) continue;
        drawn.add(key);
        ctx.fillRect(x, y, 1, 1);
      }
    };
    ring(radius, fade * 0.7);
    if (radius > 3) ring(radius - 2.5, fade * 0.3);
  }
  ctx.globalAlpha = 1;
}

function drawDrifts(ctx: CanvasRenderingContext2D, pond: Pond, now: number, clipTop: number) {
  for (const drift of pond.drifts) {
    const colors = DRIFT_COLORS[drift.kind];
    const color = colors[drift.tint % colors.length]!;
    const x = Math.round(drift.x);
    const y = Math.round(drift.y);
    const remaining = drift.lifeMs - drift.ageMs;
    const fade = drift.landed || drift.kind === "firefly" ? Math.min(1, remaining / 3_000) : 1;
    if (drift.kind === "firefly") {
      const blink = Math.sin(now * 0.004 + drift.tint * 2 + drift.x) * 0.5 + 0.5;
      const appear = Math.min(1, drift.ageMs / 1_500) * fade;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18 * blink * appear;
      ctx.fillRect(x - 1, y - 1, 3, 3);
      ctx.globalAlpha = (0.35 + 0.65 * blink) * appear;
      ctx.fillRect(x, y, 1, 1);
      continue;
    }
    // In the air, falling things skip the bank's clip; on the water they float.
    if (drift.landed && y < clipTop) continue;
    ctx.globalAlpha = fade * (drift.landed ? 0.9 : 1);
    ctx.fillStyle = color;
    if (drift.kind === "snow") {
      ctx.fillRect(x, y, 1, 1);
    } else if (drift.kind === "petal") {
      const flip = Math.floor((drift.ageMs + drift.tint * 400) / 600) & 1;
      ctx.fillRect(x, y, flip ? 2 : 1, flip ? 1 : 2);
    } else {
      ctx.fillRect(x, y, 2, 1);
      ctx.fillRect(x + (drift.tint & 1), y + 1, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- the flood

export type UnderwaterInput = {
  pond: Pond;
  /** How full the chat input is, from 0 to 1. */
  level: number;
  dark: boolean;
  now: number;
};

const FLOOD_WATER = {
  light: { top: "#bfe4df", bottom: "#93cdc8", sparkle: "#ffffff", alpha: 0.5, koi: 0.45 },
  dark: { top: "#1d4a52", bottom: "#0f2d35", sparkle: "#9fd4d8", alpha: 0.55, koi: 0.5 },
};

/** The water inside the chat input: calm, pale, and quiet behind the text. */
export class UnderwaterScene {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d")!;
  }

  resize(cssWidth: number, cssHeight: number) {
    const width = Math.max(8, Math.ceil(cssWidth / PIXEL_SCALE));
    const height = Math.max(4, Math.ceil(cssHeight / PIXEL_SCALE));
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
  }

  draw({ pond, level, dark, now }: UnderwaterInput) {
    const ctx = this.#ctx;
    const { width, height } = this;
    const look = dark ? FLOOD_WATER.dark : FLOOD_WATER.light;
    ctx.clearRect(0, 0, width, height);
    const surface = Math.round(height - level * height);
    if (surface >= height) return;

    ctx.globalAlpha = look.alpha;
    const stops = [0, 1, 2].map((i) => mix(look.top, look.bottom, i / 2));
    for (let y = surface; y < height; y++) {
      const t = (y - surface) / Math.max(1, height - surface - 1);
      for (let x = 0; x < width; x += 1) {
        const band = Math.max(0, Math.min(2, Math.round(t * 2 + bayer(x, y) - 0.5)));
        ctx.fillStyle = stops[band]!;
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // The surface, a lighter line that sways a little while the water moves.
    ctx.fillStyle = look.sparkle;
    for (let x = 0; x < width; x++) {
      const y = surface + Math.round(Math.sin(x * 0.18 + now * 0.0015) * 0.6);
      if (y < height) {
        ctx.globalAlpha = look.alpha * 0.9;
        ctx.fillRect(x, Math.max(surface, y), 1, 1);
      }
    }
    ctx.globalAlpha = 1;

    drawSparkles(ctx, width, height, surface + 2, look.sparkle, now);
    // Koi in a wash of water: softer, so the text above stays easy to read.
    const style: KoiStyle = {
      water: look.bottom,
      shadow: null,
      dim: { color: look.bottom, amount: 0.4 },
      clipTop: surface + 1,
      alpha: look.koi,
    };
    for (const koi of pond.koi) drawKoi(ctx, koi, style);
  }
}
