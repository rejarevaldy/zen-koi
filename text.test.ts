import assert from "node:assert/strict";
import { test } from "node:test";
import { fishFor } from "./text.ts";

test("a koi is an ASCII fish that grows longer", () => {
  assert.equal(fishFor(9, true), "><>");
  assert.equal(fishFor(11, true), "><('>");
  assert.equal(fishFor(14, true), "><(('>");
});

test("a fish swimming left is mirrored", () => {
  assert.equal(fishFor(9, false), "<><");
  assert.equal(fishFor(14, false), "<'))><");
});

test("every fish is plain ASCII", () => {
  for (const length of [9, 11, 14]) assert.match(fishFor(length, false), /^[\x20-\x7e]+$/);
});
