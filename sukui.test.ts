import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "./config.ts";
import { bodyPoint, newPond, placeKoi, seededRng, stepPond, syncKoi, type Pond } from "./koi.ts";
import { aim, BOWL_MS, dip, lift, newSukui, releaseAll, stepSukui, type Sukui } from "./sukui.ts";

const DAY = 86_400_000;

function setup(seed: number): { pond: Pond; sukui: Sukui; rng: () => number } {
  const rng = seededRng(seed);
  const pond = newPond(200, 32, 8, 32);
  syncKoi(pond, defaultConfig(0).koi, 20 * DAY, rng);
  const sukui = newSukui("4", pond, 32);
  return { pond, sukui, rng };
}

/** Puts the first koi right under the poi, near the surface. */
function koiUnderPoi(pond: Pond, sukui: Sukui) {
  const koi = pond.koi[0]!;
  // Facing left, so the body trails off to the right of the head.
  placeKoi(koi, sukui.x - koi.length * 0.35, sukui.y, Math.PI);
  koi.depth = 0.1;
  const middle = bodyPoint(koi, koi.length * 0.35);
  assert.ok(Math.hypot(middle.x - sukui.x, middle.y - sukui.y) < 1);
  return koi;
}

test("a slow dip and lift scoops the koi into the bowl, and it comes back", () => {
  const { pond, sukui, rng } = setup(1);
  aim(sukui, sukui.x, sukui.y);
  const koi = koiUnderPoi(pond, sukui);
  dip(sukui, pond);
  const events = lift(sukui, pond, rng);
  assert.deepEqual(events, [{ type: "scooped", koiId: koi.id, auto: false }]);
  assert.equal(koi.away, true);
  assert.ok(sukui.paper > 0 && sukui.paper < 1);

  const released = [];
  for (let ms = 0; ms <= BOWL_MS + 100; ms += 100) released.push(...stepSukui(sukui, pond, 100, rng));
  assert.ok(released.some((event) => event.type === "released" && event.koiId === koi.id));
  assert.equal(koi.away, false);
});

test("koi deep in the water cannot be lifted", () => {
  const { pond, sukui, rng } = setup(2);
  const koi = koiUnderPoi(pond, sukui);
  koi.depth = 0.8;
  dip(sukui, pond);
  assert.deepEqual(lift(sukui, pond, rng), [{ type: "missed" }]);
});

test("a splashy entry costs paper, and thin paper tears sooner", () => {
  const { pond, sukui } = setup(3);
  sukui.speed = 40;
  dip(sukui, pond);
  const thick = sukui.paper;

  const thin = setup(3);
  thin.sukui.grade = "6";
  thin.sukui.speed = 40;
  dip(thin.sukui, thin.pond);
  assert.ok(thick < 1);
  assert.ok(thin.sukui.paper < thick);
});

test("paper left in the water wears through, then a fresh poi comes", () => {
  const { pond, sukui, rng } = setup(4);
  aim(sukui, sukui.x, sukui.y);
  dip(sukui, pond);
  const events = [];
  for (let ms = 0; ms < 60_000 && !sukui.torn; ms += 100) events.push(...stepSukui(sukui, pond, 100, rng));
  assert.ok(events.some((event) => event.type === "torn"));
  for (let ms = 0; ms < 3_000; ms += 100) stepSukui(sukui, pond, 100, rng);
  assert.equal(sukui.torn, false);
  assert.equal(sukui.paper, 1);
});

test("left alone, the poi plays by itself and scoops", () => {
  const { pond, sukui, rng } = setup(5);
  let scooped = false;
  for (let ms = 0; ms < 180_000 && !scooped; ms += 33) {
    stepPond(pond, 33, { rng, season: "summer", timeOfDay: "day", weather: "clear" });
    scooped = stepSukui(sukui, pond, 33, rng).some((event) => event.type === "scooped");
  }
  assert.ok(scooped);
});

test("stopping play lets every koi out of the bowl", () => {
  const { pond, sukui, rng } = setup(6);
  aim(sukui, sukui.x, sukui.y);
  const koi = koiUnderPoi(pond, sukui);
  dip(sukui, pond);
  lift(sukui, pond, rng);
  assert.equal(koi.away, true);
  releaseAll(sukui, pond, rng);
  assert.equal(koi.away, false);
  assert.equal(sukui.bowl.length, 0);
});
