import test from "node:test";
import assert from "node:assert/strict";
import { DiffersStrategy } from "../src/strategies/differs.js";

function bars({ red = 2, green = 6, redPct = 12, greenPct = 20 } = {}) {
  return Array.from({ length: 10 }, (_, digit) => ({
    digit,
    color: digit === red ? "red" : digit === green ? "green" : "neutral",
    percentage: digit === red ? redPct : digit === green ? greenPct : 0
  }));
}

test("valid setup triggers DIFFER at red digit for one tick", () => {
  const strategy = new DiffersStrategy();
  const result = strategy.observe({ market: "R_10", bars: bars(), currentDigit: 2, tickId: "t1" });
  assert.equal(result.action, "BUY_INTENT");
  assert.equal(result.contractType, "DIGITDIFF");
  assert.equal(result.barrier, 2);
  assert.equal(result.duration, 1);
  assert.equal(result.durationUnit, "t");
});

test("same tick cannot trigger twice", () => {
  const strategy = new DiffersStrategy();
  strategy.observe({ market: "R_10", bars: bars(), currentDigit: 2, tickId: "t1" });
  const result = strategy.observe({ market: "R_10", bars: bars(), currentDigit: 2, tickId: "t1" });
  assert.equal(result.action, "DUPLICATE_SUPPRESSED");
});

test("red percentage increase blocks the setup", () => {
  const strategy = new DiffersStrategy();
  strategy.observe({ market: "R_10", bars: bars({ redPct: 12 }), currentDigit: 0, tickId: "t1" });
  const result = strategy.observe({ market: "R_10", bars: bars({ redPct: 13 }), currentDigit: 2, tickId: "t2" });
  assert.equal(result.action, "SWITCH_MARKET");
});

test("malformed or duplicate digit bars are rejected", () => {
  const strategy = new DiffersStrategy();
  const malformed = bars();
  malformed[9] = { digit: 8, color: "neutral", percentage: 0 };
  const result = strategy.observe({ market: "R_10", bars: malformed, currentDigit: 2, tickId: "t1" });
  assert.equal(result.action, "WAIT");
});

test("maximum of three accepted trades is enforced per cycle", () => {
  const strategy = new DiffersStrategy();
  const first = strategy.observe({ market: "R_10", bars: bars(), currentDigit: 2, tickId: "t1" });
  assert.equal(strategy.recordAcceptedTrade("R_10", first.cycle), true);
  assert.equal(strategy.recordAcceptedTrade("R_10", first.cycle), true);
  assert.equal(strategy.recordAcceptedTrade("R_10", first.cycle), true);
  assert.equal(strategy.recordAcceptedTrade("R_10", first.cycle), false);
  const result = strategy.observe({ market: "R_10", bars: bars(), currentDigit: 2, tickId: "t2" });
  assert.equal(result.action, "LIMIT_REACHED");
});
