import test from "node:test";
import assert from "node:assert/strict";
import { buildDigitHistogram, DIGIT_HISTORY_WINDOW } from "../src/strategies/digit-histogram.js";

test("marks unique most frequent digit green and unique least frequent digit red", () => {
  const digits = [
    ...Array(20).fill(0),
    ...Array.from({length: 8}, (_, i) => Array(10).fill(i + 1)).flat()
  ];
  assert.equal(digits.length, DIGIT_HISTORY_WINDOW);
  const result = buildDigitHistogram(digits);
  assert.equal(result.ready, true);
  assert.equal(result.valid, true);
  assert.equal(result.greenDigit, 0);
  assert.equal(result.redDigit, 9);
  assert.equal(result.bars[0].color, "green");
  assert.equal(result.bars[9].color, "red");
  assert.equal(result.bars[0].percentage, 20);
});

test("rejects tied highest or lowest frequencies", () => {
  const digits = [
    ...Array(20).fill(0), ...Array(20).fill(1),
    ...Array.from({length: 6}, (_, i) => Array(10).fill(i + 2)).flat()
  ];
  const result = buildDigitHistogram(digits);
  assert.equal(result.ready, true);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Tied/);
  assert.ok(result.bars.every(bar => bar.color === "neutral"));
});

test("does not evaluate before 100 ticks", () => {
  const result = buildDigitHistogram([1, 2, 3]);
  assert.equal(result.ready, false);
});
