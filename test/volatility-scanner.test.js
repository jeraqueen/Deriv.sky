import test from "node:test";
import assert from "node:assert/strict";
import { isVolatilityIndex, lastDigitFromTick } from "../src/market/volatility-scanner.js";

test("recognizes named Volatility Indices", () => {
  assert.equal(isVolatilityIndex({ display_name: "Volatility 10 (1s) Index" }), true);
  assert.equal(isVolatilityIndex({ display_name: "Volatility 10 (1s)" }), true);
  assert.equal(isVolatilityIndex({ symbol: "1HZ100V" }), true);
  assert.equal(isVolatilityIndex({ symbol: "R_75" }), true);
  assert.equal(isVolatilityIndex({ display_name: "Boom 500 Index" }), false);
});

test("extracts the final quoted digit using pip precision", () => {
  assert.equal(lastDigitFromTick({ quote: 123.47, pip_size: 2 }), 7);
  assert.equal(lastDigitFromTick({ quote: 123.4, pip_size: 2 }), 0);
  assert.equal(lastDigitFromTick({ quote: 123, pip_size: 0 }), 3);
});

test("rejects incomplete tick precision", () => {
  assert.equal(lastDigitFromTick({ quote: 123.47 }), null);
  assert.equal(lastDigitFromTick({ quote: "not-a-price", pip_size: 2 }), null);
});
