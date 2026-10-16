// Koi-sukui, the festival game of scooping fish with a paper poi, kept to one
// action: the poi moves and dips by itself, koi gather under a still poi, and
// when one is right above it a "!" shows. Tap then to scoop it; tap too soon
// and the koi darts off. Each koi scooped rests in a floating bowl for a
// moment and then goes back. Wet paper weakens, and a big koi strains it, so a
// poi tears now and then and a fresh one comes. Left alone, the poi scoops by
// itself.

import { addRipple, attend, bodyPoint, clamp, placeKoi, type Koi, type Pond } from "./koi.ts";
import type { PoiGrade } from "./config.ts";

export const POI_RADIUS = 4.5;
/** How long a koi stays over the poi: the moment to tap. */
export const BITE_MS = 1_300;
/** After the player's last tap, the poi waits this long before playing by itself. */
export const TAKEOVER_MS = 15_000;
export const BOWL_MS = 14_000;
export const BOWL_CAPACITY = 3;
const NEW_POI_MS = 2_500;
const GLIDE_SPEED = 16;
const SCOOP_DEPTH = 0.45;
/** How long a called koi has to reach the poi before another is called. */
const CALL_MS = 12_000;
const COOLDOWN_MS = 900;

/** Higher numbers are thinner paper, like the poi at a real stall. */
const WEAR: Record<PoiGrade, number> = { "4": 0.65, "5": 1, "6": 1.6 };

export type BowlEntry = { koiId: string; ms: number; angle: number };

type Phase =
  | { kind: "moving" }
  | { kind: "waiting"; ms: number; callAt: number; caller: string | null; calledMs: number }
  | { kind: "bite"; koiId: string; ms: number; autoAt: number }
  | { kind: "cooldown"; ms: number };

export type Sukui = {
  grade: PoiGrade;
  x: number;
  y: number;
  tx: number;
  ty: number;
  phase: Phase;
  /** The poi is under the water (waiting or with a koi above it). */
  dipped: boolean;
  /** What is left of the paper, from 1 (new) to 0 (gone). */
  paper: number;
  torn: boolean;
  /** Time until a fresh poi, after a tear. */
  tornMs: number;
  /** Picks where the paper gives way; changes with each poi. */
  tearSeed: number;
  /** Time since the player last tapped; past TAKEOVER_MS the poi plays by itself. */
  playerMs: number;
  bowl: BowlEntry[];
  bowlX: number;
  bowlY: number;
  /** Rows the poi may move between: the part of the pond in view. */
  minY: number;
  maxY: number;
};

export type SukuiEvent =
  | { type: "dip" }
  | { type: "bite"; koiId: string }
  | { type: "scooped"; koiId: string; auto: boolean }
  | { type: "missed"; koiId: string }
  | { type: "early" }
  | { type: "torn" }
  | { type: "released"; koiId: string };

export function newSukui(grade: PoiGrade, pond: Pond, maxY: number): Sukui {
  const sukui: Sukui = {
    grade,
    x: pond.width * 0.5,
    y: (pond.top + maxY) / 2,
    tx: pond.width * 0.5,
    ty: (pond.top + maxY) / 2,
    phase: { kind: "moving" },
    dipped: false,
    paper: 1,
    torn: false,
    tornMs: 0,
    tearSeed: 1,
    playerMs: TAKEOVER_MS,
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
  sukui.minY = pond.top + 3;
  sukui.maxY = Math.max(sukui.minY + 2, maxY - 3);
  // The bowl floats on the left, clear of the controls at the right.
  sukui.bowlX = 12;
  sukui.bowlY = Math.max(sukui.minY + 4, sukui.maxY - 4);
  sukui.tx = clamp(sukui.tx, 24, Math.max(24, pond.width - 6));
  sukui.ty = clamp(sukui.ty, sukui.minY, sukui.maxY);
}

export function isAuto(sukui: Sukui): boolean {
  return sukui.playerMs >= TAKEOVER_MS;
}

/**
 * The player tapped, anywhere on the water or from the keyboard. With a koi
 * over the poi, that scoops it. Too soon, while a koi is still coming, it
 * startles that koi away and another is called a little later.
 */
export function tap(sukui: Sukui, pond: Pond, rng: () => number): SukuiEvent[] {
  sukui.playerMs = 0;
  const phase = sukui.phase;
  if (phase.kind === "bite") return scoop(sukui, pond, rng, false);
  if (phase.kind !== "waiting" || !phase.caller) return [];
  const caller = pond.koi.find((koi) => koi.id === phase.caller);
  if (caller && !caller.away) startle(caller, sukui, pond);
  phase.caller = null;
  phase.callAt = phase.ms + 1_500;
  addRipple(pond, sukui.x, sukui.y, POI_RADIUS + 2, 5);
  return [{ type: "early" }];
}

function lift(sukui: Sukui) {
  sukui.dipped = false;
  sukui.phase = { kind: "moving" };
}

function wait(sukui: Sukui, rng: () => number) {
  sukui.phase = {
    kind: "waiting",
    ms: 0,
    callAt: 1_500 + rng() * 2_500,
    caller: null,
    calledMs: 0,
  };
}

function scoop(sukui: Sukui, pond: Pond, rng: () => number, auto: boolean): SukuiEvent[] {
  const events: SukuiEvent[] = [];
  if (sukui.phase.kind !== "bite") return events;
  const koi = pond.koi.find((candidate) => candidate.id === (sukui.phase as { koiId: string }).koiId);
  if (!koi) {
    wait(sukui, rng);
    return events;
  }
  // Bigger koi weigh more on the paper.
  sukui.paper -= (koi.length / 14) * 0.3 * WEAR[sukui.grade];
  if (sukui.paper <= 0) {
    // Through the paper and back into the water.
    startle(koi, sukui, pond);
    tear(sukui, pond, events);
    return events;
  }
  if (sukui.bowl.length >= BOWL_CAPACITY) releaseOne(sukui, pond, rng, events);
  koi.away = true;
  koi.chasing = null;
  sukui.bowl.push({ koiId: koi.id, ms: 0, angle: rng() * Math.PI * 2 });
  addRipple(pond, sukui.x, sukui.y, POI_RADIUS + 3, 8);
  addRipple(pond, sukui.bowlX, sukui.bowlY, 7, 6);
  sukui.dipped = false;
  sukui.phase = { kind: "cooldown", ms: 0 };
  events.push({ type: "scooped", koiId: koi.id, auto });
  return events;
}

function startle(koi: Koi, sukui: Sukui, pond: Pond) {
  const dx = koi.x - sukui.x || 1;
  const dy = koi.y - sukui.y;
  const distance = Math.hypot(dx, dy) || 1;
  koi.tx = clamp(koi.x + (dx / distance) * 30, 2, pond.width - 2);
  koi.ty = clamp(koi.y + (dy / distance) * 10, pond.top + 2, pond.height - 2);
  koi.targetSpeed = 8;
  koi.targetDepth = 0.5;
  koi.restMs = 0;
}

function tear(sukui: Sukui, pond: Pond, events: SukuiEvent[]) {
  sukui.paper = 0;
  sukui.torn = true;
  sukui.dipped = false;
  sukui.tornMs = NEW_POI_MS;
  sukui.phase = { kind: "cooldown", ms: 0 };
  addRipple(pond, sukui.x, sukui.y, POI_RADIUS + 4, 7);
  events.push({ type: "torn" });
}

/** Lets every koi out of the bowl, as when the player stops playing. */
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
    const heading = (rng() - 0.5) * 1.2;
    placeKoi(koi, sukui.bowlX + 8, sukui.bowlY + (rng() - 0.5) * 4, heading);
    koi.depth = 0.1;
    koi.targetDepth = 0.4;
    addRipple(pond, koi.x, koi.y, 6, 6);
  }
  events.push({ type: "released", koiId: entry.koiId });
}

/** Where a koi's weight would rest on the poi: a little behind its head. */
function middleOf(koi: Koi) {
  return bodyPoint(koi, koi.length * 0.35);
}

export function stepSukui(sukui: Sukui, pond: Pond, dtMs: number, rng: () => number): SukuiEvent[] {
  const events: SukuiEvent[] = [];
  const dt = dtMs / 1000;
  sukui.playerMs += dtMs;
  const auto = isAuto(sukui);

  for (const entry of sukui.bowl) entry.ms += dtMs;
  while (sukui.bowl[0] && sukui.bowl[0].ms >= BOWL_MS) releaseOne(sukui, pond, rng, events);

  if (sukui.torn) {
    sukui.tornMs -= dtMs;
    if (sukui.tornMs > 0) return events;
    sukui.torn = false;
    sukui.paper = 1;
    sukui.tearSeed++;
    pickSpot(sukui, pond, rng);
    lift(sukui);
  }

  const phase = sukui.phase;
  switch (phase.kind) {
    case "moving": {
      const dx = sukui.tx - sukui.x;
      const dy = sukui.ty - sukui.y;
      const distance = Math.hypot(dx, dy);
      const step = Math.min(distance, GLIDE_SPEED * dt);
      if (distance > 0.01) {
        sukui.x += (dx / distance) * step;
        sukui.y += (dy / distance) * step;
      }
      if (distance - step < 0.3) {
        // Slid in slowly, at a slant, so the paper takes it.
        sukui.dipped = true;
        addRipple(pond, sukui.x, sukui.y, POI_RADIUS + 3, 5);
        events.push({ type: "dip" });
        wait(sukui, rng);
      }
      break;
    }
    case "waiting": {
      phase.ms += dtMs;
      sukui.paper -= 0.022 * WEAR[sukui.grade] * dt;
      if (sukui.paper <= 0) {
        tear(sukui, pond, events);
        break;
      }
      // Koi gather under a still poi.
      attend(pond, sukui.x, sukui.y);
      let caller = phase.caller ? pond.koi.find((koi) => koi.id === phase.caller) : undefined;
      if (caller?.away) caller = undefined;
      if (!caller && phase.ms >= phase.callAt) {
        caller = callKoi(sukui, pond);
        phase.caller = caller?.id ?? null;
        phase.calledMs = 0;
      }
      if (caller) {
        phase.calledMs += dtMs;
        caller.tx = sukui.x + (caller.x - sukui.x) * 0.05;
        caller.ty = sukui.y;
        caller.targetSpeed = 3.5;
        caller.targetDepth = 0.05;
        caller.restMs = 0;
        caller.chasing = null;
        const middle = middleOf(caller);
        const over = Math.hypot(middle.x - sukui.x, middle.y - sukui.y) < POI_RADIUS * 0.85;
        if (over && caller.depth < SCOOP_DEPTH) {
          // Auto play is good, not perfect: now and then it taps too late.
          const autoAt = rng() < 0.8 ? 250 + rng() * 700 : BITE_MS + 1;
          sukui.phase = { kind: "bite", koiId: caller.id, ms: 0, autoAt };
          addRipple(pond, sukui.x, sukui.y, 3, 4);
          events.push({ type: "bite", koiId: caller.id });
        } else if (phase.calledMs > CALL_MS) {
          phase.caller = null;
          phase.callAt = phase.ms + 1_000;
        }
      }
      // The poi moves on from a quiet spot.
      if (phase.ms > 20_000 && !caller) {
        pickSpot(sukui, pond, rng);
        lift(sukui);
      }
      break;
    }
    case "bite": {
      phase.ms += dtMs;
      const koi = pond.koi.find((candidate) => candidate.id === phase.koiId);
      if (koi) {
        // Nibbling at the paper, staying put.
        koi.tx = sukui.x;
        koi.ty = sukui.y;
        koi.targetSpeed = 0.6;
      }
      if (auto && phase.ms >= phase.autoAt) {
        events.push(...scoop(sukui, pond, rng, true));
      } else if (phase.ms >= BITE_MS) {
        if (koi) startle(koi, sukui, pond);
        sukui.paper -= 0.04 * WEAR[sukui.grade];
        events.push({ type: "missed", koiId: phase.koiId });
        wait(sukui, rng);
      }
      break;
    }
    case "cooldown": {
      phase.ms += dtMs;
      if (phase.ms >= COOLDOWN_MS && !sukui.torn) {
        pickSpot(sukui, pond, rng);
        lift(sukui);
      }
      break;
    }
  }
  return events;
}

/** Calls the nearest koi near the surface over to the poi. */
function callKoi(sukui: Sukui, pond: Pond): Koi | undefined {
  let best: Koi | undefined;
  let bestDistance = Infinity;
  for (const koi of pond.koi) {
    if (koi.away) continue;
    const distance = Math.hypot(koi.x - sukui.x, koi.y - sukui.y);
    if (distance < bestDistance) {
      best = koi;
      bestDistance = distance;
    }
  }
  return best;
}

/** Picks the poi's next spot near where the koi are, inside the view. */
function pickSpot(sukui: Sukui, pond: Pond, rng: () => number) {
  const swimming = pond.koi.filter((koi) => !koi.away);
  const near = swimming[Math.floor(rng() * swimming.length)];
  const x = near ? near.x + (rng() - 0.5) * 30 : rng() * pond.width;
  const y = near ? near.y + (rng() - 0.5) * 8 : (sukui.minY + sukui.maxY) / 2;
  sukui.tx = clamp(x, 26, Math.max(26, pond.width - 8));
  sukui.ty = clamp(y, sukui.minY, sukui.maxY);
}
