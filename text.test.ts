import assert from "node:assert/strict";
import { test } from "node:test";
import { RAMP, rampChar } from "./text.ts";

test("the ramp is plain ASCII, light to dense", () => {
  assert.match(RAMP, /^[\x20-\x7e]{8}$/);
});

test("a cell's character grows denser the more of it is inked", () => {
  assert.equal(rampChar(0), " ");
  assert.equal(rampChar(1), ".");
  assert.equal(rampChar(4), "=");
  assert.equal(rampChar(8), "@");
});
