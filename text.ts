// The "Text" look: the same pond as monochrome ASCII art in the theme's own
// text color. Each character cell covers 2x4 pond pixels:
// - what moves (koi, the poi, the bowl, ripples) is inked where it differs from
//   the still garden, with a denser character the more of the cell it fills
//   (`. : - = + * # @`)
// - the garden (lily pads, the tree) is a lighter `.` and `:`
// - open water carries slow waves (`~ -`), the bank a few marks (`. , '`)

import { hash, noise, type Environment, type PondPainter, type View } from "./scene.ts";
import type { Pond } from "./koi.ts";
import type { Sukui } from "./sukui.ts";

export const CELL_W = 2;
export const CELL_H = 4;
/** A pixel this far (summed channels) from the still pond is inked. */
const INK_FROM = 60;
/** By how many of a cell's eight pixels are inked: 1 to 8. */
export const RAMP = ".:-=+*#@";
const GARDEN = ".:";
const WAVES = "~-";
const MARKS = ".,'";
/** Ink for each layer, boldest first. */
const BOLD_INK = 0.95;
const GARDEN_INK = 0.5;
const WATER_INK = 0.4;
/** Under the chat input's text the ink is lighter, so the text stays easy to read. */
const UNDER_TEXT = 0.5;

/** The character for a cell with `inked` of its eight pixels inked (0 is blank). */
export function rampChar(inked: number): string {
  return inked <= 0 ? " " : RAMP[Math.min(RAMP.length, inked) - 1]!;
}

function difference(data: Uint8ClampedArray, still: Uint8ClampedArray, at: number, stillAt: number): number {
  return (
    Math.abs(data[at]! - still[stillAt]!) +
    Math.abs(data[at + 1]! - still[stillAt + 1]!) +
    Math.abs(data[at + 2]! - still[stillAt + 2]!)
  );
}

type Layer = { ink: number; cells: (number | string)[] };

export class TextPainter {
  #pixels: HTMLCanvasElement | null = null;
  #stillSource: HTMLCanvasElement | null = null;
  /** The bare pond, and the pond with its garden, read once per layout. */
  #still: { bare: ImageData; garden: ImageData } | null = null;
  #bold: Layer = { ink: BOLD_INK, cells: [] };
  #garden: Layer = { ink: GARDEN_INK, cells: [] };
  #water: Layer = { ink: WATER_INK, cells: [] };

  /**
   * Paints the rows of `view` into `ctx` as ASCII art in `ink`. `scale` is device
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
    const still = this.#stillData(painter);
    if (width <= 0 || rows <= 0 || !still) return;
    const pixelsCtx = this.#pixelContext(width, rows);
    // No wash here: it is applied as lighter ink instead.
    painter.paint(pixelsCtx, pond, env, now, { ...view, scrim: null }, sukui);
    const data = pixelsCtx.getImageData(0, 0, width, rows).data;
    const { bare, garden } = still;

    const bold = this.#bold.cells;
    const leaves = this.#garden.cells;
    const water = this.#water.cells;
    bold.length = 0;
    leaves.length = 0;
    water.length = 0;
    const columns = Math.ceil(width / CELL_W);
    const lines = Math.ceil(rows / CELL_H);
    const t = now / 1000;

    for (let line = 0; line < lines; line++) {
      for (let column = 0; column < columns; column++) {
        let inked = 0;
        let planted = 0;
        for (let i = 0; i < 8; i++) {
          const x = Math.min(width - 1, column * CELL_W + (i & 1));
          const y = Math.min(rows - 1, line * CELL_H + (i >> 1));
          const stillAt = (Math.min(garden.height - 1, view.y0 + y) * garden.width + x) * 4;
          if (difference(data, garden.data, (y * width + x) * 4, stillAt) > INK_FROM) inked++;
          else if (difference(garden.data, bare.data, stillAt, stillAt) > INK_FROM) planted++;
        }
        if (inked > 0) {
          bold.push(column, line, rampChar(inked));
        } else if (planted > 0) {
          leaves.push(column, line, GARDEN[planted >= 4 ? 1 : 0]!);
        } else if (view.y0 + line * CELL_H > painter.shoreAt(column * CELL_W) + 1) {
          const wave = noise(77, column * 0.16 + t * 0.07, line * 0.55 - t * 0.025);
          if (wave > 0.6) water.push(column, line, WAVES[wave > 0.7 ? 0 : 1]!);
        } else {
          const mark = hash(31, column, line + view.y0);
          if (mark > 0.8) water.push(column, line, MARKS[Math.floor(mark * 300) % MARKS.length]!);
        }
      }
    }

    const cw = CELL_W * scale;
    const ch = CELL_H * scale;
    const soften = view.scrim ? UNDER_TEXT : 1;
    ctx.fillStyle = ink;
    ctx.font = `600 ${Math.round(ch * 0.85)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const layer of [this.#water, this.#garden, this.#bold]) {
      ctx.globalAlpha = layer.ink * soften;
      const cells = layer.cells;
      for (let k = 0; k < cells.length; k += 3) {
        ctx.fillText(cells[k + 2] as string, (cells[k] as number) * cw + cw / 2, (cells[k + 1] as number) * ch + ch / 2);
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
