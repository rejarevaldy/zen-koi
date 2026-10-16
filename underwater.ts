// Floods the chat input while the pond is open: a translucent layer behind the
// editor with a few koi of its own, found through bb's markup (see
// composer-dom.ts). It changes nothing else, and does nothing when that markup
// is not recognized.

import { findComposerSurface } from "./composer-dom.ts";
import { newPond, resizePond, seasonOf, stepPond, timeOfDay, type Pond } from "./koi.ts";
import { UnderwaterScene } from "./scene.ts";

/** Time for the water to rise from empty to full; draining takes the same. */
export const FLOOD_MS = 1_400;
const FRAME_MS = 33;
/** Under reduced motion nothing swims, but resizes still redraw. */
const STILL_FRAME_MS = 500;
const SCHEME_CHECK_MS = 1_000;
const MAX_STEP_MS = 100;
const LAYER_SELECTOR = "[data-zen-koi-underwater]";

export type FloodOptions = { isReducedMotion: () => boolean };

/** Moves a water level toward its target at a constant rate. */
export function approach(level: number, target: number, dt: number): number {
  const step = dt / FLOOD_MS;
  return level < target ? Math.min(target, level + step) : Math.max(target, level - step);
}

const floods = new WeakMap<HTMLElement, Flood>();

/**
 * Starts filling the composer next to `from`. Returns a function that drains
 * it, or null when no composer surface can be found.
 */
export function flood(from: Element, options: FloodOptions): (() => void) | null {
  const surface = findComposerSurface(from);
  if (!surface) return null;
  let current = floods.get(surface);
  if (!current) {
    current = new Flood(surface);
    floods.set(surface, current);
  }
  const owner = current;
  owner.fill(options);
  return () => owner.drain();
}

class Flood {
  readonly #surface: HTMLElement;
  readonly #layer: HTMLDivElement;
  readonly #scene: UnderwaterScene;
  #pond: Pond | null = null;
  #options: FloodOptions | null = null;
  #level = 0;
  #target = 0;
  #frame = 0;
  #lastTick = 0;
  #lastDraw = 0;
  #dark = false;
  #schemeCheckedAt = -Infinity;

  constructor(surface: HTMLElement) {
    this.#surface = surface;
    const layer = document.createElement("div");
    layer.dataset.zenKoiUnderwater = "";
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
    });
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      display: "block",
      width: "100%",
      height: "100%",
      imageRendering: "pixelated",
    });
    layer.append(canvas);
    this.#layer = layer;
    this.#scene = new UnderwaterScene(canvas);
  }

  fill(options: FloodOptions): void {
    this.#options = options;
    this.#target = 1;
    if (!this.#layer.isConnected) {
      // The original value lives on the element, not in this instance: after a
      // plugin reload, the old bundle's drain can still be running.
      const surface = this.#surface;
      surface.dataset.zenKoiIsolation ??= surface.style.isolation;
      surface.style.isolation = "isolate";
      surface.append(this.#layer);
    }
    this.#start();
  }

  drain(): void {
    this.#target = 0;
    this.#start();
  }

  #start(): void {
    if (this.#frame !== 0) return;
    this.#lastTick = performance.now();
    this.#frame = requestAnimationFrame(this.#tick);
  }

  #remove(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#layer.remove();
    floods.delete(this.#surface);
    const surface = this.#surface;
    if (!surface.querySelector(LAYER_SELECTOR) && surface.dataset.zenKoiIsolation !== undefined) {
      surface.style.isolation = surface.dataset.zenKoiIsolation;
      delete surface.dataset.zenKoiIsolation;
    }
  }

  readonly #tick = (now: number): void => {
    this.#frame = 0;
    if (!this.#surface.isConnected) {
      this.#remove();
      return;
    }
    const reducedMotion = this.#options?.isReducedMotion() ?? false;
    const dt = Math.min(MAX_STEP_MS, now - this.#lastTick);
    this.#lastTick = now;
    this.#level = reducedMotion ? this.#target : approach(this.#level, this.#target, dt);
    if (this.#level === 0 && this.#target === 0) {
      this.#remove();
      return;
    }

    const scene = this.#scene;
    scene.resize(this.#layer.clientWidth, this.#layer.clientHeight);
    // A couple of koi, fewer than the pond, so the text stays the main thing.
    if (!this.#pond) this.#pond = newPond(scene.width, scene.height, 1, Math.random, 2);
    const pond = this.#pond;
    resizePond(pond, scene.width, Math.random);
    pond.height = scene.height;
    if (!reducedMotion) {
      const date = new Date();
      stepPond(pond, dt, { rng: Math.random, season: seasonOf(date), timeOfDay: timeOfDay(date) });
      // The flood keeps only its koi: petals and ripples belong to the pond.
      pond.drifts.length = 0;
      pond.ripples.length = 0;
    }

    const interval = reducedMotion ? STILL_FRAME_MS : FRAME_MS;
    if (now - this.#lastDraw >= interval && document.visibilityState === "visible") {
      this.#lastDraw = now;
      if (now - this.#schemeCheckedAt >= SCHEME_CHECK_MS) {
        this.#schemeCheckedAt = now;
        this.#dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
      }
      scene.draw({ pond, level: ease(this.#level), dark: this.#dark, now });
    }
    this.#frame = requestAnimationFrame(this.#tick);
  };
}

function ease(level: number): number {
  return level * level * (3 - 2 * level);
}
