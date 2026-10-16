// The "Text" look: the pond as quiet ASCII art in the theme's own text color.
// Each character cell covers 2x4 pond pixels. Only a few things are drawn, so
// the koi stay easy to see:
// - each koi is a little fish, longer as it grows (`><>`, `><('>`, `><(('>`),
//   facing the way it swims and fainter the deeper it is
// - open water carries a few slow waves (`~`), the bank a few marks (`. '`)
// - in catch: the poi `( )`, a `!` when a koi is over it, and the bowl

import { hash, noise, type PondPainter, type View } from "./scene.ts";
import type { Koi, Pond } from "./koi.ts";
import { POI_RADIUS, type Sukui } from "./sukui.ts";

export const CELL_W = 2;
export const CELL_H = 4;
const KOI_INK = 1;
const DEEP_KOI_INK = 0.45;
const THING_INK = 0.85;
const WAVE_INK = 0.3;
const MARK_INK = 0.35;
/** Under the chat input's text the ink is lighter, so the text stays easy to read. */
const UNDER_TEXT = 0.5;

/** A koi as an ASCII fish: longer as it grows, facing the way it swims. */
export function fishFor(length: number, facingRight: boolean): string {
  const right = length >= 13 ? "><(('>" : length >= 11 ? "><('>" : "><>";
  if (facingRight) return right;
  const mirror: Record<string, string> = { ">": "<", "<": ">", "(": ")", ")": "(" };
  return [...right].reverse().map((char) => mirror[char] ?? char).join("");
}

type Mark = { column: number; line: number; text: string; ink: number };

export class TextPainter {
  #marks: Mark[] = [];

  /**
   * Paints the rows of `view` into `ctx` as ASCII art in `ink`. `scale` is device
   * pixels per pond pixel; the target canvas is `painter.width * scale` wide.
   */
  paint(
    ctx: CanvasRenderingContext2D,
    painter: PondPainter,
    pond: Pond,
    now: number,
    view: View,
    sukui: Sukui | null,
    scale: number,
    ink: string,
  ) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const width = painter.width;
    if (width <= 0 || view.rows <= 0) return;
    const marks = this.#marks;
    marks.length = 0;
    const columns = Math.ceil(width / CELL_W);
    const lines = Math.ceil(view.rows / CELL_H);
    const lineOf = (y: number) => Math.floor((y - view.y0) / CELL_H);
    const columnOf = (x: number) => Math.floor(x / CELL_W);
    const put = (x: number, y: number, text: string, ink: number, centered = true) => {
      const line = lineOf(y);
      if (line < 0 || line >= lines) return;
      marks.push({ column: columnOf(x) - (centered ? Math.floor(text.length / 2) : 0), line, text, ink });
    };

    // Water and bank, sparse and slow.
    const t = now / 1000;
    for (let line = 0; line < lines; line++) {
      const y = view.y0 + line * CELL_H;
      for (let column = 0; column < columns; column++) {
        if (y > painter.shoreAt(column * CELL_W) + 1) {
          const wave = noise(77, column * 0.12 + t * 0.06, line * 0.5 - t * 0.02);
          if (wave > 0.72 && hash(5, column, line) > 0.35) marks.push({ column, line, text: "~", ink: WAVE_INK });
        } else if (hash(31, column, line + view.y0) > 0.9) {
          marks.push({ column, line, text: hash(32, column, line) > 0.5 ? "." : "'", ink: MARK_INK });
        }
      }
    }

    for (const food of pond.food) put(food.x, food.y, ".", THING_INK);

    if (sukui) {
      put(sukui.bowlX, sukui.bowlY, sukui.bowl.length > 0 ? "\\><>/" : "\\___/", THING_INK);
      if (!sukui.torn) {
        put(sukui.x, sukui.y, "( )", THING_INK);
        if (sukui.phase.kind === "bite") put(sukui.x, sukui.y - POI_RADIUS - 2, "!", KOI_INK);
      }
    }

    // Deepest first, so a koi near the surface is drawn over one below it.
    const koi = pond.koi.filter((fish) => !fish.away).sort((a, b) => b.depth - a.depth);
    for (const fish of koi) this.#fish(fish, put);

    // Later marks win their cells: waves under things, things under koi.
    const cw = CELL_W * scale;
    const ch = CELL_H * scale;
    const taken = new Map<number, Mark & { char: string }>();
    for (const mark of marks) {
      for (let i = 0; i < mark.text.length; i++) {
        const column = mark.column + i;
        if (column < 0 || column >= columns || mark.text[i] === " ") continue;
        taken.set(mark.line * columns + column, { ...mark, char: mark.text[i]! });
      }
    }
    ctx.fillStyle = ink;
    ctx.font = `600 ${Math.round(cw / 0.6)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const scrim = view.scrim;
    for (const [key, mark] of taken) {
      const line = Math.floor(key / columns);
      const column = key % columns;
      // The wash over the chat input fades in from scrim.start to scrim.full.
      const y = view.y0 + line * CELL_H;
      const under = scrim ? Math.min(1, Math.max(0, (y - scrim.start) / Math.max(1, scrim.full - scrim.start))) : 0;
      ctx.globalAlpha = mark.ink * (1 - under * (1 - UNDER_TEXT));
      ctx.fillText(mark.char, column * cw + cw / 2, line * ch + ch / 2);
    }
    ctx.globalAlpha = 1;
  }

  #fish(fish: Koi, put: (x: number, y: number, text: string, ink: number, centered?: boolean) => void) {
    const right = Math.cos(fish.heading) >= 0;
    const text = fishFor(fish.length, right);
    const ink = KOI_INK - (KOI_INK - DEEP_KOI_INK) * fish.depth;
    // x, y is the head: the fish trails behind it.
    const start = right ? fish.x - (text.length - 1) * CELL_W : fish.x;
    put(start, fish.y, text, ink, false);
  }
}
