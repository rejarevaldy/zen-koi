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

test("a pond saved with the retired text look keeps everything else", () => {
  const saved = { ...readPond(undefined, Date.now()), style: "pixel" };
  const pond = readPond(saved, Date.now());
  assert.deepEqual(pond.koi, saved.koi);
  assert.deepEqual(pond.garden, saved.garden);
  assert.deepEqual(pond.layout, saved.layout);
  assert.equal("style" in pond, false);
});

test("the phones setting is kept, and ponds saved without it stay valid", () => {
  const pond = readPond(undefined, Date.now());
  assert.equal(pondSchema.safeParse(pond).success, true);
  const off = { ...pond, views: { ...pond.views, phones: false } };
  assert.deepEqual(readPond(off, Date.now()).views, off.views);
});
