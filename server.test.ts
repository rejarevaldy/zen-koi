import assert from "node:assert/strict";
import { test } from "node:test";
import { pondSchema, readPond } from "./server.ts";

test("a pond saved by 0.2 keeps its koi, garden, and ambience", () => {
  const old = {
    koi: [{ id: "hana", variety: "kohaku", name: "Hana", addedAt: 1 }],
    garden: { lantern: false, tree: true, lilies: "many", plants: true },
    ambience: { season: "winter", time: "auto", weather: "rain", breathing: true },
    show: "always",
    activity: "sukui",
    poi: "6",
  };
  const pond = readPond(old, 1_000);
  assert.deepEqual(pond.koi, old.koi);
  assert.deepEqual(pond.garden, old.garden);
  assert.deepEqual(pond.ambience, old.ambience);
  assert.equal(pond.poi, "6");
  assert.deepEqual(pond.views, { working: "catch", idle: "pond" });
  assert.equal(pond.layout.daily, true);
});

test("nothing stored, or something broken, gives the default pond", () => {
  assert.equal(readPond(undefined, 0).koi.length, 4);
  assert.equal(readPond({ koi: "nope" }, 0).koi.length, 4);
});

test("a pond saved before the text look still validates as it is, and reads as pixel art", () => {
  const saved = { ...readPond(undefined, Date.now()) };
  delete saved.style;
  assert.equal(pondSchema.safeParse(saved).success, true);
  assert.equal(readPond({ koi: "broken" }, 0).style, "pixel");
});
