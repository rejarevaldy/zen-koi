import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig, koiLength, rainIntensity, type KoiEntry } from "./config.ts";
import {
  BREATH_CYCLE_MS,
  BREATH_IN_MS,
  breathAt,
  dropFood,
  newPond,
  resizePond,
  seededRng,
  seedOf,
  stepPond,
  stir,
  syncKoi,
  type Pond,
  type StepContext,
} from "./koi.ts";

const DAY = 86_400_000;
const context = (seed: number, extra: Partial<StepContext> = {}): StepContext => ({
  rng: seededRng(seed),
  season: "spring",
  timeOfDay: "day",
  weather: "clear",
  ...extra,
});

function pondWith(width: number, height: number, seed: number, focusBottom = height): Pond {
  const pond = newPond(width, height, 8, focusBottom);
  syncKoi(pond, defaultConfig(0).koi, 20 * DAY, seededRng(seed));
  return pond;
}

test("koi stay in the water for a long swim", () => {
  const pond = pondWith(300, 60, 1, 32);
  const step = context(2, { season: "winter", weather: "rain" });
  for (let tick = 0; tick < 20_000; tick++) {
    stepPond(pond, 33, step);
    for (const koi of pond.koi) {
      assert.ok(koi.x >= 1 && koi.x <= pond.width - 1, `x ${koi.x}`);
      assert.ok(koi.y >= pond.top + 2 && koi.y <= pond.height - 1, `y ${koi.y}`);
      assert.ok(koi.trail.length <= koi.length + 7);
    }
  }
  assert.ok(pond.ripples.length <= 40);
  assert.ok(pond.drifts.length <= 50);
});

test("koi spend most of their time in view", () => {
  const pond = pondWith(260, 60, 3, 32);
  const step = context(4);
  let inView = 0;
  let samples = 0;
  for (let tick = 0; tick < 30_000; tick++) {
    stepPond(pond, 33, step);
    if (tick % 10 === 0) {
      for (const koi of pond.koi) {
        samples++;
        if (koi.y < 32) inView++;
      }
    }
  }
  assert.ok(inView / samples > 0.55, `in view ${inView / samples}`);
});

test("koi come and eat scattered food", () => {
  const rng = seededRng(5);
  const pond = pondWith(240, 32, 5);
  dropFood(pond, 120, 20, rng);
  assert.equal(pond.food.length, 3);
  const step = context(6);
  for (let tick = 0; tick < 40_000 / 33 && pond.food.length > 0; tick++) stepPond(pond, 33, step);
  assert.equal(pond.food.length, 0);
});

test("a smaller pond pulls its koi back in", () => {
  const rng = seededRng(7);
  const pond = pondWith(400, 60, 7);
  pond.koi[0]!.x = 390;
  pond.koi[0]!.y = 58;
  resizePond(pond, 200, 32, 32, rng);
  for (let tick = 0; tick < 300; tick++) stepPond(pond, 33, context(8));
  assert.ok(pond.koi.every((koi) => koi.x <= 199 && koi.y <= 31));
});

test("the koi list decides who swims, and koi keep their place", () => {
  const rng = seededRng(9);
  const pond = pondWith(200, 32, 9);
  const first = pond.koi[0]!;
  const x = first.x;
  const entries: KoiEntry[] = [
    { ...defaultConfig(0).koi[0]!, variety: "ogon" },
    { id: "new-one", variety: "asagi", name: "Ao", addedAt: 20 * DAY },
  ];
  syncKoi(pond, entries, 20 * DAY, rng);
  assert.deepEqual(
    pond.koi.map((koi) => koi.id),
    ["hana", "new-one"],
  );
  assert.equal(pond.koi[0], first);
  assert.equal(first.x, x);
  assert.equal(first.variety, "ogon");
  assert.equal(pond.koi[1]!.seed, seedOf("new-one"));
});

test("koi grow from 9 to 14 pixels over two weeks", () => {
  assert.equal(koiLength(0, 0), 9);
  assert.equal(koiLength(0, 7 * DAY), 11);
  assert.equal(koiLength(0, 60 * DAY), 14);
});

test("the breath fills, holds, and empties", () => {
  assert.equal(breathAt(0).phase, "in");
  assert.equal(breathAt(BREATH_IN_MS + 1).phase, "hold");
  assert.equal(breathAt(BREATH_CYCLE_MS - 1).phase, "out");
  assert.ok(breathAt(BREATH_CYCLE_MS - 1).fullness < 0.01);
  assert.equal(breathAt(BREATH_IN_MS + 1).fullness, 1);
});

test("rain drifts between a drizzle and a steady shower", () => {
  const levels = Array.from({ length: 600 }, (_, i) => rainIntensity(i * 1_000));
  assert.ok(levels.every((level) => level >= 0.3 && level <= 1));
  assert.ok(Math.max(...levels) - Math.min(...levels) > 0.4, "it changes over ten minutes");
});

test("harder rain lands more rings on the water", () => {
  const rings = (rain: number) => {
    const rng = seededRng(9);
    const pond = newPond(220, 32, 8, 32);
    let count = 0;
    for (let t = 0; t < 10_000; t += 33) {
      const before = pond.ripples.length;
      stepPond(pond, 33, { rng, season: "summer", timeOfDay: "day", weather: "rain", rain });
      count += Math.max(0, pond.ripples.length - before);
    }
    return count;
  };
  assert.ok(rings(1) > rings(0.3) * 2);
});

test("a stroke carries floating food along, and a quick one startles a koi nearby", () => {
  const rng = seededRng(4);
  const pond = newPond(200, 32, 8, 32);
  syncKoi(pond, defaultConfig(0).koi.slice(0, 1), 0, rng);
  pond.food.push({ id: 99, x: 50, y: 20, ageMs: 0 });
  stir(pond, 49, 20, 1, 0, 30);
  assert.ok(pond.food[0]!.x > 50, "the food moved with the stroke");

  const koi = pond.koi[0]!;
  koi.x = 100;
  koi.y = 20;
  koi.tx = 100;
  stir(pond, 97, 20, 1, 0, 10);
  assert.equal(koi.tx, 100, "a slow stroke leaves the koi be");
  stir(pond, 97, 20, 1, 0, 80);
  assert.ok(koi.tx > 110, "a quick stroke sends it darting away");
});
