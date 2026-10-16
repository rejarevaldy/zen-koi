import assert from "node:assert/strict";
import { test } from "node:test";
import { shapeOf } from "./text.ts";

// Masks are eight bits, row by row, two a row: bit 0 top-left, bit 7 bottom-right.

test("a cell with nothing inked is plain: water waves or bank marks", () => {
  assert.deepEqual(shapeOf(0), { kind: "plain" });
});

test("lone pixels become braille dots", () => {
  assert.deepEqual(shapeOf(0b1000_0001), { kind: "dots", mask: 0b1000_0001 });
});

test("a diagonal ring of lone pixels stays dots", () => {
  assert.equal(shapeOf(0b1001_1001).kind, "dots");
});

test("pixels that touch become quadrant blocks", () => {
  // Pixels 0 and 1 (row 0) and 2 (row 1) all sit in the top two quadrants.
  assert.deepEqual(shapeOf(0b0000_0111), { kind: "blocks", quads: 0b0011 });
  // A vertical pair in the right column of the bottom half.
  assert.deepEqual(shapeOf(0b1010_0000), { kind: "blocks", quads: 0b1000 });
});
