import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BREATH_CYCLE_MS,
  BREATH_IN_MS,
  breathAt,
  dropFood,
  newPond,
  resizePond,
  seededRng,
  stepPond,
  type StepContext,
} from "./koi.ts";

const context = (seed: number, season: StepContext["season"] = "spring"): StepContext => ({
  rng: seededRng(seed),
  season,
  timeOfDay: "night",
});

test("koi stay in the water for a long swim", () => {
  const rng = seededRng(1);
  const pond = newPond(300, 44, 8, rng);
  const step = context(2, "winter");
  for (let tick = 0; tick < 20_000; tick++) {
    stepPond(pond, 33, step);
    for (const koi of pond.koi) {
      assert.ok(koi.x >= 1 && koi.x <= pond.width - 1, `x ${koi.x}`);
      assert.ok(koi.y >= pond.top + 2 && koi.y <= pond.height - 1, `y ${koi.y}`);
      assert.ok(koi.trail.length <= koi.length + 5);
    }
  }
});

test("koi come and eat scattered food", () => {
  const rng = seededRng(3);
  const pond = newPond(240, 44, 8, rng);
  dropFood(pond, 120, 26, rng);
  assert.equal(pond.food.length, 3);
  const step = context(4);
  for (let tick = 0; tick < 30_000 / 33 && pond.food.length > 0; tick++) stepPond(pond, 33, step);
  assert.equal(pond.food.length, 0);
});

test("a narrower pond pulls its koi back in", () => {
  const rng = seededRng(5);
  const pond = newPond(400, 44, 8, rng);
  pond.koi[0]!.x = 390;
  resizePond(pond, 200, rng);
  for (let tick = 0; tick < 300; tick++) stepPond(pond, 33, context(6));
  assert.ok(pond.koi.every((koi) => koi.x <= 199));
});

test("drifts stay bounded", () => {
  const rng = seededRng(7);
  const pond = newPond(600, 44, 8, rng);
  for (let tick = 0; tick < 10_000; tick++) stepPond(pond, 33, context(8, "winter"));
  assert.ok(pond.drifts.length <= 40);
  assert.ok(pond.ripples.length <= 16);
});

test("the breath fills, holds, and empties", () => {
  assert.equal(breathAt(0).phase, "in");
  assert.equal(breathAt(BREATH_IN_MS + 1).phase, "hold");
  assert.equal(breathAt(BREATH_CYCLE_MS - 1).phase, "out");
  assert.ok(breathAt(BREATH_CYCLE_MS - 1).fullness < 0.01);
  assert.equal(breathAt(BREATH_IN_MS + 1).fullness, 1);
});
