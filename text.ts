// The "Text" look: the same pond, drawn as monochrome text art in the theme's
// own text color. Each character cell covers 2x4 pond pixels, exactly a
// braille cell, and takes one of these forms, boldest first:
// - what moves (koi, the poi, ripples) is inked where it differs from the
//   still garden, fainter where it differs less: lone pixels as braille dots,
//   pixels that touch as quadrant blocks
// - the garden (lily pads, the tree) is a faint dotted texture
// - open water gets slow ASCII waves (`~ ≈`), the bank a few marks (`' , "`)
// Blocks and dots are drawn as shapes, not font glyphs, so they look the same
// on every font; only the ASCII is real text.

import { hash, noise, type Environment, type PondPainter, type View } from "./scene.ts";
import type { Pond } from "./koi.ts";
import type { Sukui } from "./sukui.ts";

export const CELL_W = 2;
export const CELL_H = 4;
/** A pixel this far (summed channels) from the still pond is inked. */
const INK_FROM = 70;
/** Ink strengths, faint to full; a cell takes the nearest one. */
const LEVELS = [0.3, 0.45, 0.6, 0.75, 0.9] as const;
const GARDEN_INK = 0.2;
/** Pixels whose row and column add up to an even number. */
const CHECKER = 0b1001_1001;
const WAVE_INK = 0.22;
const MARK_INK = 0.3;
/** Under the chat input's text the ink is lighter, so the text stays easy to read. */
const UNDER_TEXT = 0.45;

export type Shape =
  | { kind: "plain" }
  | { kind: "dots"; mask: number }
  | { kind: "blocks"; quads: number };

/**
 * The shape for a cell's inked pixels, given as a mask of eight bits, row by
 * row, two a row: dots when no inked pixel touches another, else blocks.
 */
export function shapeOf(mask: number): Shape {
  if (mask === 0) return { kind: "plain" };
  // Touching: an inked pixel with an inked neighbor to its right or below.
  const touching = (mask & (mask >> 1) & 0b0101_0101) !== 0 || (mask & (mask >> 2)) !== 0;
  if (!touching) return { kind: "dots", mask };
  // Quadrants: top-left, top-right, bottom-left, bottom-right, each two pixel rows.
  let quads = 0;
  for (let i = 0; i < 8; i++) {
    if (mask & (1 << i)) quads |= 1 << ((i >> 2) * 2 + (i & 1));
  }
  return { kind: "blocks", quads };
}

function difference(data: Uint8ClampedArray, still: Uint8ClampedArray, at: number, stillAt: number): number {
  return (
    Math.abs(data[at]! - still[stillAt]!) +
    Math.abs(data[at + 1]! - still[stillAt + 1]!) +
    Math.abs(data[at + 2]! - still[stillAt + 2]!)
  );
}

export class TextPainter {
  #pixels: HTMLCanvasElement | null = null;
  #stillSource: HTMLCanvasElement | null = null;
  /** The bare pond, and the pond with its garden, read once per layout. */
  #still: { bare: ImageData; garden: ImageData } | null = null;
  /** Per ink level: cell column, line, and bits (blocks, or dots with bit 8 set). */
  #levels: number[][] = LEVELS.map(() => []);
  #garden: number[] = [];
  #waves: number[] = [];
  #marks: number[] = [];

  /**
   * Paints the rows of `view` into `ctx` as text art in `ink`. `scale` is device
   * pixels per pond pixel; the target canvas is `painter.width * scale` wide.
   */
  paint(
    ctx: CanvasRenderingContext2D,
    painter: PondPainter,
    pond: Pond,
    env: Environment,
    now: number,
    view: View,
    sukui: Sukui | null,
    scale: number,
    ink: string,
  ) {
    const width = painter.width;
    const rows = view.rows;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (width <= 0 || rows <= 0) return;
    const pixelsCtx = this.#pixelContext(width, rows);
    // No wash here: it is applied as lighter ink instead.
    painter.paint(pixelsCtx, pond, env, now, { ...view, scrim: null }, sukui);
    const data = pixelsCtx.getImageData(0, 0, width, rows).data;

    const columns = Math.ceil(width / CELL_W);
    const lines = Math.ceil(rows / CELL_H);
    const levels = this.#levels;
    for (const list of levels) list.length = 0;
    const garden = this.#garden;
    const waves = this.#waves;
    const marks = this.#marks;
    garden.length = 0;
    waves.length = 0;
    marks.length = 0;
    const { bare, garden: still } = this.#stillData(painter) ?? {};
    if (!bare || !still) return;
    const t = now / 1000;

    for (let line = 0; line < lines; line++) {
      for (let column = 0; column < columns; column++) {
        let mask = 0;
        let gardenMask = 0;
        let total = 0;
        let inked = 0;
        for (let i = 0; i < 8; i++) {
          const x = Math.min(width - 1, column * CELL_W + (i & 1));
          const y = Math.min(rows - 1, line * CELL_H + (i >> 1));
          const stillAt = (Math.min(still.height - 1, view.y0 + y) * still.width + x) * 4;
          const diff = difference(data, still.data, (y * width + x) * 4, stillAt);
          if (diff > INK_FROM) {
            mask |= 1 << i;
            total += diff;
            inked++;
          } else if (difference(still.data, bare.data, stillAt, stillAt) > INK_FROM) {
            gardenMask |= 1 << i;
          }
        }
        const shape = shapeOf(mask);
        if (shape.kind === "plain" && gardenMask) {
          // Every other pixel, in a checker, so the garden reads as a soft texture.
          // Cells are an even size, so one mask tiles the whole pond.
          const dots = gardenMask & CHECKER;
          if (dots) garden.push(column, line, dots | 256);
          continue;
        }
        if (shape.kind === "plain") {
          const px = column * CELL_W;
          const py = view.y0 + line * CELL_H;
          if (py > painter.shoreAt(px) + 1) {
            const wave = noise(77, column * 0.16 + t * 0.07, line * 0.55 - t * 0.025);
            if (wave > 0.62) waves.push(column, line, wave > 0.72 ? 1 : 0);
          } else {
            const mark = hash(31, column, line + view.y0);
            if (mark > 0.85) marks.push(column, line, 2 + (Math.floor(mark * 300) % 3));
          }
          continue;
        }
        // Stronger differences (a koi near the surface) ink darker than faint ones (a deep koi).
        const strength = Math.min(1, total / inked / 260);
        const level = Math.min(LEVELS.length - 1, Math.floor(strength * LEVELS.length));
        levels[level]!.push(column, line, shape.kind === "dots" ? shape.mask | 256 : shape.quads);
      }
    }

    const cw = CELL_W * scale;
    const ch = CELL_H * scale;
    const soften = view.scrim ? UNDER_TEXT : 1;
    ctx.fillStyle = ink;
    const dot = Math.max(1, Math.round(scale * 0.55));
    const inset = (scale - dot) / 2;
    [garden, ...levels].forEach((list, index) => {
      ctx.globalAlpha = (index === 0 ? GARDEN_INK : LEVELS[index - 1]!) * soften;
      for (let k = 0; k < list.length; k += 3) {
        const x = list[k]! * cw;
        const y = list[k + 1]! * ch;
        const bits = list[k + 2]!;
        if (bits & 256) {
          // Braille: one small dot for each lone pixel.
          for (let i = 0; i < 8; i++) {
            if (bits & (1 << i)) ctx.fillRect(x + (i & 1) * scale + inset, y + (i >> 1) * scale + inset, dot, dot);
          }
        } else {
          for (let q = 0; q < 4; q++) {
            if (bits & (1 << q)) ctx.fillRect(x + (q & 1) * scale, y + (q >> 1) * 2 * scale, scale, 2 * scale);
          }
        }
      }
    });

    ctx.font = `${Math.round(ch / 1.25)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [list, alpha] of [
      [waves, WAVE_INK],
      [marks, MARK_INK],
    ] as const) {
      ctx.globalAlpha = alpha * soften;
      for (let k = 0; k < list.length; k += 3) {
        ctx.fillText(GLYPHS[list[k + 2]!]!, list[k]! * cw + cw / 2, list[k + 1]! * ch + ch / 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** The still pond's pixels, read once each time the painter lays it out anew. */
  #stillData(painter: PondPainter): { bare: ImageData; garden: ImageData } | null {
    const source = painter.still;
    if (!source) return null;
    if (source !== this.#stillSource) {
      this.#stillSource = source;
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(source, 0, 0);
      const bare = ctx.getImageData(0, 0, source.width, source.height);
      painter.paintGarden(ctx);
      this.#still = { bare, garden: ctx.getImageData(0, 0, source.width, source.height) };
    }
    return this.#still;
  }

  #pixelContext(width: number, height: number): CanvasRenderingContext2D {
    let canvas = this.#pixels;
    if (!canvas) canvas = this.#pixels = document.createElement("canvas");
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    // Read back every frame: keep it on the CPU.
    return canvas.getContext("2d", { willReadFrequently: true })!;
  }
}

const GLYPHS = ["~", "≈", "'", ",", '"'];
