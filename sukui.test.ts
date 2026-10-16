import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "./config.ts";
import { newPond, seededRng, stepPond, syncKoi, type Pond } from "./koi.ts";
import {
  BITE_MS,
  BOWL_MS,
  isAuto,
  newSukui,
  releaseAll,
  stepSukui,
  tap,
  tapAt,
  type Sukui,
  type SukuiEvent,
} from "./sukui.ts";

const DAY = 86_400_000;

function setup(seed: number): { pond: Pond; sukui: Sukui; rng: () => number } {
  const rng = seededRng(seed);
  const pond = newPond(220, 32, 8, 32);
  syncKoi(pond, defaultConfig(0).koi, 20 * DAY, rng);
  const sukui = newSukui("4", pond, 32);
  return { pond, sukui, rng };
}

/** Runs the pond and the poi together until `until` says stop, or time runs out. */
function run(
  pond: Pond,
  sukui: Sukui,
  rng: () => number,
  ms: number,
  until: (events: SukuiEvent[]) => boolean = () => false,
): SukuiEvent[] {
  const all: SukuiEvent[] = [];
  for (let t = 0; t < ms; t += 33) {
    stepPond(pond, 33, { rng, season: "summer", timeOfDay: "day", weather: "clear" });
    const events = stepSukui(sukui, pond, 33, rng);
    all.push(...events);
    if (until(events)) break;
  }
  return all;
}

test("left alone, the poi plays by itself and scoops koi", () => {
  const { pond, sukui, rng } = setup(1);
  assert.equal(isAuto(sukui), true);
  const events = run(pond, sukui, rng, 240_000, (batch) => batch.some((e) => e.type === "scooped"));
  assert.ok(events.some((event) => event.type === "dip"));
  assert.ok(events.some((event) => event.type === "scooped" && event.auto));
});

test("the player taps when a koi is over the poi, and scoops it", () => {
  const { pond, sukui, rng } = setup(2);
  // Take the poi: it stops playing by itself and waits where it was tapped.
  tapAt(sukui, pond, 100, 20, rng);
  assert.equal(isAuto(sukui), false);
  let bite: SukuiEvent | undefined;
  run(pond, sukui, rng, 120_000, (batch) => {
    bite = batch.find((event) => event.type === "bite");
    // Keep the poi in the player's hands while waiting.
    sukui.playerMs = 0;
    return bite !== undefined;
  });
  assert.ok(bite, "a koi came over the poi");
  const events = tap(sukui, pond, rng);
  assert.equal(events[0]?.type, "scooped");
  const koiId = (events[0] as { koiId: string }).koiId;
  assert.equal(pond.koi.find((koi) => koi.id === koiId)?.away, true);

  // It goes back to the pond after a while.
  const later = run(pond, sukui, rng, BOWL_MS + 1_000, (batch) => {
    sukui.playerMs = 0;
    return batch.some((event) => event.type === "released");
  });
  assert.ok(later.some((event) => event.type === "released" && event.koiId === koiId));
  assert.equal(pond.koi.find((koi) => koi.id === koiId)?.away, false);
});

test("waiting too long lets the koi swim off", () => {
  const { pond, sukui, rng } = setup(3);
  tapAt(sukui, pond, 100, 20, rng);
  run(pond, sukui, rng, 120_000, (batch) => {
    sukui.playerMs = 0;
    return batch.some((event) => event.type === "bite");
  });
  assert.equal(sukui.phase.kind, "bite");
  const events = run(pond, sukui, rng, BITE_MS + 200, () => {
    sukui.playerMs = 0;
    return false;
  });
  assert.ok(events.some((event) => event.type === "missed"));
  assert.equal(sukui.phase.kind, "waiting");
});

test("wet paper wears through, then a fresh poi comes", () => {
  const { pond, sukui, rng } = setup(4);
  sukui.grade = "6";
  tapAt(sukui, pond, 100, 20, rng);
  // Koi are kept away, so the poi just soaks.
  for (const koi of pond.koi) koi.away = true;
  const events = run(pond, sukui, rng, 120_000, (batch) => {
    sukui.playerMs = 0;
    return batch.some((event) => event.type === "torn");
  });
  assert.ok(events.some((event) => event.type === "torn"));
  run(pond, sukui, rng, 3_000, () => {
    sukui.playerMs = 0;
    return false;
  });
  // A fresh poi, already back in the water and only just wet.
  assert.equal(sukui.torn, false);
  assert.ok(sukui.paper > 0.9);
});

test("stopping play lets every koi out of the bowl", () => {
  const { pond, sukui, rng } = setup(5);
  run(pond, sukui, rng, 240_000, (batch) => batch.some((e) => e.type === "scooped"));
  assert.ok(sukui.bowl.length > 0);
  releaseAll(sukui, pond, rng);
  assert.equal(sukui.bowl.length, 0);
  assert.ok(pond.koi.every((koi) => !koi.away));
});
