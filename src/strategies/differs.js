/**
 * The Sky Bot — approved DIFFER strategy evaluator.
 *
 * This module only evaluates signals. It never places an order.
 * Live execution must call recordAcceptedTrade() only after Deriv confirms a buy.
 *
 * Input bars: [{ digit: 0..9, color: "red"|"green"|"neutral", percentage: number }]
 * currentDigit: last digit of the latest received tick (0..9).
 */
export const DIFFER_RULES = Object.freeze({
  contractType: "DIGITDIFF",
  duration: 1,
  durationUnit: "t",
  maxTradesPerMarketPerCycle: 3,
  minimumDigitSeparation: 2,
  requiredRedBars: 1,
  requiredGreenBars: 1,
  barrier: "red-bar-digit",
  cancelIfRedPercentageRises: true
});

const validDigit = n => Number.isInteger(n) && n >= 0 && n <= 9;

export class DiffersStrategy {
  constructor() {
    this.markets = new Map();
  }

  stateFor(market) {
    if (!this.markets.has(market)) {
      this.markets.set(market, {
        cycle: 0,
        active: false,
        blocked: false,
        redDigit: null,
        greenDigit: null,
        previousRedPercentage: null,
        trades: 0,
        lastTriggerTick: null,
        pending: false,
        pendingAt: null
      });
    }
    return this.markets.get(market);
  }

  observe({ market, bars, currentDigit, tickId, nowMs = Date.now() }) {
    if (!market || !Array.isArray(bars) || bars.length !== 10 ||
        !validDigit(currentDigit) || tickId === undefined || tickId === null) {
      return { action: "WAIT", reason: "Incomplete market data." };
    }

    // The Deriv digit histogram must contain each digit exactly once.
    // Reject malformed, duplicated, missing, or unknown bar data.
    const digits = bars.map(b => b?.digit);
    const validBars = digits.every(validDigit) &&
      new Set(digits).size === 10 &&
      bars.every(b => b && ["red", "green", "neutral"].includes(b.color) &&
        Number.isFinite(b.percentage) && b.percentage >= 0 && b.percentage <= 100);
    if (!validBars) {
      return { action: "WAIT", reason: "Digit bars are incomplete, duplicated, or contain invalid percentages." };
    }

    const s = this.stateFor(market);
    if (s.pending && nowMs - s.pendingAt > 10000) { s.pending = false; s.pendingAt = null; }
    const red = bars.filter(b => b.color === "red");
    const green = bars.filter(b => b.color === "green");

    // A cycle ends only after the original one-red/one-green setup disappears.
    const shapeValid = red.length === 1 && green.length === 1 &&
      validDigit(red[0].digit) && validDigit(green[0].digit) &&
      Math.abs(red[0].digit - green[0].digit) >= DIFFER_RULES.minimumDigitSeparation &&
      Number.isFinite(red[0].percentage) &&
      red[0].percentage >= 0 && red[0].percentage <= 100;

    if (!shapeValid) {
      if (s.active || s.blocked) {
        s.active = false;
        s.blocked = false;
        s.redDigit = null;
        s.greenDigit = null;
        s.previousRedPercentage = null;
        s.trades = 0;
        s.lastTriggerTick = null;
        s.pending = false;
        s.pendingAt = null;
      }
      return { action: "WAIT", reason: "The one-red/one-green separation condition is not met." };
    }

    const redDigit = red[0].digit;
    const greenDigit = green[0].digit;
    const redPercentage = red[0].percentage;

    if (!s.active) {
      s.cycle += 1;
      s.active = true;
      s.blocked = false;
      s.redDigit = redDigit;
      s.greenDigit = greenDigit;
      s.previousRedPercentage = redPercentage;
      s.trades = 0;
      s.lastTriggerTick = null;
    } else if (redDigit !== s.redDigit || greenDigit !== s.greenDigit) {
      // A changed bar identity is a new setup; start a fresh cycle.
      s.cycle += 1;
      s.blocked = false;
      s.redDigit = redDigit;
      s.greenDigit = greenDigit;
      s.previousRedPercentage = redPercentage;
      s.trades = 0;
      s.lastTriggerTick = null;
      s.pending = false;
      s.pendingAt = null;
    } else if (redPercentage > s.previousRedPercentage) {
      // Do not chase a rising red-bar barrier percentage. Block this setup
      // until the one-red/one-green shape disappears and reforms.
      s.blocked = true;
      s.previousRedPercentage = redPercentage;
      s.pending = false;
      s.pendingAt = null;
      return {
        action: "SWITCH_MARKET",
        market,
        cycle: s.cycle,
        reason: "Red-bar barrier percentage increased; abandon this setup and scan another market."
      };
    } else {
      s.previousRedPercentage = redPercentage;
    }

    if (s.blocked) {
      return {
        action: "SWITCH_MARKET",
        market,
        cycle: s.cycle,
        reason: "This setup was invalidated by a rising red-bar percentage."
      };
    }

    if (s.pending && nowMs - s.pendingAt <= 10000) {
      return { action: "PENDING", market, cycle: s.cycle, reason: "A DIFFER signal is awaiting a demo execution acknowledgement." };
    }

    if (s.trades >= DIFFER_RULES.maxTradesPerMarketPerCycle) {
      return {
        action: "LIMIT_REACHED",
        market,
        cycle: s.cycle,
        trades: s.trades,
        reason: "Three accepted trades have already been placed in this market during this cycle."
      };
    }

    // The live last digit is the moving cursor. Trigger once when it touches
    // the selected red-bar digit. One trigger per tick prevents duplicates.
    if (currentDigit !== s.redDigit) {
      return { action: "MONITOR", market, cycle: s.cycle, barrier: s.redDigit, reason: "Waiting for the live digit cursor to touch the red-bar digit." };
    }
    if (s.lastTriggerTick === tickId) {
      return { action: "DUPLICATE_SUPPRESSED", market, cycle: s.cycle, barrier: s.redDigit };
    }
    s.lastTriggerTick = tickId;
    s.pending = true;
    s.pendingAt = nowMs;

    return {
      action: "BUY_INTENT",
      market,
      cycle: s.cycle,
      contractType: DIFFER_RULES.contractType,
      barrier: s.redDigit,
      duration: DIFFER_RULES.duration,
      durationUnit: DIFFER_RULES.durationUnit,
      tradesAlreadyAccepted: s.trades,
      tradesRemaining: DIFFER_RULES.maxTradesPerMarketPerCycle - s.trades,
      reason: "All DIFFER conditions are valid and the live digit cursor touched the red-bar digit."
    };
  }

  // Call only after Deriv confirms a successful purchase.
  recordAcceptedTrade(market, cycle) {
    const s = this.stateFor(market);
    if (!s.active || s.blocked || !s.pending || s.cycle !== cycle ||
        s.trades >= DIFFER_RULES.maxTradesPerMarketPerCycle) return false;
    s.trades += 1;
    s.pending = false;
    s.pendingAt = null;
    return true;
  }

  releasePending(market, cycle) {
    const s = this.stateFor(market);
    if (s.cycle !== cycle || !s.pending) return false;
    s.pending = false;
    s.pendingAt = null;
    return true;
  }

  snapshot() {
    return Array.from(this.markets.entries()).map(([market, state]) => [market, { ...state }]);
  }

  restore(snapshot) {
    this.markets = new Map(Array.isArray(snapshot) ? snapshot : []);
  }

  resetMarket(market) {
    this.markets.delete(market);
  }
}
