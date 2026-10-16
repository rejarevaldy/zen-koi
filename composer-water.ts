// The pond continued inside the chat input: a canvas behind the editor, found
// through bb's markup (see composer-dom.ts). The strip's loop paints it with
// the rows of the same pond that lie below the strip, under a wash of the
// chat input's own background so the text stays easy to read.

import { findComposerSurface } from "./composer-dom.ts";
import { PIXEL_SCALE } from "./scene.ts";

const LAYER_SELECTOR = "[data-zen-koi-water]";
const FADE_MS = 1_200;
const STYLE_CHECK_MS = 1_000;

export class ComposerWater {
  readonly canvas: HTMLCanvasElement;
  readonly #surface: HTMLElement;
  readonly #layer: HTMLDivElement;
  #background = "#ffffff";
  #dark = false;
  #checkedAt = -Infinity;
  #removeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(surface: HTMLElement) {
    this.#surface = surface;
    // A layer left by an earlier copy of the plugin (a reload) goes first.
    for (const old of surface.querySelectorAll(LAYER_SELECTOR)) old.remove();
    const layer = document.createElement("div");
    layer.dataset.zenKoiWater = "";
    layer.setAttribute("aria-hidden", "true");
    // Below the editor's content but above the form's own background, inside
    // the stacking context `isolation: isolate` gives the form.
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "-1",
      borderRadius: "inherit",
      overflow: "hidden",
      pointerEvents: "none",
      opacity: "0",
      transition: `opacity ${FADE_MS}ms ease`,
    });
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      display: "block",
      width: "100%",
      height: "100%",
      imageRendering: "pixelated",
    });
    layer.append(canvas);
    this.canvas = canvas;
    this.#layer = layer;
    surface.dataset.zenKoiIsolation ??= surface.style.isolation;
    surface.style.isolation = "isolate";
    surface.append(layer);
    requestAnimationFrame(() => {
      layer.style.opacity = "1";
    });
  }

  get connected(): boolean {
    return this.#layer.isConnected;
  }

  /** The chat input's size in pond pixels. */
  size(): { width: number; height: number } {
    return {
      width: Math.max(8, Math.ceil(this.#layer.clientWidth / PIXEL_SCALE)),
      height: Math.max(4, Math.ceil(this.#layer.clientHeight / PIXEL_SCALE)),
    };
  }

  /** The chat input's background and scheme, rechecked now and then for theme changes. */
  look(now: number): { background: string; dark: boolean } {
    if (now - this.#checkedAt >= STYLE_CHECK_MS) {
      this.#checkedAt = now;
      this.#dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
      const own = getComputedStyle(this.#surface).backgroundColor;
      const transparent = own === "transparent" || own.endsWith(", 0)");
      this.#background = transparent ? (this.#dark ? "#18181b" : "#ffffff") : own;
    }
    return { background: this.#background, dark: this.#dark };
  }

  /** Fades the water out, then takes the layer away. */
  remove(): void {
    this.#layer.style.opacity = "0";
    clearTimeout(this.#removeTimer);
    this.#removeTimer = setTimeout(() => {
      this.#layer.remove();
      const surface = this.#surface;
      if (!surface.querySelector(LAYER_SELECTOR) && surface.dataset.zenKoiIsolation !== undefined) {
        surface.style.isolation = surface.dataset.zenKoiIsolation;
        delete surface.dataset.zenKoiIsolation;
      }
    }, FADE_MS);
  }
}

export function attachComposerWater(from: Element): ComposerWater | null {
  const surface = findComposerSurface(from);
  return surface ? new ComposerWater(surface) : null;
}
