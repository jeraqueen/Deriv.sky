import test from "node:test";
import assert from "node:assert/strict";
import { DiffersStrategy, DIFFER_RULES } from "../src/strategies/differs.js";

function bars({ red = 2, green = 6, redPct = 12, greenPct = 20 } = {}) {
  return Array.from({ length: 10 }, (_, digit) => ({
    digit,
    color: digit === red ? "red" : digit === green ? "green" : "neutral",
    percentage: digit === red ? redPct : digit === green ? greenPct : 0
  }));
}

function signal(strategy, market, tickId, currentDigit = 2) {
  return strategy.observe({ market, bars: bars(), currentDigit, tickId });
}

test("valid setup triggers DIFFER at red digit for one tick", () => {
  const strategy = new DiffersStrategy();
  const result = signal(strategy, "R_10", "t1");
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

test("waits for settlement before re-entering the same market", () => {
  const strategy = new DiffersStrategy();
  const first = signal(strategy, "R_10", "t1");
  assert.equal(strategy.recordAcceptedTrade("R_10", first.cycle, "contract-1"), true);
  assert.equal(signal(strategy, "R_10", "t2").action, "WAIT_SETTLEMENT");
  const loss = strategy.recordContractResult("R_10", first.cycle, "contract-1", false);
  assert.equal(loss.losses, 1);
  assert.equal(loss.wins, 0);
  assert.equal(signal(strategy, "R_10", "t3").action, "BUY_INTENT");
});

test("market rotates after three settled wins, not after three attempts", () => {
  const strategy = new DiffersStrategy();
  let cycle = 0;
  for (let i = 1; i <= DIFFER_RULES.maxWinsPerMarketPerCycle; i++) {
    const next = signal(strategy, "R_10", "win-" + i);
    assert.equal(next.action, "BUY_INTENT");
    cycle = next.cycle;
    const contractId = "contract-" + i;
    assert.equal(strategy.recordAcceptedTrade("R_10", cycle, contractId), true);
    const settled = strategy.recordContractResult("R_10", cycle, contractId, true);
    assert.equal(settled.wins, i);
  }
  assert.equal(signal(strategy, "R_10", "after-three-wins").action, "LIMIT_REACHED");
  assert.equal(signal(strategy, "R_25", "other-market").action, "BUY_INTENT");
});

test("a settled contract cannot be counted twice", () => {
  const strategy = new DiffersStrategy();
  const first = signal(strategy, "R_50", "t1");
  strategy.recordAcceptedTrade("R_50", first.cycle, "unique-contract");
  assert.equal(strategy.recordContractResult("R_50", first.cycle, "unique-contract", true).wins, 1);
  assert.equal(strategy.recordContractResult("R_50", first.cycle, "unique-contract", true).ok, false);
});
