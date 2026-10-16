// The pond's life: koi wandering, food, ripples, and whatever the season lets
// fall on the water. Plain data stepped in place, with no DOM, so the strip and
// the flooded chat input can each run their own pond.

export type Season = "spring" | "summer" | "autumn" | "winter";
export type TimeOfDay = "dawn" | "day" | "dusk" | "night";

export const SEASONS: readonly Season[] = ["spring", "summer", "autumn", "winter"];

export type VarietyId =
  | "kohaku"
  | "tancho"
  | "sanke"
  | "showa"
  | "ogon"
  | "yamabuki"
  | "asagi"
  | "chagoi"
  | "shiro-utsuri"
  | "kumonryu";

export const VARIETIES: readonly VarietyId[] = [
  "kohaku",
  "tancho",
  "ogon",
  "showa",
  "asagi",
  "yamabuki",
  "sanke",
  "chagoi",
  "shiro-utsuri",
  "kumonryu",
];

export type Point = { x: number; y: number };

export type Koi = {
  variety: VarietyId;
  /** Picks this koi's patch shapes. */
  seed: number;
  /** Body length in logical pixels, head to the base of the tail. */
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
  /** 0 at the surface, up to 1 deep in the water. */
  depth: number;
  targetDepth: number;
  /** Time left drifting in place before the next wander. */
  restMs: number;
  /** The food this koi is swimming to, if any. */
  chasing: number | null;
  /** Points behind the head, 1 px apart, newest first. */
  trail: Point[];
};

export type Food = { id: number; x: number; y: number; ageMs: number };
export type Ripple = { x: number; y: number; ageMs: number; maxRadius: number; speed: number };
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
  /** Picks one of the kind's colors. */
  tint: number;
};

export type Pond = {
  width: number;
  height: number;
  /** First row of water; rows above are the bank. */
  top: number;
  koi: Koi[];
  food: Food[];
  ripples: Ripple[];
  drifts: Drift[];
  nextFoodId: number;
  /** Time until a koi next sips at the surface. */
  ambientMs: number;
  /** Time until the season drops the next petal, leaf, flake, or firefly. */
  driftMs: number;
};

export type StepContext = { rng: () => number; season: Season; timeOfDay: TimeOfDay };

/** Food and floating things slide this way, very slowly. */
const CURRENT = { x: 0.35, y: 0.05 };
const MARGIN = 5;
const MAX_FOOD = 12;
const MAX_RIPPLES = 16;
const MAX_DRIFTS = 40;
const FOOD_LIFE_MS = 30_000;
const EAT_DISTANCE = 2;

export function seasonOf(date: Date): Season {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

export function timeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 17) return "day";
  if (hour >= 17 && hour < 19) return "dusk";
  return "night";
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
  if (t < BREATH_IN_MS) return { phase: "in", fullness: ease(t / BREATH_IN_MS) };
  if (t < BREATH_IN_MS + BREATH_HOLD_MS) return { phase: "hold", fullness: 1 };
  return { phase: "out", fullness: 1 - ease((t - BREATH_IN_MS - BREATH_HOLD_MS) / BREATH_OUT_MS) };
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/** About one koi per 55 px of pond, three to six. */
export function koiCountFor(width: number): number {
  return Math.max(3, Math.min(6, Math.round(width / 55)));
}

export function newPond(
  width: number,
  height: number,
  top: number,
  rng: () => number,
  count = koiCountFor(width),
): Pond {
  const pond: Pond = {
    width,
    height,
    top,
    koi: [],
    food: [],
    ripples: [],
    drifts: [],
    nextFoodId: 1,
    ambientMs: 3_000 + rng() * 5_000,
    driftMs: 1_000,
  };
  // Shuffle so neighboring ponds rarely share the same first koi.
  const varieties = [...VARIETIES].sort(() => rng() - 0.5);
  for (let index = 0; index < count; index++) {
    pond.koi.push(newKoi(pond, varieties[index % varieties.length]!, rng));
  }
  return pond;
}

function newKoi(pond: Pond, variety: VarietyId, rng: () => number): Koi {
  const heading = rng() * Math.PI * 2;
  const x = MARGIN + rng() * Math.max(1, pond.width - MARGIN * 2);
  const y = waterY(pond, rng());
  const koi: Koi = {
    variety,
    seed: Math.floor(rng() * 1_000_000),
    length: 10 + Math.floor(rng() * 4),
    x,
    y,
    heading,
    speed: 3,
    targetSpeed: 4,
    tx: x,
    ty: y,
    phase: rng() * Math.PI * 2,
    depth: rng() * 0.5,
    targetDepth: rng() * 0.5,
    restMs: 0,
    chasing: null,
    trail: [],
  };
  // Start straight, trailing behind the heading.
  for (let step = 1; step <= koi.length + 4; step++) {
    koi.trail.push({ x: x - Math.cos(heading) * step, y: y - Math.sin(heading) * step });
  }
  wander(pond, koi, rng);
  return koi;
}

function waterY(pond: Pond, fraction: number): number {
  const low = pond.top + 3;
  const high = pond.height - 2;
  return low + fraction * Math.max(0, high - low);
}

function wander(pond: Pond, koi: Koi, rng: () => number) {
  koi.tx = MARGIN + rng() * Math.max(1, pond.width - MARGIN * 2);
  koi.ty = waterY(pond, rng());
  koi.targetSpeed = 3 + rng() * 4;
}

/** Keeps koi and food inside a pond whose strip changed size. */
export function resizePond(pond: Pond, width: number, rng: () => number) {
  if (width === pond.width) return;
  pond.width = width;
  for (const koi of pond.koi) {
    if (koi.x > width - 2) koi.x = width - 2;
    if (koi.tx > width - MARGIN) wander(pond, koi, rng);
  }
  pond.food = pond.food.filter((food) => food.x < width);
}

export function addRipple(pond: Pond, x: number, y: number, maxRadius = 6, speed = 7) {
  pond.ripples.push({ x, y, ageMs: 0, maxRadius, speed });
  if (pond.ripples.length > MAX_RIPPLES) pond.ripples.shift();
}

/** Scatters a small pinch of food around a point on the water. */
export function dropFood(pond: Pond, x: number, y: number, rng: () => number) {
  const cy = Math.min(pond.height - 2, Math.max(pond.top + 2, y));
  addRipple(pond, x, cy, 7);
  for (let index = 0; index < 3; index++) {
    pond.food.push({
      id: pond.nextFoodId++,
      x: x + (rng() - 0.5) * 6,
      y: Math.min(pond.height - 2, Math.max(pond.top + 2, cy + (rng() - 0.5) * 4)),
      ageMs: 0,
    });
  }
  while (pond.food.length > MAX_FOOD) pond.food.shift();
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

  for (const koi of pond.koi) stepKoi(pond, koi, dt, rng);

  for (const ripple of pond.ripples) ripple.ageMs += dtMs;
  pond.ripples = pond.ripples.filter(
    (ripple) => (ripple.ageMs / 1000) * ripple.speed < ripple.maxRadius,
  );

  pond.ambientMs -= dtMs;
  if (pond.ambientMs <= 0) {
    pond.ambientMs = 5_000 + rng() * 9_000;
    const koi = pond.koi[Math.floor(rng() * pond.koi.length)];
    if (koi && koi.depth < 0.3) addRipple(pond, koi.x, koi.y, 4, 5);
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
      if (koi.chasing !== null) continue;
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
  let turnRate = 0.9;
  if (food) {
    koi.tx = food.x;
    koi.ty = food.y;
    targetSpeed = 10;
    turnRate = 1.8;
    koi.targetDepth = 0;
  } else if (koi.restMs > 0) {
    koi.restMs -= dt * 1000;
    targetSpeed = 1;
    if (koi.restMs <= 0) wander(pond, koi, rng);
  }

  const desired = Math.atan2(koi.ty - koi.y, koi.tx - koi.x);
  const turn = wrapAngle(desired - koi.heading);
  if (koi.restMs <= 0 || food) {
    koi.heading += clamp(turn, -turnRate * dt, turnRate * dt);
  } else {
    // Resting koi drift a little, not quite still.
    koi.heading += Math.sin(koi.phase * 0.3) * 0.1 * dt;
  }
  // Ease off through a sharp turn so the body curves instead of pivoting.
  const turning = Math.min(Math.abs(turn), Math.PI / 2);
  const cruise = targetSpeed * (0.45 + 0.55 * Math.cos(turning));
  koi.speed += (cruise - koi.speed) * Math.min(1, dt * 0.9);

  koi.x += Math.cos(koi.heading) * koi.speed * dt;
  koi.y += Math.sin(koi.heading) * koi.speed * dt;
  const minY = pond.top + 2;
  const maxY = pond.height - 1;
  if (koi.x < 1 || koi.x > pond.width - 1 || koi.y < minY || koi.y > maxY) {
    koi.x = clamp(koi.x, 1, pond.width - 1);
    koi.y = clamp(koi.y, minY, maxY);
    if (!food) wander(pond, koi, rng);
  }

  koi.phase += dt * (1.4 + koi.speed * 0.45);
  if (rng() < dt / 14) koi.targetDepth = rng() * 0.6;
  koi.depth += (koi.targetDepth - koi.depth) * Math.min(1, dt * 0.25);

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
  const keep = koi.length + 5;
  let first = koi.trail[0];
  if (!first) {
    koi.trail.push({ x: koi.x, y: koi.y });
    return;
  }
  let distance = Math.hypot(koi.x - first.x, koi.y - first.y);
  let added = 0;
  while (distance >= 1 && added < keep) {
    const next = {
      x: first.x + ((koi.x - first.x) / distance) * 1,
      y: first.y + ((koi.y - first.y) / distance) * 1,
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
  petal: 18_000,
  leaf: 22_000,
  snow: 0,
  firefly: 10_000,
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
      drift.vx += (rng() - 0.5) * 6 * dt;
      drift.vy += (rng() - 0.5) * 6 * dt;
      drift.vx = clamp(drift.vx, -3, 3);
      drift.vy = clamp(drift.vy, -2, 2);
      drift.x += drift.vx * dt;
      drift.y = clamp(drift.y + drift.vy * dt, 1, pond.height - 2);
    } else if (!drift.landed) {
      drift.x += drift.vx * dt;
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
      drift.x > -6 &&
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
  const scale = 300 / Math.max(120, width);
  switch (kind) {
    case "snow":
      return (300 + rng() * 500) * scale;
    case "petal":
      return (1_200 + rng() * 2_500) * scale;
    case "leaf":
      return (2_500 + rng() * 4_000) * scale;
    case "firefly":
      return 1_500 + rng() * 2_500;
    case null:
      return 2_000;
  }
}

function newDrift(pond: Pond, kind: DriftKind, rng: () => number): Drift {
  const landY = waterY(pond, rng());
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
      tint: Math.floor(rng() * 3),
    };
  }
  // Falling things come in from above the strip, sliding with the breeze.
  const vy = kind === "snow" ? 5 + rng() * 3 : 3 + rng() * 2;
  const vx = kind === "snow" ? 1 + rng() * 2 : 3 + rng() * 4;
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
    tint: Math.floor(rng() * 3),
  };
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value: number, low: number, high: number): number {
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
