// The pond's life: koi wandering, food, ripples, rain, and whatever the season
// lets fall on the water. Plain data stepped in place, with no DOM. One pond can
// span the strip and the chat input below it, so it uses world coordinates in
// pond pixels and leaves the drawing to scene.ts.

import { koiLength, type KoiEntry, type Season, type TimeOfDay, type VarietyId, type Weather } from "./config.ts";

export type Point = { x: number; y: number };

export type Koi = {
  id: string;
  variety: VarietyId;
  /** Picks this koi's patch shapes; derived from the id, so it never changes. */
  seed: number;
  /** Body length in pond pixels, head to the base of the tail. */
  length: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  targetSpeed: number;
  tx: number;
  ty: number;
  /** Drives the body's sway. */
  phase: number;
  /** 0 at the surface, up to 1 near the bottom. */
  depth: number;
  targetDepth: number;
  /** Time left drifting in place before the next wander. */
  restMs: number;
  /** The food this koi is swimming to, if any. */
  chasing: number | null;
  /** Time until a fast, shallow koi leaves another small wake ring. */
  wakeMs: number;
  /** Resting in the sukui bowl, out of the pond for a moment. */
  away: boolean;
  /** Points behind the head, 1 px apart, newest first. */
  trail: Point[];
};

export type Food = { id: number; x: number; y: number; ageMs: number };
export type Ripple = { x: number; y: number; ageMs: number; maxRadius: number; speed: number };
/**
 * One point of the wake a stroke leaves: the direction the stroke was moving,
 * and how strong it was (0.35 for a slow stroke, up to 1 for a quick one).
 */
export type WakePoint = { x: number; y: number; dx: number; dy: number; strength: number; ageMs: number };
export type DriftKind = "petal" | "leaf" | "snow" | "firefly";
export type Drift = {
  kind: DriftKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Where a falling drift meets the water. */
  landY: number;
  landed: boolean;
  ageMs: number;
  lifeMs: number;
  /** Picks one of the kind's colors and a little of its motion. */
  tint: number;
};

export type Region = { x0: number; x1: number; y0: number; y1: number };

export type Pond = {
  width: number;
  height: number;
  /** Highest row koi may reach; the shore is above it. */
  top: number;
  /** Koi spend most of their time above this row, where the pond is in view. */
  focusBottom: number;
  koi: Koi[];
  food: Food[];
  ripples: Ripple[];
  /** The wake of a pointer stroked through the water, newest last. */
  wake: WakePoint[];
  drifts: Drift[];
  nextFoodId: number;
  /** Time until a koi next sips at the surface. */
  ambientMs: number;
  /** Time until the season drops the next petal, leaf, flake, or firefly. */
  driftMs: number;
  /** Time until the next raindrop lands, while it rains. */
  rainMs: number;
  /** Where the pointer rests; curious koi drift over. */
  attention: (Point & { ms: number }) | null;
  /** Where the overhanging tree drops most of its petals and leaves. */
  canopy: Region | null;
};

export type StepContext = {
  rng: () => number;
  season: Season;
  timeOfDay: TimeOfDay;
  weather: Weather;
  /** How hard it rains, 0.3 to 1; full rain if left out. */
  rain?: number;
};

/** Food and floating things slide this way, very slowly. */
const CURRENT = { x: 0.3, y: 0.06 };
const MARGIN = 4;
const MAX_FOOD = 15;
const MAX_RIPPLES = 40;
const MAX_DRIFTS = 50;
const FOOD_LIFE_MS = 40_000;
const EAT_DISTANCE = 2;
const ATTENTION_MS = 2_500;
const ATTENTION_REACH = 55;

export function newPond(width: number, height: number, top: number, focusBottom = height): Pond {
  return {
    width,
    height,
    top,
    focusBottom,
    koi: [],
    food: [],
    ripples: [],
    wake: [],
    drifts: [],
    nextFoodId: 1,
    ambientMs: 4_000,
    driftMs: 800,
    rainMs: 0,
    attention: null,
    canopy: null,
  };
}

/** A stable number from a koi id, so its patches look the same everywhere. */
export function seedOf(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

/**
 * Matches the pond's koi to the player's list: new koi swim in, released ones
 * leave, and the rest keep swimming where they are.
 */
export function syncKoi(pond: Pond, entries: readonly KoiEntry[], now: number, rng: () => number) {
  const kept = new Map(pond.koi.map((koi) => [koi.id, koi]));
  pond.koi = entries.map((entry) => {
    const length = koiLength(entry.addedAt, now);
    const existing = kept.get(entry.id);
    if (existing) {
      existing.variety = entry.variety;
      existing.length = length;
      return existing;
    }
    return newKoi(pond, entry, length, rng);
  });
}

/** A koi outside any pond, for portraits. */
export function portraitKoi(id: string, variety: VarietyId, length: number): Koi {
  return {
    id,
    variety,
    seed: seedOf(id),
    length,
    x: 0,
    y: 0,
    heading: 0,
    speed: 0,
    targetSpeed: 0,
    tx: 0,
    ty: 0,
    phase: 1.2,
    depth: 0,
    targetDepth: 0,
    restMs: 0,
    chasing: null,
    wakeMs: 0,
    away: false,
    trail: [],
  };
}

function newKoi(pond: Pond, entry: KoiEntry, length: number, rng: () => number): Koi {
  const heading = rng() * Math.PI * 2;
  const x = MARGIN + rng() * Math.max(1, pond.width - MARGIN * 2);
  const y = focusY(pond, rng);
  const koi: Koi = {
    id: entry.id,
    variety: entry.variety,
    seed: seedOf(entry.id),
    length,
    x,
    y,
    heading,
    speed: 2,
    targetSpeed: 4,
    tx: x,
    ty: y,
    phase: rng() * Math.PI * 2,
    depth: 0.3 + rng() * 0.3,
    targetDepth: rng() * 0.5,
    restMs: 0,
    chasing: null,
    wakeMs: 0,
    away: false,
    trail: [],
  };
  placeKoi(koi, x, y, heading);
  wander(pond, koi, rng);
  return koi;
}

/** Puts a koi somewhere new, its body trailing straight behind its heading. */
export function placeKoi(koi: Koi, x: number, y: number, heading: number) {
  koi.x = x;
  koi.y = y;
  koi.tx = x + Math.cos(heading) * 20;
  koi.ty = y + Math.sin(heading) * 6;
  koi.heading = heading;
  koi.trail = [];
  for (let step = 1; step <= koi.length + 6; step++) {
    koi.trail.push({ x: x - Math.cos(heading) * step, y: y - Math.sin(heading) * step });
  }
}

/** A row where koi are happy to be; mostly in view. */
function focusY(pond: Pond, rng: () => number): number {
  const low = pond.top + 2;
  const inView = Math.max(low + 1, Math.min(pond.height - 2, pond.focusBottom - 3));
  const high = rng() < 0.75 ? inView : pond.height - 2;
  return low + rng() * Math.max(0, high - low);
}

function wander(pond: Pond, koi: Koi, rng: () => number) {
  // Now and then, swim over to keep another koi company.
  const friend = rng() < 0.25 ? pond.koi[Math.floor(rng() * pond.koi.length)] : undefined;
  if (friend && friend !== koi && !friend.away) {
    koi.tx = clamp(friend.x + (rng() - 0.5) * 16, MARGIN, pond.width - MARGIN);
    koi.ty = clamp(friend.y + (rng() - 0.5) * 8, pond.top + 2, pond.height - 2);
  } else {
    koi.tx = MARGIN + rng() * Math.max(1, pond.width - MARGIN * 2);
    koi.ty = focusY(pond, rng);
  }
  koi.targetSpeed = 2.5 + rng() * 3.5;
}

/** Keeps koi and food inside a pond that changed size. */
export function resizePond(
  pond: Pond,
  width: number,
  height: number,
  focusBottom: number,
  rng: () => number,
) {
  if (width === pond.width && height === pond.height && focusBottom === pond.focusBottom) return;
  pond.width = width;
  pond.height = height;
  pond.focusBottom = focusBottom;
  for (const koi of pond.koi) {
    koi.x = clamp(koi.x, 1, width - 1);
    koi.y = clamp(koi.y, pond.top + 2, height - 1);
    if (koi.tx > width - MARGIN || koi.ty > height - 2) wander(pond, koi, rng);
  }
  pond.food = pond.food.filter((food) => food.x < width && food.y < height);
}

/** How long a stroke's wake lingers on the water. */
export const WAKE_MS = 2_600;
const MAX_WAKE = 600;

/** Adds a point to the wake of a stroke moving along (dx, dy), a unit direction. */
export function addWake(pond: Pond, x: number, y: number, dx: number, dy: number, strength = 1) {
  pond.wake.push({ x, y, dx, dy, strength, ageMs: 0 });
  if (pond.wake.length > MAX_WAKE) pond.wake.shift();
}

/** Above this speed (pond pixels a second), a stroke startles koi close to it. */
const STARTLE_SPEED = 25;

/**
 * A stick drawn through the water at (x, y), moving along (dx, dy) at `speed`
 * pond pixels a second: floating food and petals near it are carried along,
 * and koi close to a quick stroke dart away, then settle by themselves.
 */
export function stir(pond: Pond, x: number, y: number, dx: number, dy: number, speed: number) {
  const push = Math.min(1.2, speed / 60);
  const carry = (thing: { x: number; y: number }) => {
    const distance = Math.hypot(thing.x - x, thing.y - y);
    if (distance > 5) return;
    const falloff = 1 - distance / 5;
    thing.x = clamp(thing.x + dx * push * falloff, 1, pond.width - 1);
    thing.y = clamp(thing.y + dy * push * falloff * 0.8, pond.top + 1, pond.height - 1);
  };
  for (const food of pond.food) carry(food);
  for (const drift of pond.drifts) if (drift.landed) carry(drift);
  if (speed < STARTLE_SPEED) return;
  for (const koi of pond.koi) {
    if (koi.away) continue;
    const away = Math.hypot(koi.x - x, koi.y - y);
    if (away > 8) continue;
    const ux = (koi.x - x) / (away || 1);
    const uy = (koi.y - y) / (away || 1);
    koi.tx = clamp(koi.x + ux * 22, 2, pond.width - 2);
    koi.ty = clamp(koi.y + uy * 8, pond.top + 2, pond.height - 2);
    koi.targetSpeed = 7;
    koi.restMs = 0;
    koi.chasing = null;
  }
}

export function addRipple(pond: Pond, x: number, y: number, maxRadius = 6, speed = 7) {
  pond.ripples.push({ x, y, ageMs: 0, maxRadius, speed });
  if (pond.ripples.length > MAX_RIPPLES) pond.ripples.shift();
}

/** Scatters a small pinch of food around a point on the water. */
export function dropFood(pond: Pond, x: number, y: number, rng: () => number) {
  const cy = clamp(y, pond.top + 2, pond.height - 2);
  addRipple(pond, x, cy, 7);
  for (let index = 0; index < 3; index++) {
    pond.food.push({
      id: pond.nextFoodId++,
      x: x + (rng() - 0.5) * 7,
      y: clamp(cy + (rng() - 0.5) * 5, pond.top + 2, pond.height - 2),
      ageMs: 0,
    });
  }
  while (pond.food.length > MAX_FOOD) pond.food.shift();
}

/** The pointer is resting over the water; nearby koi come to look. */
export function attend(pond: Pond, x: number, y: number) {
  pond.attention = { x, y: clamp(y, pond.top + 2, pond.height - 2), ms: ATTENTION_MS };
}

export function stepPond(pond: Pond, dtMs: number, context: StepContext) {
  const { rng } = context;
  const dt = dtMs / 1000;

  for (const food of pond.food) {
    food.ageMs += dtMs;
    food.x += CURRENT.x * dt;
    food.y += CURRENT.y * dt;
  }
  pond.food = pond.food.filter(
    (food) => food.ageMs < FOOD_LIFE_MS && food.x < pond.width + 2 && food.y < pond.height,
  );
  assignFood(pond);

  if (pond.attention) {
    pond.attention.ms -= dtMs;
    if (pond.attention.ms <= 0) pond.attention = null;
  }

  for (const koi of pond.koi) if (!koi.away) stepKoi(pond, koi, dt, rng);

  for (const ripple of pond.ripples) ripple.ageMs += dtMs;
  for (const point of pond.wake) point.ageMs += dtMs;
  while (pond.wake[0] && pond.wake[0].ageMs >= WAKE_MS) pond.wake.shift();
  pond.ripples = pond.ripples.filter(
    (ripple) => (ripple.ageMs / 1000) * ripple.speed < ripple.maxRadius,
  );

  pond.ambientMs -= dtMs;
  if (pond.ambientMs <= 0) {
    pond.ambientMs = 5_000 + rng() * 9_000;
    const koi = pond.koi[Math.floor(rng() * pond.koi.length)];
    if (koi && !koi.away && koi.depth < 0.35) addRipple(pond, koi.x, koi.y, 4, 5);
  }

  if (context.weather === "rain") {
    pond.rainMs -= dtMs;
    // Wider ponds catch more rain, and harder rain lands more often.
    const interval = (90 * 260) / Math.max(80, pond.width * (pond.height / 32)) / (context.rain ?? 1);
    while (pond.rainMs <= 0) {
      pond.rainMs += interval * (0.4 + rng() * 1.2);
      addRipple(
        pond,
        rng() * pond.width,
        pond.top + rng() * (pond.height - pond.top),
        2 + rng() * 2,
        5,
      );
    }
  }

  stepDrifts(pond, dtMs, context);
}

/** Each loose piece of food draws the nearest koi that is not already eating. */
function assignFood(pond: Pond) {
  const ids = new Set(pond.food.map((food) => food.id));
  for (const koi of pond.koi) {
    if (koi.chasing !== null && !ids.has(koi.chasing)) koi.chasing = null;
  }
  const taken = new Set(pond.koi.map((koi) => koi.chasing));
  for (const food of pond.food) {
    if (taken.has(food.id)) continue;
    let nearest: Koi | null = null;
    let best = Infinity;
    for (const koi of pond.koi) {
      if (koi.chasing !== null || koi.away) continue;
      const distance = Math.hypot(koi.x - food.x, koi.y - food.y);
      if (distance < best) {
        best = distance;
        nearest = koi;
      }
    }
    if (!nearest) return;
    nearest.chasing = food.id;
    nearest.restMs = 0;
    taken.add(food.id);
  }
}

function stepKoi(pond: Pond, koi: Koi, dt: number, rng: () => number) {
  const food = koi.chasing === null ? undefined : pond.food.find((f) => f.id === koi.chasing);
  let targetSpeed = koi.targetSpeed;
  let turnRate = 0.85;
  const attention = pond.attention;
  if (food) {
    koi.tx = food.x;
    koi.ty = food.y;
    targetSpeed = 9;
    turnRate = 1.8;
    koi.targetDepth = 0;
  } else if (
    attention &&
    Math.hypot(attention.x - koi.x, attention.y - koi.y) < ATTENTION_REACH &&
    rng() < dt * 0.8
  ) {
    // Curious, not greedy: stop just short of the pointer.
    koi.tx = attention.x + (rng() - 0.5) * 10;
    koi.ty = clamp(attention.y + (rng() - 0.5) * 6, pond.top + 2, pond.height - 2);
    koi.targetSpeed = 4 + rng() * 2;
    koi.targetDepth = 0.1;
    koi.restMs = 0;
  } else if (koi.restMs > 0) {
    koi.restMs -= dt * 1000;
    targetSpeed = 0.8;
    if (koi.restMs <= 0) wander(pond, koi, rng);
  }

  const desired = Math.atan2(koi.ty - koi.y, koi.tx - koi.x);
  let turn = wrapAngle(desired - koi.heading);
  // Give way to a koi just ahead.
  for (const other of pond.koi) {
    if (other === koi || other.away) continue;
    const dx = other.x - koi.x;
    const dy = other.y - koi.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0 && distance < 5) {
      const bearing = wrapAngle(Math.atan2(dy, dx) - koi.heading);
      if (Math.abs(bearing) < 1.2) turn -= Math.sign(bearing || 1) * 0.8;
    }
  }
  if (koi.restMs <= 0 || food) {
    koi.heading += clamp(turn, -turnRate * dt, turnRate * dt);
  } else {
    // Resting koi drift a little, never quite still.
    koi.heading += Math.sin(koi.phase * 0.3) * 0.12 * dt;
  }
  // Ease off through a sharp turn so the body curves instead of pivoting.
  const turning = Math.min(Math.abs(turn), Math.PI / 2);
  const cruise = targetSpeed * (0.45 + 0.55 * Math.cos(turning));
  koi.speed += (cruise - koi.speed) * Math.min(1, dt * 0.8);

  koi.x += Math.cos(koi.heading) * koi.speed * dt;
  koi.y += Math.sin(koi.heading) * koi.speed * dt;
  const minY = pond.top + 2;
  const maxY = pond.height - 1;
  if (koi.x < 1 || koi.x > pond.width - 1 || koi.y < minY || koi.y > maxY) {
    koi.x = clamp(koi.x, 1, pond.width - 1);
    koi.y = clamp(koi.y, minY, maxY);
    if (!food) wander(pond, koi, rng);
  }

  koi.phase += dt * (1.3 + koi.speed * 0.45);
  if (rng() < dt / 14) koi.targetDepth = rng() * 0.65;
  koi.depth += (koi.targetDepth - koi.depth) * Math.min(1, dt * 0.25);

  koi.wakeMs -= dt * 1000;
  if (koi.speed > 5 && koi.depth < 0.2 && koi.wakeMs <= 0) {
    koi.wakeMs = 450;
    addRipple(pond, koi.x, koi.y, 3, 5);
  }

  const distance = Math.hypot(koi.tx - koi.x, koi.ty - koi.y);
  if (food && distance < EAT_DISTANCE) {
    pond.food = pond.food.filter((f) => f.id !== food.id);
    addRipple(pond, food.x, food.y, 4, 6);
    koi.chasing = null;
    koi.restMs = 1_200 + rng() * 1_500;
  } else if (!food && koi.restMs <= 0 && distance < 3) {
    if (rng() < 0.4) koi.restMs = 2_000 + rng() * 4_000;
    else wander(pond, koi, rng);
  }

  followHead(koi);
}

/** Lays the trail behind the head in 1 px steps, so the body bends through turns. */
function followHead(koi: Koi) {
  const keep = koi.length + 7;
  let first = koi.trail[0];
  if (!first) {
    koi.trail.push({ x: koi.x, y: koi.y });
    return;
  }
  let distance = Math.hypot(koi.x - first.x, koi.y - first.y);
  let added = 0;
  while (distance >= 1 && added < keep) {
    const next = {
      x: first.x + (koi.x - first.x) / distance,
      y: first.y + (koi.y - first.y) / distance,
    };
    koi.trail.unshift(next);
    first = next;
    distance -= 1;
    added++;
  }
  if (koi.trail.length > keep) koi.trail.length = keep;
}

/** The point `s` pixels behind the head, along the trail. */
export function bodyPoint(koi: Koi, s: number): Point {
  let previous: Point = { x: koi.x, y: koi.y };
  let remaining = s;
  for (const point of koi.trail) {
    const length = Math.hypot(point.x - previous.x, point.y - previous.y);
    if (length >= remaining && length > 0) {
      const t = remaining / length;
      return {
        x: previous.x + (point.x - previous.x) * t,
        y: previous.y + (point.y - previous.y) * t,
      };
    }
    remaining -= length;
    previous = point;
  }
  return previous;
}

const DRIFT_LIFE_MS: Record<DriftKind, number> = {
  petal: 20_000,
  leaf: 24_000,
  snow: 0,
  firefly: 11_000,
};

function stepDrifts(pond: Pond, dtMs: number, { rng, season, timeOfDay }: StepContext) {
  const dt = dtMs / 1000;
  const kind = driftKindFor(season, timeOfDay);
  pond.driftMs -= dtMs;
  if (pond.driftMs <= 0) {
    pond.driftMs = driftInterval(kind, pond.width, rng);
    if (kind && pond.drifts.length < MAX_DRIFTS) pond.drifts.push(newDrift(pond, kind, rng));
  }

  for (const drift of pond.drifts) {
    drift.ageMs += dtMs;
    if (drift.kind === "firefly") {
      drift.vx = clamp(drift.vx + (rng() - 0.5) * 6 * dt, -3, 3);
      drift.vy = clamp(drift.vy + (rng() - 0.5) * 6 * dt, -2, 2);
      drift.x += drift.vx * dt;
      drift.y = clamp(drift.y + drift.vy * dt, 1, pond.height - 2);
    } else if (!drift.landed) {
      // Petals and leaves flutter side to side on the way down.
      const flutter = drift.kind === "snow" ? 0.4 : 2.2;
      drift.x += (drift.vx + Math.sin(drift.ageMs / 380 + drift.tint) * flutter) * dt;
      drift.y += drift.vy * dt;
      if (drift.y >= drift.landY) {
        drift.landed = true;
        drift.ageMs = 0;
        if (drift.kind !== "snow") addRipple(pond, drift.x, drift.y, 3, 4);
      }
    } else {
      drift.x += CURRENT.x * dt;
      drift.y += CURRENT.y * dt;
    }
  }
  pond.drifts = pond.drifts.filter(
    (drift) =>
      drift.x < pond.width + 4 &&
      drift.x > -8 &&
      !(drift.kind === "snow" && drift.landed) &&
      !((drift.landed || drift.kind === "firefly") && drift.ageMs >= drift.lifeMs),
  );
}

export function driftKindFor(season: Season, time: TimeOfDay): DriftKind | null {
  switch (season) {
    case "spring":
      return "petal";
    case "summer":
      return time === "dusk" || time === "night" ? "firefly" : null;
    case "autumn":
      return "leaf";
    case "winter":
      return "snow";
  }
}

function driftInterval(kind: DriftKind | null, width: number, rng: () => number): number {
  // Wider ponds see a little more fall on them.
  const scale = 260 / Math.max(100, width);
  switch (kind) {
    case "snow":
      return (280 + rng() * 450) * scale;
    case "petal":
      return (1_000 + rng() * 2_200) * scale;
    case "leaf":
      return (2_200 + rng() * 3_800) * scale;
    case "firefly":
      return 1_400 + rng() * 2_400;
    case null:
      return 2_000;
  }
}

function newDrift(pond: Pond, kind: DriftKind, rng: () => number): Drift {
  const landY = pond.top + 2 + rng() * Math.max(1, pond.height - pond.top - 4);
  const tint = Math.floor(rng() * 6);
  if (kind === "firefly") {
    return {
      kind,
      x: rng() * pond.width,
      y: 2 + rng() * (pond.height - 4),
      vx: (rng() - 0.5) * 2,
      vy: (rng() - 0.5) * 2,
      landY,
      landed: false,
      ageMs: 0,
      lifeMs: DRIFT_LIFE_MS.firefly * (0.6 + rng() * 0.8),
      tint,
    };
  }
  const vy = kind === "snow" ? 4 + rng() * 3 : 3 + rng() * 2;
  const vx = kind === "snow" ? 0.5 + rng() * 1.5 : 2 + rng() * 3;
  // Most petals and leaves come off the overhanging tree.
  const canopy = pond.canopy;
  if (canopy && kind !== "snow" && rng() < 0.8) {
    const y = canopy.y0 + rng() * (canopy.y1 - canopy.y0);
    return {
      kind,
      x: canopy.x0 + rng() * (canopy.x1 - canopy.x0),
      y,
      vx,
      vy,
      landY: Math.max(landY, y + 4 + rng() * 10),
      landed: false,
      ageMs: 0,
      lifeMs: DRIFT_LIFE_MS[kind] * (0.7 + rng() * 0.6),
      tint,
    };
  }
  const fallMs = ((landY + 2) / vy) * 1000;
  return {
    kind,
    x: rng() * pond.width - (vx * fallMs) / 1000 / 2,
    y: -2,
    vx,
    vy,
    landY,
    landed: false,
    ageMs: 0,
    lifeMs: DRIFT_LIFE_MS[kind] * (0.7 + rng() * 0.6),
    tint,
  };
}

export type BreathPhase = "in" | "hold" | "out";
export const BREATH_IN_MS = 4_000;
export const BREATH_HOLD_MS = 2_000;
export const BREATH_OUT_MS = 6_000;
export const BREATH_CYCLE_MS = BREATH_IN_MS + BREATH_HOLD_MS + BREATH_OUT_MS;

/**
 * A slow breath, five a minute, with a longer out-breath. `fullness` is how
 * full the lungs are, from 0 to 1.
 */
export function breathAt(ms: number): { phase: BreathPhase; fullness: number } {
  const t = ((ms % BREATH_CYCLE_MS) + BREATH_CYCLE_MS) % BREATH_CYCLE_MS;
  if (t < BREATH_IN_MS) return { phase: "in", fullness: smooth(t / BREATH_IN_MS) };
  if (t < BREATH_IN_MS + BREATH_HOLD_MS) return { phase: "hold", fullness: 1 };
  return {
    phase: "out",
    fullness: 1 - smooth((t - BREATH_IN_MS - BREATH_HOLD_MS) / BREATH_OUT_MS),
  };
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A small seeded generator, so a pond's stones and pads stay put across frames. */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
