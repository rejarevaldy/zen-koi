// Paints the pond, seen from above, at a low logical resolution that the
// browser scales up with `image-rendering: pixelated`. One painter serves one
// pond world; each canvas (the strip, the chat input, the pond page) paints its
// own band of rows from it, so the water runs on from one into the next.

import { bodyPoint, seededRng, WAKE_MS, type Drift, type Koi, type Pond, type Region } from "./koi.ts";
import { BITE_MS, POI_RADIUS, type Sukui } from "./sukui.ts";
import type { PondConfig, Season, TimeOfDay, Weather } from "./config.ts";

/** CSS pixels per pond pixel. */
export const PIXEL_SCALE = 3;
/** Height of the strip above the chat input, in pond pixels. */
export const STRIP_ROWS = 32;
/** The shore never reaches below this row, and koi stay below it. */
export const SHORE_ROWS = 8;
/** Rows over which the water goes from shallow to deep. */
const DEPTH_RANGE = 22;
const LANTERN_MIN_WIDTH = 110;
const WORLD_SEED = 20_241;
/** Sunlight on the bed and leaf shade move slowly, so they are redrawn only this often. */
const LIGHT_REFRESH_MS = 100;

export type Environment = {
  /** The pond's shape: shoreline, stones, pads, plants, and which side the tree is on. */
  seed: number;
  season: Season;
  time: TimeOfDay;
  weather: Weather;
  /** How hard it rains right now: 0 when clear, else 0.3 to 1. */
  rain: number;
  garden: PondConfig["garden"];
};

/**
 * A wash of the page's background over the water, so text in the chat input
 * stays readable. It ramps in from `start` to full strength at `full`; the
 * strip and the chat input share the same ramp, so their seam disappears.
 */
export type Scrim = { color: string; alpha: number; start: number; full: number };

export type View = { y0: number; rows: number; scrim: Scrim | null };

// ---------------------------------------------------------------- color

type Rgb = readonly [number, number, number];
const parsed = new Map<string, Rgb>();
/** Mixed colors by first color, then second, then step: no string keys on the hot path. */
const mixed = new Map<string, Map<string, string[]>>();

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
export function mix(a: string, b: string, t: number): string {
  const step = Math.round(Math.min(1, Math.max(0, t)) * 20);
  if (step === 0) return a;
  if (step === 20) return b;
  let byB = mixed.get(a);
  if (!byB) mixed.set(a, (byB = new Map()));
  let steps = byB.get(b);
  if (!steps) byB.set(b, (steps = []));
  let value = steps[step];
  if (!value) {
    const [ar, ag, ab] = rgb(a);
    const [br, bg, bb] = rgb(b);
    const f = step / 20;
    const channel = (x: number, y: number) =>
      Math.round(x + (y - x) * f)
        .toString(16)
        .padStart(2, "0");
    value = `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
    steps[step] = value;
  }
  return value;
}

type Light = {
  /** Water from the shallows to the deepest part. */
  water: readonly string[];
  sparkle: string;
  shade: string;
  /** How strongly sunlight ripples across the bed. */
  caustics: number;
  /** Land, pads, and trees fade toward this. */
  dim: string;
  dimAmount: number;
};

const LIGHT: Record<TimeOfDay, Light> = {
  dawn: {
    water: ["#a9cfc0", "#80b1aa", "#5f949a", "#477889", "#365f74", "#294b60"],
    sparkle: "#ffe8c8",
    shade: "#1d3346",
    caustics: 0.1,
    dim: "#5a4668",
    dimAmount: 0.14,
  },
  day: {
    water: ["#93d4c2", "#64b8ab", "#43999c", "#2e7c89", "#226474", "#194f60"],
    sparkle: "#f2fff8",
    shade: "#0c2f3a",
    caustics: 0.13,
    dim: "#000000",
    dimAmount: 0,
  },
  dusk: {
    water: ["#b49aa6", "#8a7f9d", "#67688f", "#4d557c", "#3b4468", "#2c3454"],
    sparkle: "#ffcf96",
    shade: "#1a1a34",
    caustics: 0.06,
    dim: "#3a2a4e",
    dimAmount: 0.28,
  },
  night: {
    water: ["#355466", "#2a4658", "#213a4b", "#192f3e", "#122533", "#0c1b28"],
    sparkle: "#b4d0ee",
    shade: "#050c16",
    caustics: 0,
    dim: "#0a1424",
    dimAmount: 0.55,
  },
};

const RAIN_TINT = "#45535e";

type Land = {
  grass: readonly [string, string, string];
  edge: string;
  flowers: readonly string[];
  stone: readonly [string, string, string];
  /** Snow on top of the stones. */
  cap: string | null;
  pad: readonly [string, string, string];
  lotus: boolean;
  canopy: readonly string[];
  branch: string;
};

const STONE = ["#c9c2b2", "#a39c8d", "#77716a"] as const;

const LAND: Record<Season, Land> = {
  spring: {
    grass: ["#8fbf68", "#76a856", "#5c8d45"],
    edge: "#4b6b37",
    flowers: ["#f6bfd0", "#fde6ee", "#ffffff"],
    stone: STONE,
    cap: null,
    pad: ["#7cbc63", "#5b9c4c", "#3f773a"],
    lotus: true,
    canopy: ["#fbe1ea", "#f5bccd", "#e895ae", "#c97690"],
    branch: "#5a3e38",
  },
  summer: {
    grass: ["#7ab55a", "#5f9a48", "#467a37"],
    edge: "#3b5f2d",
    flowers: ["#f4de6c", "#ffffff"],
    stone: STONE,
    cap: null,
    pad: ["#72b65d", "#519748", "#357033"],
    lotus: true,
    canopy: ["#a7d77c", "#7dbd5c", "#5a9a45", "#3d7535"],
    branch: "#4f3a2c",
  },
  autumn: {
    grass: ["#b8aa60", "#9c8f4b", "#7c723b"],
    edge: "#5f5630",
    flowers: ["#d8622b", "#e9a23b", "#b8402a"],
    stone: STONE,
    cap: null,
    pad: ["#a9ad5a", "#868d45", "#636a33"],
    lotus: false,
    canopy: ["#f6c35a", "#ee9238", "#d9602a", "#a83c24"],
    branch: "#4d3527",
  },
  winter: {
    grass: ["#f4f7f9", "#e1e8ee", "#c8d3dc"],
    edge: "#9fb0bd",
    flowers: ["#ffffff"],
    stone: STONE,
    cap: "#f6f9fb",
    pad: ["#8aa384", "#6f8a6a", "#52684f"],
    lotus: false,
    canopy: [],
    branch: "#4a3a34",
  },
};

const LOTUS = { tip: "#fde3ec", petal: "#f3a6bf", deep: "#dc7f9d", heart: "#f4d36a" };
const LANTERN_LIGHT = "#ffd27a";
const SAND = "#d8c79a";
const FOOD = ["#c6824a", "#e8b070"] as const;
const POI = { frame: "#e4473d", frameLight: "#f58a80", paper: "#f6f2e8" };
const BOWL = { rim: "#a8743f", rimLight: "#d09a5e", rimDark: "#7a4f28" };
const DRIFT_COLORS: Record<Drift["kind"], readonly string[]> = {
  petal: ["#f6b9c9", "#fcdde6", "#f19ab2"],
  leaf: ["#d9622b", "#e9a23b", "#b8402a"],
  snow: ["#ffffff", "#eef4f8", "#ffffff"],
  firefly: ["#eaf59b", "#f8f2a8", "#d9f08a"],
};

// ---------------------------------------------------------------- noise

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

/** 4x4 ordered dither threshold in [0, 1). */
function bayer(x: number, y: number): number {
  return BAYER[y & 3]![x & 3]! / 16;
}

function hash(seed: number, x: number, y: number): number {
  let h = (seed * 374761393 + x * 668265263 + y * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
function noise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(seed, ix, iy);
  const b = hash(seed, ix + 1, iy);
  const c = hash(seed, ix, iy + 1);
  const d = hash(seed, ix + 1, iy + 1);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}

function clampInt(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.round(value)));
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function plot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

// ---------------------------------------------------------------- koi

const WHITE = "#f6f2e9";
const RED = "#d8432c";
const DEEP_RED = "#b3341f";
const BLACK = "#252220";

/**
 * One body pixel's color. `u` runs from the head (0) to the tail (1), `v` across
 * the body from one side (-1) to the other (1).
 */
function koiColor(koi: Koi, u: number, v: number, px: number, py: number): string {
  const seed = koi.seed;
  const patch = noise(seed, u * 4.2, v * 1.1 + 3);
  const fleck = noise(seed + 7, u * 7, v * 2 + 9);
  const across = Math.abs(v);
  const scale = (px + py) & 1;
  switch (koi.variety) {
    case "kohaku":
      if (u < 0.08) return WHITE;
      return patch > 0.47 && u < 0.9 ? (patch > 0.7 ? DEEP_RED : RED) : WHITE;
    case "tancho":
      return Math.hypot((u - 0.15) * 3.4, v * 0.75) < 0.42 ? RED : WHITE;
    case "sanke":
      if (fleck > 0.74 && u > 0.22 && u < 0.9) return BLACK;
      return patch > 0.5 && u < 0.9 && u > 0.06 ? RED : WHITE;
    case "showa":
      if (patch > 0.5 && u < 0.88) return RED;
      return fleck > 0.6 ? WHITE : BLACK;
    case "ogon":
      return across < 0.3 ? "#fbe08c" : scale ? "#e8b245" : "#f0c45a";
    case "yamabuki":
      return across < 0.3 ? "#fff0a0" : scale ? "#f0cb48" : "#f6d861";
    case "asagi":
      if (u < 0.12) return "#dce5e8";
      if (across > 0.6) return "#e27c3c";
      return scale ? "#5c7c96" : "#7c9bb3";
    case "chagoi":
      if (across < 0.28) return "#c08c58";
      return scale ? "#96663c" : "#a97846";
    case "shiro-utsuri":
      return patch > 0.45 ? WHITE : BLACK;
    case "kumonryu":
      return noise(seed + 3, u * 6, v * 1.6) > 0.5 ? WHITE : BLACK;
  }
}

function finColor(koi: Koi): string {
  switch (koi.variety) {
    case "ogon":
      return "#f6d07a";
    case "yamabuki":
      return "#fbe48a";
    case "chagoi":
      return "#cfa070";
    case "showa":
    case "shiro-utsuri":
    case "kumonryu":
      return "#6b665f";
    case "asagi":
      return "#eca070";
    default:
      return "#fbf7ef";
  }
}

/** Half-width of the body at `u`: a rounded head, broad shoulders, slim tail. */
function radiusAt(u: number): number {
  if (u < 0.1) return 1.4 + (u / 0.1) * 0.95;
  if (u < 0.32) return 2.35 + ((u - 0.1) / 0.22) * 0.45;
  return 2.8 - ((u - 0.32) / 0.68) * 2.15;
}

const KEY_WIDTH = 1 << 14;
const KEY_OFFSET = 64;
const keyOf = (x: number, y: number) => (y + KEY_OFFSET) * KEY_WIDTH + (x + KEY_OFFSET);
const xOf = (key: number) => (key % KEY_WIDTH) - KEY_OFFSET;
const yOf = (key: number) => Math.floor(key / KEY_WIDTH) - KEY_OFFSET;

type KoiPixel = { color: string; fin: boolean };

function unit(x: number, y: number) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

/**
 * Rasterizes one koi, fins first so the body and head sit on top. `scale`
 * multiplies every coordinate, for a koi drawn bigger or smaller than life.
 */
function rasterizeKoi(koi: Koi, scale = 1): Map<number, KoiPixel> {
  const pixels = new Map<number, KoiPixel>();
  const length = koi.length * scale;
  const fin = finColor(koi);
  const at = (s: number) => {
    const point = bodyPoint(koi, s / scale);
    return { x: point.x * scale, y: point.y * scale };
  };
  const sway = (u: number) => Math.sin(koi.phase - u * 3.2) * 0.65 * u * u * scale;

  // Tail: a long fan that opens behind the body and sways a beat after it.
  const tail = at(length);
  const before = at(length - scale);
  const back = unit(tail.x - before.x, tail.y - before.y);
  const side = { x: -back.y, y: back.x };
  const flick = Math.sin(koi.phase - 3.8) * 1.1 * scale;
  const tailLength = 4 * scale;
  for (let k = 0.5; k <= tailLength; k += 0.5) {
    const spread = (0.6 + (k / scale) * 0.62) * scale;
    for (let across = -spread; across <= spread; across += 0.5) {
      // A notch in the middle of the trailing edge splits the fan in two.
      if (k > tailLength * 0.62 && Math.abs(across) < spread * 0.42) continue;
      const bend = flick * (k / tailLength);
      const x = Math.floor(tail.x + back.x * k + side.x * (across + bend));
      const y = Math.floor(tail.y + back.y * k + side.y * (across + bend));
      pixels.set(keyOf(x, y), { color: fin, fin: true });
    }
  }

  // Pectoral fins, rounded, beating slowly.
  const shoulder = at(length * 0.22);
  const ahead = at(length * 0.22 - scale);
  const forward = unit(ahead.x - shoulder.x, ahead.y - shoulder.y);
  const normal = { x: -forward.y, y: forward.x };
  const beat = Math.sin(koi.phase * 0.7) * 0.5 + 0.5;
  for (const sign of [-1, 1]) {
    for (let k = 0; k <= 1.6 * scale; k += 0.5) {
      for (let w = 0; w <= 0.8 * scale; w += 0.5) {
        const reach = radiusAt(0.22) * scale + 0.3 + k * (0.55 + beat * 0.35);
        const x = Math.floor(shoulder.x + normal.x * sign * reach - forward.x * (k + w + 0.4));
        const y = Math.floor(shoulder.y + normal.y * sign * reach - forward.y * (k + w + 0.4));
        pixels.set(keyOf(x, y), { color: fin, fin: true });
      }
    }
  }

  let headDirection = { x: Math.cos(koi.heading), y: Math.sin(koi.heading) };
  for (let s = length; s >= 0; s -= 0.5) {
    const u = s / length;
    const point = at(s);
    const next = at(Math.max(0, s - 0.75));
    const direction = s < 0.75 ? headDirection : unit(next.x - point.x, next.y - point.y);
    if (s >= 0.75 && s < 1.25) headDirection = direction;
    const across = { x: -direction.y, y: direction.x };
    const offset = sway(u);
    const cx = point.x + across.x * offset;
    const cy = point.y + across.y * offset;
    const r = radiusAt(u) * scale;
    for (let py = Math.floor(cy - r - 1); py <= Math.ceil(cy + r); py++) {
      for (let px = Math.floor(cx - r - 1); px <= Math.ceil(cx + r); px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy > r * r + 0.15) continue;
        const v = (dx * across.x + dy * across.y) / Math.max(0.6, r);
        let color = koiColor(koi, u, v, px, py);
        // Light from above: a sheen down the back, shade along the flanks.
        if (Math.abs(v) < 0.22 && u > 0.08 && u < 0.7) color = mix(color, "#ffffff", 0.16);
        else if (Math.abs(v) > 0.76) color = mix(color, "#000000", 0.2);
        pixels.set(keyOf(px, py), { color, fin: false });
      }
    }
  }

  // Eyes, once the koi is big enough to show them.
  if (length >= 11) {
    const eye = at(1.2 * scale);
    const across = { x: -headDirection.y, y: headDirection.x };
    const reach = radiusAt(0.1) * scale * 0.8;
    for (const sign of [-1, 1]) {
      const x = Math.floor(eye.x + across.x * sign * reach);
      const y = Math.floor(eye.y + across.y * sign * reach);
      if (pixels.has(keyOf(x, y))) pixels.set(keyOf(x, y), { color: "#1a1714", fin: false });
    }
  }
  return pixels;
}

export type KoiStyle = {
  /** Water the koi swims through, for depth and fins. */
  water: string;
  shade: string | null;
  dim: string;
  dimAmount: number;
};

export function drawKoi(ctx: CanvasRenderingContext2D, koi: Koi, style: KoiStyle, scale = 1) {
  const pixels = rasterizeKoi(koi, scale);
  if (style.shade) {
    // The shadow on the bed: farther from the fish the nearer it is to the surface.
    const lift = 1 - koi.depth;
    const ox = Math.round((1 + lift * 1.5) * Math.max(scale, 0.6));
    const oy = Math.round((1 + lift * 2) * Math.max(scale, 0.6));
    ctx.globalAlpha = 0.26 * (1 - koi.depth * 0.5);
    ctx.fillStyle = style.shade;
    for (const key of pixels.keys()) ctx.fillRect(xOf(key) + ox, yOf(key) + oy, 1, 1);
  }
  // A koi has only a few colors: shade each once, then fill its pixels together.
  // Kept clear: only a little water tint with depth, and little dimming at night.
  const depth = koi.depth * 0.42;
  const groups = new Map<string, number[]>();
  for (const [key, pixel] of pixels) {
    const group = (pixel.fin ? "f" : "b") + pixel.color;
    const keys = groups.get(group);
    if (keys) keys.push(key);
    else groups.set(group, [key]);
  }
  for (const [group, keys] of groups) {
    const fin = group[0] === "f";
    const color = group.slice(1);
    let shade = fin ? mix(color, style.water, 0.4) : color;
    shade = mix(shade, style.water, depth);
    if (style.dimAmount > 0) shade = mix(shade, style.dim, style.dimAmount * 0.35);
    ctx.globalAlpha = fin ? 0.8 : 1;
    ctx.fillStyle = shade;
    for (const key of keys) ctx.fillRect(xOf(key), yOf(key), 1, 1);
  }
  ctx.globalAlpha = 1;
}

/**
 * A copy of `koi` swimming a small circle around (cx, cy), for koi shown
 * outside the pond: in the sukui bowl, or in a portrait. Coordinates are in
 * the space `drawKoi` multiplies by `scale`.
 */
export function circlingKoi(koi: Koi, cx: number, cy: number, radius: number, angle: number): Koi {
  const at = (a: number) => ({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  const head = at(angle);
  const trail = [];
  for (let step = 1; step <= koi.length + 6; step++) trail.push(at(angle - step / radius));
  return { ...koi, x: head.x, y: head.y, heading: angle + Math.PI / 2, depth: 0, trail };
}

/** A koi alone on a small patch of water, for the pond page's list. */
export function drawKoiPortrait(canvas: HTMLCanvasElement, koi: Koi) {
  const ctx = canvas.getContext("2d")!;
  const light = LIGHT.day;
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      plot(ctx, x, y, bayer(x, y) < 0.5 ? light.water[2]! : light.water[3]!);
    }
  }
  const pose = { ...koi, depth: 0.1, phase: 1.2, trail: [] as { x: number; y: number }[] };
  // Facing left, centered with its tail.
  const y = canvas.height / 2;
  const x = (canvas.width - koi.length - 4) / 2 + 1;
  pose.x = x;
  pose.y = y;
  pose.heading = Math.PI;
  for (let step = 1; step <= koi.length + 6; step++) pose.trail.push({ x: x + step, y });
  drawKoi(ctx, pose, { water: light.water[4]!, shade: light.shade, dim: light.dim, dimAmount: 0 });
}

// ---------------------------------------------------------------- the painter

type Pad = { x: number; y: number; r: number; notch: number; flower: "bloom" | "bud" | null };
type Plant = { x: number; y: number; blades: number; height: number; seed: number };

export class PondPainter {
  #key = "";
  width = 0;
  height = 0;
  #shore: Int16Array = new Int16Array(0);
  #base: HTMLCanvasElement | null = null;
  #pads: HTMLCanvasElement | null = null;
  #canopy: HTMLCanvasElement | null = null;
  #canopyShade: HTMLCanvasElement | null = null;
  #plants: Plant[] = [];
  #lantern: { x: number; y: number } | null = null;
  #light: Light = LIGHT.day;
  #land: Land = LAND.spring;
  #seed = WORLD_SEED;
  #treeRight = false;
  #caustics: HTMLCanvasElement | null = null;
  #dapple: HTMLCanvasElement | null = null;
  #lightAt = -Infinity;
  /** Where the tree hangs over the water; petals fall from here. */
  canopy: Region | null = null;

  /** Rebuilds the cached layers when the pond's size or look changes. */
  layout(width: number, height: number, focusBottom: number, env: Environment) {
    const garden = env.garden;
    const key = [
      env.seed,
      width,
      height,
      focusBottom,
      env.season,
      env.time,
      env.weather,
      garden.lantern,
      garden.tree,
      garden.lilies,
      garden.plants,
    ].join(":");
    if (key === this.#key) return;
    this.#key = key;
    this.width = width;
    this.height = height;
    this.#light = lightFor(env);
    this.#land = LAND[env.season];
    this.#seed = env.seed >>> 0;
    // The tree and the lantern take opposite sides, chosen by the seed.
    this.#treeRight = (this.#seed & 1) === 1;
    this.#shore = shoreLine(width, this.#seed);
    const lanternX = this.#treeRight ? 18 + (this.#seed % 13) : width - 30 - (this.#seed % 13);
    this.#lantern =
      garden.lantern && width >= LANTERN_MIN_WIDTH
        ? { x: lanternX, y: this.#shore[clampInt(lanternX + 3, 0, width)]! + 3 }
        : null;
    this.#base = this.#paintBase();
    this.#caustics = newCanvas(width, height);
    this.#dapple = garden.tree ? newCanvas(width, height) : null;
    this.#lightAt = -Infinity;
    this.#pads = this.#paintPads(garden.lilies, focusBottom);
    this.#plants = garden.plants ? plantsFor(width, height, this.#seed) : [];
    if (garden.tree) {
      const reach = Math.min(72, Math.round(width * (0.24 + ((this.#seed >>> 3) % 10) / 100)));
      this.canopy = this.#treeRight
        ? { x0: width - reach, x1: width, y0: 0, y1: 13 }
        : { x0: 0, x1: reach, y0: 0, y1: 13 };
      [this.#canopy, this.#canopyShade] = this.#paintCanopy(reach);
    } else {
      this.canopy = null;
      this.#canopy = null;
      this.#canopyShade = null;
    }
  }

  /** Paints the rows `view.y0` to `view.y0 + view.rows` of the pond into `ctx`. */
  paint(
    ctx: CanvasRenderingContext2D,
    pond: Pond,
    env: Environment,
    now: number,
    view: View,
    sukui: Sukui | null = null,
  ) {
    const light = this.#light;
    const land = this.#land;
    const { y0, rows } = view;
    const y1 = y0 + rows;
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(0, -y0);
    if (this.#base) ctx.drawImage(this.#base, 0, 0);

    this.#paintPlants(ctx, now, y0, y1);

    const style: KoiStyle = {
      water: light.water[4]!,
      shade: light.shade,
      dim: light.dim,
      dimAmount: light.dimAmount,
    };
    const byDepth = pond.koi.filter((koi) => !koi.away).sort((a, b) => b.depth - a.depth);
    for (const koi of byDepth) {
      if (koi.y > y0 - 20 && koi.y < y1 + 20) drawKoi(ctx, koi, style);
    }
    if (sukui?.dipped) paintPoi(ctx, sukui, light, now);

    const clear = env.weather === "clear";
    const dapple = clear && env.time !== "night" && this.#dapple !== null;
    // Both views of a frame (strip and chat input) share one drawing of the light.
    if (clear && (now - this.#lightAt >= LIGHT_REFRESH_MS || now < this.#lightAt)) {
      this.#lightAt = now;
      this.#paintCaustics(light, now);
      if (dapple) this.#paintDapple(now);
    }
    if (clear && this.#caustics && light.caustics > 0) {
      ctx.globalAlpha = light.caustics;
      ctx.drawImage(this.#caustics, 0, 0);
      ctx.globalAlpha = 1;
    }
    if (this.#canopyShade) {
      ctx.globalAlpha = env.weather === "rain" ? 0.12 : 0.24;
      ctx.drawImage(this.#canopyShade, 0, 0);
      ctx.globalAlpha = 0.14;
      if (dapple) ctx.drawImage(this.#dapple!, 0, 0);
      ctx.globalAlpha = 1;
    }

    if (this.#pads) ctx.drawImage(this.#pads, 0, 0);
    for (const food of pond.food) {
      ctx.globalAlpha = Math.max(0.25, 1 - food.ageMs / 40_000);
      ctx.fillStyle = FOOD[food.id & 1]!;
      ctx.fillRect(Math.round(food.x), Math.round(food.y), 1, 1);
    }
    ctx.globalAlpha = 1;
    drawDrifts(ctx, pond, now, true);
    drawRipples(ctx, pond, light.sparkle, y0, y1);
    drawWake(ctx, pond, light.sparkle, light.shade, y0, y1);

    if (env.time === "night" && env.weather === "clear") this.#paintMoon(ctx, light, now);
    if (clear && (env.time === "day" || env.time === "dawn")) this.#paintGlints(ctx, light, now, y0, y1);
    const lantern = this.#lantern;
    if (lantern) {
      const lit = env.time !== "day" || env.weather === "rain";
      if (lit) paintLanternGlow(ctx, lantern.x + 3, lantern.y + 2, now);
      paintLantern(ctx, lantern.x, lantern.y, land, light, lit, now);
    }

    if (sukui) {
      paintBowl(ctx, sukui, pond, style, light, now);
      if (!sukui.dipped) paintPoi(ctx, sukui, light, now);
    }

    if (this.#canopy) ctx.drawImage(this.#canopy, 0, 0);
    drawDrifts(ctx, pond, now, false);
    if (env.weather === "rain") paintRain(ctx, this.width, this.height, y0, y1, now, env.rain, light.dimAmount);
    if (view.scrim) paintScrim(ctx, this.width, view.scrim, y0, y1);
    ctx.restore();
  }

  #paintBase(): HTMLCanvasElement {
    const { width, height } = this;
    const canvas = newCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    const light = this.#light;
    const land = this.#land;
    const shore = this.#shore;
    const dimmed = (color: string) => mix(color, light.dim, light.dimAmount);

    // Water: deeper away from the shore, with soft patches of sand on the bed.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const edge = shore[x]!;
        if (y < edge) continue;
        const fromShore = y - edge;
        const bed = noise(this.#seed, x * 0.05, y * 0.09) - 0.5;
        const depth = Math.min(1, fromShore / DEPTH_RANGE) + bed * 0.32;
        const level = clampInt(depth * 5 + bayer(x, y) - 0.5, 0, 5);
        let color = light.water[level]!;
        const grain = hash(this.#seed + 1, x, y);
        if (fromShore < 3 && grain > 0.8) color = mix(color, dimmed(SAND), 0.4);
        else if (grain > 0.99) color = light.water[Math.max(0, level - 1)]!;
        // The bank's shade on the water right below it.
        if (fromShore === 0) color = mix(color, light.shade, 0.4);
        else if (fromShore === 1) color = mix(color, light.shade, 0.16);
        plot(ctx, x, y, color);
      }
    }

    // The bank: grass with soft patches, a darker lip where it meets the water.
    const [grassLight, grass, grassDark] = land.grass.map(dimmed) as [string, string, string];
    for (let x = 0; x < width; x++) {
      const edge = shore[x]!;
      for (let y = 0; y < edge; y++) {
        const patch = noise(this.#seed + 2, x * 0.18, y * 0.35);
        let color =
          patch + bayer(x, y) * 0.3 > 0.72 ? grassLight : patch < 0.35 ? grassDark : grass;
        if (y === edge - 1) color = dimmed(land.edge);
        plot(ctx, x, y, color);
      }
    }
    const rng = seededRng(this.#seed + width);
    for (let index = 0; index < width / 5; index++) {
      const x = Math.floor(rng() * width);
      const y = Math.floor(rng() * Math.max(1, shore[x]! - 2));
      plot(ctx, x, y, dimmed(land.flowers[Math.floor(rng() * land.flowers.length)]!));
    }
    // Grass hanging over the water here and there.
    for (let index = 0; index < width / 9; index++) {
      const x = Math.floor(rng() * width);
      const edge = shore[x]!;
      plot(ctx, x, edge, grassDark);
      if (rng() < 0.5) {
        plot(ctx, x + (rng() < 0.5 ? -1 : 1), edge + 1, mix(grassDark, light.water[0]!, 0.4));
      }
    }

    // Mossy stones along the edge, some sitting in the shallows.
    const [stoneLight, stone, stoneDark] = land.stone.map(dimmed) as [string, string, string];
    const cap = land.cap ? dimmed(land.cap) : null;
    let x = Math.floor(rng() * 6);
    while (x < width + 4) {
      const rx = 1.6 + rng() * 2.4;
      const ry = rx * (0.6 + rng() * 0.2);
      const cx = x + rx;
      const cy = shore[clampInt(cx, 0, width - 1)]! - 0.5 + rng() * 1.6;
      for (let py = Math.floor(cy - ry - 1); py <= Math.ceil(cy + ry); py++) {
        for (let px = Math.floor(cx - rx - 1); px <= Math.ceil(cx + rx); px++) {
          const dx = (px + 0.5 - cx) / rx;
          const dy = (py + 0.5 - cy) / ry;
          const d = dx * dx + dy * dy;
          if (d > 1 || px < 0 || px >= width || py < 0) continue;
          let color = stone;
          if (dx + dy < -0.55) color = cap ?? stoneLight;
          else if (dx + dy > 0.6 || d > 0.82) color = stoneDark;
          if (!cap && dy < -0.2 && noise(this.#seed + 3, px * 0.6, py * 0.6) > 0.66) {
            color = dimmed(land.edge);
          }
          plot(ctx, px, py, color);
        }
      }
      // A thin line of foam where the stone meets the water.
      const foamY = Math.ceil(cy + ry) + 1;
      ctx.globalAlpha = 0.35;
      for (let px = Math.floor(cx - rx + 1); px < cx + rx - 1; px++) {
        if (px >= 0 && px < width && foamY >= shore[px]!) plot(ctx, px, foamY, light.sparkle);
      }
      ctx.globalAlpha = 1;
      x += Math.ceil(rx * 2) + 2 + Math.floor(rng() * 9);
    }
    return canvas;
  }

  #paintPads(amount: PondConfig["garden"]["lilies"], focusBottom: number): HTMLCanvasElement | null {
    if (amount === "none") return null;
    const { width, height } = this;
    const canvas = newCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    const light = this.#light;
    const land = this.#land;
    const dimmed = (color: string) => mix(color, light.dim, light.dimAmount);
    const rng = seededRng(this.#seed + 7 + width);
    const per = amount === "many" ? 38 : 75;
    const count = Math.max(2, Math.round(width / per));
    const bottom = Math.min(height - 4, Math.max(SHORE_ROWS + 8, focusBottom + 6));
    const pads: Pad[] = [];
    for (let index = 0; index < count; index++) {
      const r = 3.4 + rng() * 2;
      const pad: Pad = {
        x: ((index + 0.5) * width) / count + (rng() - 0.5) * (width / count) * 0.7,
        y: SHORE_ROWS + 4 + rng() * Math.max(2, bottom - SHORE_ROWS - 6),
        r,
        notch: rng() * Math.PI * 2,
        flower: null,
      };
      const flower = rng();
      if (land.lotus) pad.flower = flower < 0.45 ? "bloom" : flower < 0.7 ? "bud" : null;
      pads.push(pad);
      // Smaller pads gather around the big ones.
      const friends = amount === "many" ? 2 : 1;
      for (let friend = 0; friend < friends; friend++) {
        if (rng() < 0.35) continue;
        const angle = rng() * Math.PI * 2;
        const gap = r + 1.6 + rng() * 1.5;
        pads.push({
          x: pad.x + Math.cos(angle) * gap * 1.3,
          y: pad.y + Math.sin(angle) * gap * 0.8,
          r: 1.6 + rng() * 1.3,
          notch: rng() * Math.PI * 2,
          flower: null,
        });
      }
    }
    // Shadows first, so no pad's shadow lands on another pad.
    ctx.globalAlpha = 0.28;
    for (const pad of pads) paintPadShape(ctx, pad, () => light.shade, 1, 1);
    ctx.globalAlpha = 1;
    const [padLight, padMid, padDark] = land.pad.map(dimmed) as [string, string, string];
    for (const pad of pads) {
      paintPadShape(ctx, pad, (dx, dy, distance) => {
        if (distance > pad.r - 0.9) return dx + dy > 0 ? padDark : padLight;
        // Faint veins running out from the middle.
        const vein = Math.abs(Math.sin((Math.atan2(dy, dx) - pad.notch) * 3.5));
        return vein < 0.18 && distance > 1 ? padDark : padMid;
      });
    }
    for (const pad of pads) {
      if (pad.flower) {
        paintLotus(ctx, pad.x, pad.y, pad.flower, (color) => mix(color, dimmed(color), 0.5));
      }
    }
    return canvas;
  }

  #paintCanopy(reach: number): [HTMLCanvasElement, HTMLCanvasElement] {
    const { width, height } = this;
    const canopy = newCanvas(width, height);
    const shadeCanvas = newCanvas(width, height);
    const ctx = canopy.getContext("2d")!;
    const shadeCtx = shadeCanvas.getContext("2d")!;
    const light = this.#light;
    const land = this.#land;
    const dimmed = (color: string) => mix(color, light.dim, light.dimAmount);
    const rng = seededRng(this.#seed + 11);
    // Drawn reaching in from the left, then mirrored when the tree stands on the right.
    const flip = (x: number) => (this.#treeRight ? width - 1 - x : x);

    // A main bough reaching in from the corner, with a few twigs off it.
    const main: { x: number; y: number }[] = [];
    for (let t = 0; t <= 1; t += 0.02) {
      main.push({ x: -3 + t * reach, y: 1 + t * 8 + Math.sin(t * 3.2) * 2.5 });
    }
    const boughs = [main];
    for (let twig = 0; twig < 4; twig++) {
      const start = main[Math.floor((0.25 + twig * 0.17) * main.length)]!;
      const up = twig % 2 === 0 ? -1 : 1;
      const length = 8 + rng() * 6;
      const rise = 3 + rng() * 3;
      const path: { x: number; y: number }[] = [];
      for (let t = 0; t <= 1; t += 0.05) path.push({ x: start.x + t * length, y: start.y + up * t * rise });
      boughs.push(path);
    }

    const clusters: { x: number; y: number; r: number }[] = [];
    if (land.canopy.length > 0) {
      for (const path of boughs) {
        for (let index = 2; index < path.length; index += 4) {
          const point = path[index]!;
          clusters.push({
            x: point.x + (rng() - 0.5) * 3,
            y: point.y + (rng() - 0.5) * 3,
            r: 2.4 + rng() * 2.6,
          });
        }
      }
    }
    // The tree's shadow on the water, offset as if lit from the upper left.
    const shadow = (x: number, y: number) => {
      const sx = flip(x) + 5;
      if (sx >= 0 && sx < width && y + 5 < height) plot(shadeCtx, sx, y + 5, light.shade);
    };
    const branch = dimmed(land.branch);
    for (const path of boughs) {
      for (const point of path) {
        for (const dy of path === main ? [0, 1] : [0]) {
          const x = Math.round(point.x);
          const y = Math.round(point.y) + dy;
          if (x < 0 || y < 0) continue;
          plot(ctx, flip(x), y, branch);
          shadow(x, y);
          if (land.cap && dy === 0 && y > 0) plot(ctx, flip(x), y - 1, dimmed(land.cap));
        }
      }
    }
    const tones = land.canopy.map(dimmed);
    for (const cluster of clusters) {
      const r = cluster.r;
      for (let py = Math.floor(cluster.y - r); py <= Math.ceil(cluster.y + r); py++) {
        for (let px = Math.floor(cluster.x - r); px <= Math.ceil(cluster.x + r); px++) {
          if (px < 0 || py < 0) continue;
          const dx = px + 0.5 - cluster.x;
          const dy = py + 0.5 - cluster.y;
          const d = Math.hypot(dx, dy) / r;
          // Ragged edges: leaves, not a ball.
          if (d > 1 || (d > 0.7 && hash(this.#seed + 13, px, py) > 0.55)) continue;
          // Lit from the upper left, whichever side the tree is on.
          const lx = this.#treeRight ? -dx : dx;
          const lit = 0.5 - (lx + dy) / (r * 2.5) + (bayer(px, py) - 0.5) * 0.5;
          plot(ctx, flip(px), py, tones[clampInt((1 - lit) * (tones.length - 1), 0, tones.length - 1)]!);
          shadow(px, py);
        }
      }
    }
    return [canopy, shadeCanvas];
  }

  #paintPlants(ctx: CanvasRenderingContext2D, now: number, y0: number, y1: number) {
    if (this.#plants.length === 0) return;
    ctx.fillStyle = mix(this.#light.water[5]!, "#3d7a46", 0.45);
    ctx.globalAlpha = 0.7;
    for (const plant of this.#plants) {
      if (plant.y < y0 - 10 || plant.y - plant.height > y1) continue;
      for (let blade = 0; blade < plant.blades; blade++) {
        const lean = (blade - (plant.blades - 1) / 2) * 0.7;
        const tall = plant.height - Math.abs(lean) * 1.5;
        for (let i = 0; i < tall; i++) {
          const sway = Math.sin(now * 0.0011 + plant.seed + blade + i * 0.35) * i * 0.22;
          ctx.fillRect(Math.round(plant.x + lean * i * 0.4 + sway), Math.round(plant.y - i), 1, 1);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Sunlight bent by the ripples, playing slowly over the bed as a moving net. */
  #paintCaustics(light: Light, now: number) {
    const ctx = this.#caustics?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    if (light.caustics <= 0) return;
    const t = (now / 1000) * 0.7;
    const shore = this.#shore;
    ctx.fillStyle = light.sparkle;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (y <= shore[x]!) continue;
        // Only in drifting patches, and thin, so it reads as light, not tiles.
        const patch = noise(WORLD_SEED + 29, x * 0.035 + t * 0.06, y * 0.06 - t * 0.04);
        if (patch < 0.45) continue;
        const v =
          Math.sin(x * 0.42 + Math.sin(y * 0.31 + t * 0.7) * 1.4 + t * 0.5) +
          Math.sin(y * 0.55 - Math.sin(x * 0.27 - t * 0.6) * 1.4 - t * 0.4);
        if (Math.abs(v) < (patch - 0.45) * 0.5 * (0.4 + bayer(x, y))) ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  /** Leaf shade drifting slowly on the water under the tree. */
  #paintDapple(now: number) {
    const ctx = this.#dapple?.getContext("2d");
    const canopy = this.canopy;
    if (!ctx || !canopy) return;
    ctx.clearRect(0, 0, this.width, this.height);
    const t = (now / 1000) * 0.7;
    const reach = (canopy.x1 - canopy.x0) * 1.6;
    ctx.fillStyle = this.#light.shade;
    for (let y = SHORE_ROWS; y < Math.min(this.height, 34); y++) {
      for (let x = 0; x < this.width; x++) {
        const fromTree = this.#treeRight ? this.width - 1 - x : x;
        if (fromTree >= reach) continue;
        const fade = fromTree / reach + y / 34;
        const n = noise(
          WORLD_SEED + 17,
          x * 0.16 + Math.sin(t * 0.35) * 0.7,
          y * 0.22 + Math.cos(t * 0.27) * 0.5,
        );
        if (n - fade * 0.45 > 0.42 + bayer(x, y) * 0.12) ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  /** Sun glints winking on the surface. */
  #paintGlints(ctx: CanvasRenderingContext2D, light: Light, now: number, y0: number, y1: number) {
    const count = Math.max(4, Math.floor((this.width * (y1 - y0)) / 420));
    ctx.fillStyle = light.sparkle;
    for (let index = 0; index < count; index++) {
      const twinkle = Math.sin(now * 0.0011 * (0.6 + hash(5, index, 2)) + index * 1.7);
      if (twinkle < 0.6) continue;
      const x = Math.floor(hash(5, index, 1) * this.width);
      const y = Math.floor(y0 + hash(5, index, 3) * (y1 - y0));
      if (y <= this.#shore[x]! + 1) continue;
      ctx.globalAlpha = Math.min(0.6, (twinkle - 0.6) * 1.8);
      ctx.fillRect(x, y, twinkle > 0.9 ? 2 : 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  #paintMoon(ctx: CanvasRenderingContext2D, light: Light, now: number) {
    const cx = Math.round(this.width * 0.62);
    const cy = SHORE_ROWS + 9;
    ctx.fillStyle = "#e9eef8";
    for (let row = -2; row <= 2; row++) {
      const half = [2, 4, 5, 4, 2][row + 2]!;
      const wobble = Math.round(Math.sin(now * 0.0021 + row * 1.3));
      for (let dx = -half; dx <= half; dx++) {
        // Broken up by the ripples, like a real reflection.
        if (hash(9, dx + wobble, Math.floor(now / 500) + row) > 0.82) continue;
        ctx.globalAlpha = 0.5 - Math.abs(dx) / (half * 4);
        ctx.fillRect(cx + dx + wobble, cy + row, 1, 1);
      }
    }
    // A few stars reflected nearby.
    ctx.fillStyle = light.sparkle;
    for (let index = 0; index < this.width / 18; index++) {
      const twinkle = Math.sin(now * 0.0012 + index * 2.3);
      if (twinkle < 0.3) continue;
      ctx.globalAlpha = (twinkle - 0.3) * 0.8;
      ctx.fillRect(
        Math.floor(hash(21, index, 1) * this.width),
        Math.floor(SHORE_ROWS + 2 + hash(21, index, 2) * (this.height - SHORE_ROWS - 3)),
        1,
        1,
      );
    }
    ctx.globalAlpha = 1;
  }
}

function lightFor(env: Environment): Light {
  const base = LIGHT[env.time];
  if (env.weather !== "rain") return base;
  // Rain greys everything a little and hides the sun.
  return {
    ...base,
    water: base.water.map((color) => mix(color, RAIN_TINT, 0.25)),
    caustics: 0,
    dim: base.dimAmount > 0 ? base.dim : RAIN_TINT,
    dimAmount: Math.max(base.dimAmount, 0.15),
  };
}

function shoreLine(width: number, seed: number): Int16Array {
  const shore = new Int16Array(width + 1);
  for (let x = 0; x <= width; x++) {
    const n = noise(seed + 5, x * 0.07, 0) * 3.4 + noise(seed + 6, x * 0.23, 0) * 1.4;
    shore[x] = clampInt(2.6 + n, 3, SHORE_ROWS - 1);
  }
  return shore;
}

function plantsFor(width: number, height: number, seed: number): Plant[] {
  const rng = seededRng(seed + 23 + width);
  const plants: Plant[] = [];
  const count = Math.round((width * Math.max(0, height - SHORE_ROWS - 12)) / 700);
  for (let index = 0; index < count; index++) {
    plants.push({
      x: rng() * width,
      y: SHORE_ROWS + 14 + rng() * Math.max(1, height - SHORE_ROWS - 14),
      blades: 2 + Math.floor(rng() * 3),
      height: 4 + rng() * 5,
      seed: rng() * 10,
    });
  }
  return plants;
}

function paintPadShape(
  ctx: CanvasRenderingContext2D,
  pad: Pad,
  colorAt: (dx: number, dy: number, distance: number) => string,
  ox = 0,
  oy = 0,
) {
  for (let y = Math.floor(pad.y - pad.r - 1); y <= Math.ceil(pad.y + pad.r); y++) {
    if (y < SHORE_ROWS) continue;
    for (let x = Math.floor(pad.x - pad.r - 1); x <= Math.ceil(pad.x + pad.r); x++) {
      const dx = x + 0.5 - pad.x;
      const dy = (y + 0.5 - pad.y) * 1.15;
      const distance = Math.hypot(dx, dy);
      if (distance > pad.r) continue;
      const angle = Math.atan2(dy, dx) - pad.notch;
      if (Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) < 0.38 && distance > 0.7) continue;
      plot(ctx, x + ox, y + oy, colorAt(dx, dy, distance));
    }
  }
}

function paintLotus(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  kind: "bloom" | "bud",
  dimmed: (color: string) => string,
) {
  const shape =
    kind === "bloom"
      ? ["  T T  ", " TPTPT ", "TPDHDPT", " PDHDP ", "  PPP  "]
      : [" T ", "TPT", "PDP"];
  const colors: Record<string, string> = {
    T: LOTUS.tip,
    P: LOTUS.petal,
    D: LOTUS.deep,
    H: LOTUS.heart,
  };
  const left = Math.round(cx) - Math.floor(shape[0]!.length / 2);
  const top = Math.round(cy) - Math.floor(shape.length / 2) - 1;
  shape.forEach((row, dy) => {
    [...row].forEach((cell, dx) => {
      const color = colors[cell];
      if (color) plot(ctx, left + dx, top + dy, dimmed(color));
    });
  });
}

/** A snow-viewing lantern on a stone in the shallows. */
function paintLantern(
  ctx: CanvasRenderingContext2D,
  left: number,
  base: number,
  land: Land,
  light: Light,
  lit: boolean,
  now: number,
) {
  const dimmed = (color: string) => mix(color, light.dim, light.dimAmount);
  const [stoneLight, stone, stoneDark] = land.stone.map(dimmed) as [string, string, string];
  const flicker = 0.85 + Math.sin(now * 0.0047) * 0.08 + Math.sin(now * 0.0131) * 0.07;
  const window = lit ? mix("#c98a3a", LANTERN_LIGHT, flicker) : dimmed("#4d4943");
  const shape = [
    "   C   ",
    " CCCCC ",
    "LLLLLLL",
    " SWWWD ",
    " SWWWD ",
    " SSSSD ",
    "  SSD  ",
    "  SSD  ",
    " SSSDD ",
  ];
  const colors: Record<string, string> = {
    C: land.cap ? dimmed(land.cap) : stoneLight,
    L: stone,
    S: stone,
    D: stoneDark,
    W: window,
  };
  const top = base - shape.length;
  // The stone it stands on, half in the water, and that stone's shadow.
  ctx.globalAlpha = 0.3;
  for (let dy = 2; dy <= 3; dy++) {
    for (let dx = 0; dx <= 8; dx++) plot(ctx, left + dx, base + dy, light.shade);
  }
  ctx.globalAlpha = 1;
  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const ex = (dx - 3) / 4.6;
      const ey = (dy - 0.5) / 2;
      if (ex * ex + ey * ey > 1) continue;
      plot(ctx, left + dx, base + dy, ex + ey < -0.3 ? stoneLight : ex + ey > 0.5 ? stoneDark : stone);
    }
  }
  shape.forEach((row, dy) => {
    [...row].forEach((cell, dx) => {
      const color = colors[cell];
      if (color) plot(ctx, left + dx, top + dy, color);
    });
  });
}

function paintLanternGlow(ctx: CanvasRenderingContext2D, cx: number, cy: number, now: number) {
  const flicker = 0.85 + Math.sin(now * 0.0047) * 0.08 + Math.sin(now * 0.0131) * 0.07;
  ctx.fillStyle = LANTERN_LIGHT;
  for (let ring = 12; ring >= 2; ring -= 2) {
    ctx.globalAlpha = 0.07 * flicker * (1 - ring / 13);
    for (let y = Math.floor(cy - ring * 0.7); y <= cy + ring * 0.7; y++) {
      const half = Math.floor(Math.sqrt(Math.max(0, ring * ring - ((y - cy) / 0.7) ** 2)));
      ctx.fillRect(Math.round(cx - half), y, half * 2 + 1, 1);
    }
  }
  // Its reflection, a broken streak of light below it.
  for (let k = 1; k <= 9; k++) {
    const wobble = Math.round(Math.sin(now * 0.003 + k * 0.9) * 1.2);
    ctx.globalAlpha = 0.45 * flicker * (1 - k / 10);
    ctx.fillRect(cx - 1 + wobble, cy + 3 + k, k % 3 === 0 ? 1 : 2, 1);
  }
  ctx.globalAlpha = 1;
}

/** The paper poi: red hoop, paper that greys and gives way as it wears. */
function paintPoi(ctx: CanvasRenderingContext2D, sukui: Sukui, light: Light, now: number) {
  if (sukui.torn && sukui.tornMs < 1_800) return;
  const cx = sukui.x;
  const cy = sukui.y;
  const r = POI_RADIUS;
  const under = sukui.dipped;
  const water = light.water[2]!;
  const fadeOut = sukui.torn ? (sukui.tornMs - 1_800) / 700 : 1;
  const tint = (color: string) => (under ? mix(color, water, 0.4) : color);
  const dimmed = (color: string) => mix(tint(color), light.dim, light.dimAmount * 0.6);

  if (!under) {
    // Held above the water: a soft shadow below and to the right.
    ctx.globalAlpha = 0.22 * fadeOut;
    ctx.fillStyle = light.shade;
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) ctx.fillRect(x + 2, y + 3, 1, 1);
      }
    }
  }

  // The handle, out to the lower right.
  ctx.globalAlpha = fadeOut;
  for (let k = r - 0.3; k < r + 6.5; k += 0.5) {
    const x = Math.floor(cx + k * 0.72);
    const y = Math.floor(cy + k * 0.69);
    plot(ctx, x, y, dimmed(POI.frame));
    if (k > r + 1) plot(ctx, x + 1, y, dimmed(POI.frameLight));
  }

  // Wet paper turns see-through; worn paper opens in holes, a torn one in tatters.
  const wet = under ? 0.55 : 0.85 - (1 - sukui.paper) * 0.25;
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (distance > r + 0.55) continue;
      if (distance > r - 0.65) {
        const lit = x + 0.5 - cx + (y + 0.5 - cy) < 0;
        ctx.globalAlpha = fadeOut;
        plot(ctx, x, y, dimmed(lit ? POI.frameLight : POI.frame));
        continue;
      }
      const hole = hash(sukui.tearSeed, x - Math.floor(cx), y - Math.floor(cy));
      if (sukui.torn ? distance < r - 1.6 || hole > 0.5 : hole > sukui.paper + 0.45) continue;
      ctx.globalAlpha = wet * fadeOut;
      plot(ctx, x, y, dimmed(POI.paper));
    }
  }
  if (sukui.phase.kind === "bite") paintBiteMark(ctx, cx, cy - r - 4, sukui.phase.ms, now);
  if (under) {
    // The water closing over the hoop.
    const pulse = (now / 900) % 1;
    ctx.globalAlpha = 0.35 * (1 - pulse);
    ctx.fillStyle = light.sparkle;
    const ring = r + 1 + pulse * 2;
    for (let index = 0; index < 28; index++) {
      const angle = (index / 28) * Math.PI * 2;
      ctx.fillRect(Math.round(cx + Math.cos(angle) * ring), Math.round(cy + Math.sin(angle) * ring * 0.85), 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

/** A bobbing "!" over the poi while a koi is right above it: the moment to tap. */
function paintBiteMark(ctx: CanvasRenderingContext2D, cx: number, top: number, ms: number, now: number) {
  const x = Math.round(cx);
  const y = Math.round(top + Math.sin(now * 0.02) * 0.6) - (ms < 120 ? 1 : 0);
  const shape = [" O ", "OWO", "OWO", "OWO", " O ", "OWO", " O "];
  // Fades as the moment passes.
  const fade = 1 - Math.max(0, ms - BITE_MS * 0.6) / (BITE_MS * 0.4);
  shape.forEach((row, dy) => {
    [...row].forEach((cell, dx) => {
      if (cell === " ") return;
      ctx.globalAlpha = Math.max(0, fade);
      plot(ctx, x - 1 + dx, y + dy - 7, cell === "W" ? "#ffffff" : "#20262c");
    });
  });
  ctx.globalAlpha = 1;
}

/** The floating wooden bowl where scooped koi rest before going back. */
function paintBowl(
  ctx: CanvasRenderingContext2D,
  sukui: Sukui,
  pond: Pond,
  style: KoiStyle,
  light: Light,
  now: number,
) {
  const cx = sukui.bowlX;
  const cy = sukui.bowlY + Math.sin(now * 0.0012) * 0.4;
  const r = 6.5;
  const dimmed = (color: string) => mix(color, light.dim, light.dimAmount);
  const inner = mix(light.water[1]!, "#ffffff", 0.12);
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = light.shade;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if (Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) * 1.1) <= r) ctx.fillRect(x + 1, y + 2, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const dx = x + 0.5 - cx;
      const dy = (y + 0.5 - cy) * 1.1;
      const distance = Math.hypot(dx, dy);
      if (distance > r) continue;
      let color = inner;
      if (distance > r - 1.3) color = dx + dy < 0 ? BOWL.rimLight : BOWL.rim;
      else if (distance > r - 2.1) color = dx + dy > 0 ? BOWL.rimDark : mix(inner, BOWL.rimDark, 0.3);
      plot(ctx, x, y, dimmed(color));
    }
  }
  const scale = 0.55;
  sukui.bowl.forEach((entry, index) => {
    const koi = pond.koi.find((candidate) => candidate.id === entry.koiId);
    if (!koi) return;
    const angle = entry.angle + now * 0.0007 * (index % 2 ? -1 : 1);
    const swimmer = circlingKoi(koi, cx / scale, cy / scale, 4.2 - index * 0.6, angle);
    drawKoi(ctx, swimmer, { ...style, shade: null }, scale);
  });
}

function drawRipples(ctx: CanvasRenderingContext2D, pond: Pond, color: string, y0: number, y1: number) {
  ctx.fillStyle = color;
  for (const ripple of pond.ripples) {
    const radius = (ripple.ageMs / 1000) * ripple.speed;
    if (radius < 0.5 || ripple.y + radius < y0 || ripple.y - radius > y1) continue;
    const fade = 1 - radius / ripple.maxRadius;
    // About one point per pixel of circumference: no gaps, and little overdraw to track.
    const ring = (r: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      const steps = Math.max(8, Math.ceil(r * 5.4));
      for (let index = 0; index < steps; index++) {
        const angle = (index / steps) * Math.PI * 2;
        const y = Math.round(ripple.y + Math.sin(angle) * r * 0.8);
        if (y < SHORE_ROWS) continue;
        ctx.fillRect(Math.round(ripple.x + Math.cos(angle) * r), y, 1, 1);
      }
    };
    ring(radius, fade * 0.6);
    if (radius > 3) ring(radius - 2.5, fade * 0.25);
  }
  ctx.globalAlpha = 1;
}

/**
 * The wake of a stick drawn through the water: a thin bright line where it
 * passed, and two lines parting from it on either side, spreading and fading.
 */
function drawWake(
  ctx: CanvasRenderingContext2D,
  pond: Pond,
  color: string,
  shade: string,
  y0: number,
  y1: number,
) {
  if (pond.wake.length === 0) return;
  // The groove the stick leaves, darker, under the bright lines.
  ctx.fillStyle = shade;
  for (const point of pond.wake) {
    const t = point.ageMs / WAKE_MS;
    const py = Math.round(point.y);
    if (t > 0.6 || py < SHORE_ROWS || py < y0 - 1 || py > y1) continue;
    ctx.globalAlpha = 0.16 * (1 - t / 0.6);
    ctx.fillRect(Math.round(point.x), py + 1, 1, 1);
  }
  ctx.fillStyle = color;
  for (const point of pond.wake) {
    const t = point.ageMs / WAKE_MS;
    const fade = (1 - t) * (1 - t);
    // Across the stroke, to either side.
    const nx = -point.dy;
    const ny = point.dx * 0.8;
    const spread = 0.8 + t * 6;
    const plot = (x: number, y: number, alpha: number) => {
      const py = Math.round(y);
      if (py < SHORE_ROWS || py < y0 - 1 || py > y1) return;
      ctx.globalAlpha = alpha;
      ctx.fillRect(Math.round(x), py, 1, 1);
    };
    if (t < 0.45) plot(point.x, point.y, 0.55 * (1 - t / 0.45));
    plot(point.x + nx * spread, point.y + ny * spread, 0.45 * fade);
    plot(point.x - nx * spread, point.y - ny * spread, 0.45 * fade);
  }
  ctx.globalAlpha = 1;
}

/** `floating` paints what rests on the water; otherwise what is still in the air. */
function drawDrifts(ctx: CanvasRenderingContext2D, pond: Pond, now: number, floating: boolean) {
  for (const drift of pond.drifts) {
    const onWater = drift.landed;
    if (drift.kind === "firefly" ? floating : onWater !== floating) continue;
    const colors = DRIFT_COLORS[drift.kind];
    const color = colors[drift.tint % colors.length]!;
    const x = Math.round(drift.x);
    const y = Math.round(drift.y);
    const remaining = drift.lifeMs - drift.ageMs;
    const fade = onWater || drift.kind === "firefly" ? Math.min(1, remaining / 3_000) : 1;
    if (drift.kind === "firefly") {
      const blink = Math.sin(now * 0.004 + drift.tint * 2 + drift.x) * 0.5 + 0.5;
      const appear = Math.min(1, drift.ageMs / 1_500) * fade;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.16 * blink * appear;
      ctx.fillRect(x - 1, y - 1, 3, 3);
      ctx.globalAlpha = (0.35 + 0.65 * blink) * appear;
      ctx.fillRect(x, y, 1, 1);
      continue;
    }
    if (onWater && y < SHORE_ROWS) continue;
    ctx.globalAlpha = fade * (onWater ? 0.9 : 1);
    ctx.fillStyle = color;
    if (drift.kind === "snow") {
      ctx.fillRect(x, y, 1, 1);
    } else if (drift.kind === "petal") {
      const flat = onWater || ((Math.floor((drift.ageMs + drift.tint * 400) / 520) & 1) === 1);
      ctx.fillRect(x, y, flat ? 2 : 1, flat ? 1 : 2);
    } else {
      ctx.fillRect(x, y, 2, 1);
      ctx.fillRect(x + (drift.tint & 1), y + 1, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

/** Wind leans the rain: how far a drop moves left for each pixel it falls. */
const RAIN_SLANT = 0.3;

/**
 * Rain as thin slanted streaks falling steadily across the whole pond, more of
 * them as the rain picks up. Each drop keeps its own speed and starts each fall
 * somewhere new, so the rain never repeats or flickers.
 */
function paintRain(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  y0: number,
  y1: number,
  now: number,
  amount: number,
  dim: number,
) {
  const t = now / 1000;
  const span = height + 8;
  const count = Math.round(((width * height) / 120) * amount);
  const ink = 0.42 * (1 - dim * 0.5);
  ctx.fillStyle = "#dbe8f0";
  for (let index = 0; index < count; index++) {
    const speed = 30 + hash(33, index, 0) * 14;
    const travel = hash(32, index, 0) * span + t * speed;
    const fall = (travel % span) - 4;
    const x0 = hash(31, index, Math.floor(travel / span)) * (width + span * RAIN_SLANT);
    // Head first, then a fading tail up and to the right.
    for (let k = 0; k < 4; k++) {
      const y = Math.round(fall - k);
      if (y < y0 || y >= y1) continue;
      ctx.globalAlpha = ink * (1 - k * 0.27);
      ctx.fillRect(Math.round(x0 - (fall - k) * RAIN_SLANT), y, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

function paintScrim(ctx: CanvasRenderingContext2D, width: number, scrim: Scrim, y0: number, y1: number) {
  ctx.fillStyle = scrim.color;
  for (let y = Math.max(y0, scrim.start); y < y1; y++) {
    const t = Math.min(1, (y - scrim.start + 1) / Math.max(1, scrim.full - scrim.start));
    ctx.globalAlpha = scrim.alpha * t * t * (3 - 2 * t);
    ctx.fillRect(0, y, width, 1);
  }
  ctx.globalAlpha = 1;
}
