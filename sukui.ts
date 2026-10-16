// Koi-sukui, the festival game of scooping fish with a paper poi, played gently:
// every koi scooped rests in a floating bowl for a moment and then goes back.
// The rules follow how the game is really played. A quick or splashy entry
// tears the paper, the paper weakens the longer it stays wet, fish flee a
// moving poi but gather under a still one, only fish near the surface can be
// lifted, and a fish lifted on the rim strains the paper less.

import { addRipple, attend, bodyPoint, clamp, placeKoi, type Koi, type Pond } from "./koi.ts";
import type { PoiGrade } from "./config.ts";

export const POI_RADIUS = 4.5;
/** How quickly the poi catches up with the pointer, per second. */
const FOLLOW = 9;
/** Entering the water faster than this (pond px/s) costs paper. */
const SAFE_ENTRY_SPEED = 14;
/** Moving faster than this under water costs paper and scares the koi. */
const SAFE_SWEEP_SPEED = 11;
const STILL_SPEED = 2;
const STILL_MS = 700;
const FLEE_REACH = 16;
export const IDLE_TO_AUTO_MS = 12_000;
export const BOWL_MS = 14_000;
export const BOWL_CAPACITY = 3;
const NEW_POI_MS = 2_500;
const AUTO_SPEED = 7;
const SCOOP_DEPTH = 0.45;

/** Higher numbers are thinner paper, like the poi at a real stall. */
const WEAR: Record<PoiGrade, number> = { "4": 0.65, "5": 1, "6": 1.6 };

export type BowlEntry = { koiId: string; ms: number; angle: number };
type Auto = { koiId: string; phase: "approach" | "wait" | "dip"; ms: number };

export type Sukui = {
  grade: PoiGrade;
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** How fast the poi moves, smoothed, in pond px/s. */
  speed: number;
  stillMs: number;
  dipped: boolean;
  dippedMs: number;
  /** What is left of the paper, from 1 (new) to 0 (gone). */
  paper: number;
  torn: boolean;
  /** Time until a fresh poi, after a tear. */
  tornMs: number;
  /** Picks where the paper gives way; changes with each poi. */
  tearSeed: number;
  /** Time since the player last moved or pressed. */
  idleMs: number;
  autoEnabled: boolean;
  auto: Auto | null;
  bowl: BowlEntry[];
  bowlX: number;
  bowlY: number;
  /** Rows the poi may move between: the part of the pond in view. */
  minY: number;
  maxY: number;
};

export type SukuiEvent =
  | { type: "dip" }
  | { type: "scooped"; koiId: string; auto: boolean }
  | { type: "torn" }
  | { type: "missed" }
  | { type: "released"; koiId: string };

export function newSukui(grade: PoiGrade, pond: Pond, maxY: number): Sukui {
  const x = pond.width * 0.55;
  const y = (pond.top + maxY) / 2;
  const sukui: Sukui = {
    grade,
    x,
    y,
    tx: x,
    ty: y,
    speed: 0,
    stillMs: 0,
    dipped: false,
    dippedMs: 0,
    paper: 1,
    torn: false,
    tornMs: 0,
    tearSeed: 1,
    // Start watching: the poi plays by itself until the player takes it.
    idleMs: IDLE_TO_AUTO_MS,
    autoEnabled: true,
    auto: null,
    bowl: [],
    bowlX: 0,
    bowlY: 0,
    minY: pond.top + 1,
    maxY,
  };
  fitSukui(sukui, pond, maxY);
  return sukui;
}

/** Keeps the poi and the bowl inside a pond that changed size. */
export function fitSukui(sukui: Sukui, pond: Pond, maxY: number) {
  sukui.minY = pond.top + 1;
  sukui.maxY = Math.max(sukui.minY + 2, maxY - 1);
  sukui.bowlX = pond.width - 12;
  sukui.bowlY = Math.max(sukui.minY + 6, sukui.maxY - 7);
  sukui.tx = clamp(sukui.tx, 0, pond.width);
  sukui.ty = clamp(sukui.ty, sukui.minY, sukui.maxY);
}

/** The player moved the pointer: the poi follows, and auto play stops. */
export function aim(sukui: Sukui, x: number, y: number) {
  sukui.tx = x;
  sukui.ty = clamp(y, sukui.minY, sukui.maxY);
  sukui.idleMs = 0;
  sukui.auto = null;
}

export function dip(sukui: Sukui, pond: Pond, events: SukuiEvent[] = []): SukuiEvent[] {
  if (sukui.dipped || sukui.torn) return events;
  sukui.dipped = true;
  sukui.dippedMs = 0;
  addRipple(pond, sukui.x, sukui.y, POI_RADIUS + 3, 6);
  if (sukui.speed > SAFE_ENTRY_SPEED) {
    sukui.paper -= (sukui.speed - SAFE_ENTRY_SPEED) * 0.012 * WEAR[sukui.grade];
  }
  events.push({ type: "dip" });
  checkTear(sukui, pond, events);
  return events;
}

/** Lifts the poi out, with the koi above it if there is one near the surface. */
export function lift(sukui: Sukui, pond: Pond, rng: () => number, auto = false): SukuiEvent[] {
  const events: SukuiEvent[] = [];
  if (!sukui.dipped || sukui.torn) return events;
  sukui.dipped = false;
  let best: Koi | null = null;
  let bestDistance = Infinity;
  for (const koi of pond.koi) {
    if (isAway(sukui, koi.id) || koi.depth > SCOOP_DEPTH) continue;
    const middle = bodyPoint(koi, koi.length * 0.35);
    const distance = Math.hypot(middle.x - sukui.x, middle.y - sukui.y);
    if (distance < POI_RADIUS + 0.5 && distance < bestDistance) {
      best = koi;
      bestDistance = distance;
    }
  }
  if (!best) {
    events.push({ type: "missed" });
    return events;
  }
  // Bigger koi weigh more; resting one on the rim spares the paper.
  const onRim = bestDistance > POI_RADIUS * 0.55;
  sukui.paper -= (best.length / 14) * 0.32 * WEAR[sukui.grade] * (onRim ? 0.6 : 1);
  if (sukui.paper <= 0) {
    // Through the paper and back into the water.
    best.targetDepth = 0.6;
    checkTear(sukui, pond, events);
    return events;
  }
  if (sukui.bowl.length >= BOWL_CAPACITY) releaseOne(sukui, pond, rng, events);
  best.away = true;
  best.chasing = null;
  sukui.bowl.push({ koiId: best.id, ms: 0, angle: rng() * Math.PI * 2 });
  addRipple(pond, sukui.x, sukui.y, POI_RADIUS + 2, 8);
  addRipple(pond, sukui.bowlX, sukui.bowlY, 7, 6);
  events.push({ type: "scooped", koiId: best.id, auto });
  return events;
}

function isAway(sukui: Sukui, koiId: string): boolean {
  return sukui.bowl.some((entry) => entry.koiId === koiId);
}

/** Lets every koi in the bowl go, as when the player stops playing. */
export function releaseAll(sukui: Sukui, pond: Pond, rng: () => number): SukuiEvent[] {
  const events: SukuiEvent[] = [];
  while (sukui.bowl.length > 0) releaseOne(sukui, pond, rng, events);
  return events;
}

function releaseOne(sukui: Sukui, pond: Pond, rng: () => number, events: SukuiEvent[]) {
  const entry = sukui.bowl.shift();
  if (!entry) return;
  const koi = pond.koi.find((candidate) => candidate.id === entry.koiId);
  if (koi) {
    koi.away = false;
    // Slipped back over the bowl's rim, heading for open water.
    const heading = Math.PI + (rng() - 0.5) * 1.2;
    placeKoi(koi, sukui.bowlX - 7, sukui.bowlY + (rng() - 0.5) * 4, heading);
    koi.depth = 0.1;
    koi.targetDepth = 0.4;
    addRipple(pond, koi.x, koi.y, 6, 6);
  }
  events.push({ type: "released", koiId: entry.koiId });
}

function checkTear(sukui: Sukui, pond: Pond, events: SukuiEvent[]) {
  if (sukui.paper > 0 || sukui.torn) return;
  sukui.paper = 0;
  sukui.torn = true;
  sukui.dipped = false;
  sukui.tornMs = NEW_POI_MS;
  sukui.auto = null;
  addRipple(pond, sukui.x, sukui.y, POI_RADIUS + 4, 7);
  events.push({ type: "torn" });
}

export function stepSukui(sukui: Sukui, pond: Pond, dtMs: number, rng: () => number): SukuiEvent[] {
  const events: SukuiEvent[] = [];
  const dt = dtMs / 1000;
  sukui.idleMs += dtMs;

  if (sukui.torn) {
    sukui.tornMs -= dtMs;
    if (sukui.tornMs <= 0) {
      sukui.torn = false;
      sukui.paper = 1;
      sukui.tearSeed++;
    }
  }

  if (sukui.autoEnabled && sukui.idleMs >= IDLE_TO_AUTO_MS && !sukui.torn) {
    stepAuto(sukui, pond, dtMs, rng, events);
  }

  // Follow the target; auto play moves at a slow, steady pace instead.
  const beforeX = sukui.x;
  const beforeY = sukui.y;
  if (sukui.idleMs >= IDLE_TO_AUTO_MS) {
    const dx = sukui.tx - sukui.x;
    const dy = sukui.ty - sukui.y;
    const distance = Math.hypot(dx, dy);
    const step = Math.min(distance, AUTO_SPEED * dt);
    if (distance > 0) {
      sukui.x += (dx / distance) * step;
      sukui.y += (dy / distance) * step;
    }
  } else {
    const follow = Math.min(1, dt * FOLLOW);
    sukui.x += (sukui.tx - sukui.x) * follow;
    sukui.y += (sukui.ty - sukui.y) * follow;
  }
  const moved = dt > 0 ? Math.hypot(sukui.x - beforeX, sukui.y - beforeY) / dt : 0;
  sukui.speed += (moved - sukui.speed) * Math.min(1, dt * 8);
  sukui.stillMs = sukui.speed < STILL_SPEED ? sukui.stillMs + dtMs : 0;

  if (sukui.dipped) {
    sukui.dippedMs += dtMs;
    // Wet paper weakens with time, and faster when dragged through the water.
    const wear = WEAR[sukui.grade];
    sukui.paper -= 0.04 * wear * dt;
    if (sukui.speed > SAFE_SWEEP_SPEED) {
      sukui.paper -= (sukui.speed - SAFE_SWEEP_SPEED) * 0.006 * wear * dt;
    }
    checkTear(sukui, pond, events);
  }

  // Koi dart away from a poi swept through the water, and gather under a still one.
  if (sukui.dipped && sukui.speed > SAFE_SWEEP_SPEED) {
    for (const koi of pond.koi) {
      const dx = koi.x - sukui.x;
      const dy = koi.y - sukui.y;
      const distance = Math.hypot(dx, dy);
      if (distance > FLEE_REACH || distance === 0 || isAway(sukui, koi.id)) continue;
      koi.tx = clamp(koi.x + (dx / distance) * 24, 2, pond.width - 2);
      koi.ty = clamp(koi.y + (dy / distance) * 12, pond.top + 2, pond.height - 2);
      koi.targetSpeed = 8;
      koi.targetDepth = 0.6;
      koi.restMs = 0;
    }
  } else if (sukui.stillMs > STILL_MS && !sukui.torn) {
    attend(pond, sukui.x, sukui.y);
  }

  for (const entry of sukui.bowl) entry.ms += dtMs;
  while (sukui.bowl[0] && sukui.bowl[0].ms >= BOWL_MS) releaseOne(sukui, pond, rng, events);
  return events;
}

/** Plays by itself: drift ahead of a koi near the surface, wait, then scoop. */
function stepAuto(sukui: Sukui, pond: Pond, dtMs: number, rng: () => number, events: SukuiEvent[]) {
  let plan = sukui.auto;
  const koi = plan ? pond.koi.find((candidate) => candidate.id === plan!.koiId) : undefined;
  if (!plan || !koi || isAway(sukui, koi.id)) {
    const choices = pond.koi.filter(
      (candidate) =>
        !isAway(sukui, candidate.id) &&
        candidate.y >= sukui.minY &&
        candidate.y <= sukui.maxY,
    );
    const next = choices[Math.floor(rng() * choices.length)];
    sukui.auto = next ? { koiId: next.id, phase: "approach", ms: 0 } : null;
    return;
  }
  plan.ms += dtMs;
  const middle = bodyPoint(koi, koi.length * 0.35);
  switch (plan.phase) {
    case "approach": {
      // Wait where the koi is heading, not where it is.
      sukui.tx = clamp(koi.x + Math.cos(koi.heading) * 8, 2, pond.width - 2);
      sukui.ty = clamp(koi.y + Math.sin(koi.heading) * 5, sukui.minY, sukui.maxY);
      if (Math.hypot(sukui.tx - sukui.x, sukui.ty - sukui.y) < 1.5 || plan.ms > 9_000) {
        plan.phase = "wait";
        plan.ms = 0;
      }
      break;
    }
    case "wait": {
      sukui.tx = sukui.x;
      sukui.ty = sukui.y;
      const close = Math.hypot(middle.x - sukui.x, middle.y - sukui.y) < POI_RADIUS * 0.7;
      if (close && koi.depth < SCOOP_DEPTH) {
        dip(sukui, pond, events);
        plan.phase = "dip";
        plan.ms = 0;
      } else if (plan.ms > 6_000) {
        sukui.auto = null;
      }
      break;
    }
    case "dip": {
      if (plan.ms > 380) {
        events.push(...lift(sukui, pond, rng, true));
        sukui.auto = null;
      }
      break;
    }
  }
}

export { NEW_POI_MS };
