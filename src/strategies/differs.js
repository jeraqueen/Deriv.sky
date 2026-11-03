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
  maxWinsPerMarketPerCycle: 3,
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
        wins: 0,
        losses: 0,
        openContracts: [],
        lastTriggerTick: null,
        pending: false,
        pendingAt: null
      });
    }
    const state = this.markets.get(market);
    // Migrate persisted cycles created before win-based rotation was introduced.
    state.wins ??= 0;
    state.losses ??= 0;
    state.openContracts ??= [];
    return state;
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
        s.wins = 0;
        s.losses = 0;
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
      s.wins = 0;
      s.losses = 0;
      s.lastTriggerTick = null;
    } else if (redDigit !== s.redDigit || greenDigit !== s.greenDigit) {
      // A changed bar identity is a new setup; start a fresh cycle.
      s.cycle += 1;
      s.blocked = false;
      s.redDigit = redDigit;
      s.greenDigit = greenDigit;
      s.previousRedPercentage = redPercentage;
      s.trades = 0;
      s.wins = 0;
      s.losses = 0;
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

    if (s.wins >= DIFFER_RULES.maxWinsPerMarketPerCycle) {
      s.blocked = true;
      return { action: "LIMIT_REACHED", market, cycle: s.cycle, wins: s.wins,
        reason: "Three winning contracts have been completed in this market setup; rotate to another qualifying market." };
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

    if (s.openContracts.length > 0) {
      return { action: "WAIT_SETTLEMENT", market, cycle: s.cycle,
        wins: s.wins, trades: s.trades,
        reason: "A contract in this market setup is still open; wait for its result before the next entry." };
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
      wins: s.wins,
      winsRemaining: DIFFER_RULES.maxWinsPerMarketPerCycle - s.wins,
      tradesCompleted: s.trades,
      reason: "All DIFFER conditions are valid and the live digit cursor touched the red-bar digit."
    };
  }

  // Call only after Deriv confirms a successful purchase.
  recordAcceptedTrade(market, cycle, contractId) {
    const s = this.stateFor(market);
    const id = String(contractId || "");
    if (!s.active || s.blocked || !s.pending || s.cycle !== cycle || !id ||
        s.wins >= DIFFER_RULES.maxWinsPerMarketPerCycle ||
        s.openContracts.some(item => item.contractId === id)) return false;
    s.trades += 1;
    s.openContracts.push({ contractId: id, cycle });
    s.pending = false;
    s.pendingAt = null;
    return true;
  }

  // Count each settled contract once. Losses do not count toward the three-win rotation.
  recordContractResult(market, cycle, contractId, won) {
    const s = this.stateFor(market);
    const id = String(contractId || "");
    const index = s.openContracts.findIndex(item => item.contractId === id);
    if (!id || index < 0) return { ok: false, duplicateOrUnknown: true };
    const [open] = s.openContracts.splice(index, 1);
    if (open.cycle !== cycle || s.cycle !== cycle) {
      return { ok: true, staleCycle: true, wins: s.wins, losses: s.losses };
    }
    if (won) s.wins += 1;
    else s.losses += 1;
    if (s.wins >= DIFFER_RULES.maxWinsPerMarketPerCycle) s.blocked = true;
    return { ok: true, wins: s.wins, losses: s.losses,
      completed: s.wins >= DIFFER_RULES.maxWinsPerMarketPerCycle };
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
