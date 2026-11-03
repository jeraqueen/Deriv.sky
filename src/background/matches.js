/**
 * MATCHES strategy: rank the latest 100 tick digits by frequency.
 * Require the leading digit to be at least 12%, wait for the live cursor
 * to touch it, then MATCH the second-ranked digit.
 */
export const MATCHES_RULES = Object.freeze({
  contractType: "DIGITMATCH",
  duration: 1,
  durationUnit: "t",
  minimumLeaderPercentage: 12,
  historyWindow: 100
});

export function evaluateMatchesStrategy({ counts, currentDigit, tickId }) {
  if (!Array.isArray(counts) || counts.length !== 10 ||
      !counts.every(n => Number.isFinite(n) && n >= 0) ||
      !Number.isInteger(currentDigit) || currentDigit < 0 || currentDigit > 9 ||
      tickId === undefined || tickId === null) {
    return { action: "WAIT", reason: "Incomplete MATCHES histogram data." };
  }
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total !== MATCHES_RULES.historyWindow) {
    return { action: "WAIT", reason: "MATCHES requires a complete 100-tick window." };
  }
  const ranked = counts.map((count, digit) => ({
    digit, count, percentage: count / total * 100
  })).sort((a, b) => b.count - a.count || a.digit - b.digit);
  const [leader, second, third] = ranked;
  if (!leader || !second || !third || leader.percentage < MATCHES_RULES.minimumLeaderPercentage) {
    return { action: "MONITOR", reason: "Highest-frequency digit has not reached 12%." };
  }
  if (currentDigit !== leader.digit) {
    return { action: "MONITOR", leaderDigit: leader.digit, barrier: second.digit,
      leaderPercentage: leader.percentage,
      rankedDigits: ranked.slice(0, 3),
      reason: "Waiting for the live digit cursor to touch the highest-frequency digit." };
  }
  return {
    action: "BUY_INTENT",
    contractType: MATCHES_RULES.contractType,
    barrier: second.digit,
    duration: MATCHES_RULES.duration,
    durationUnit: MATCHES_RULES.durationUnit,
    leaderDigit: leader.digit,
    leaderPercentage: leader.percentage,
    secondDigit: second.digit,
    secondPercentage: second.percentage,
    thirdDigit: third.digit,
    thirdPercentage: third.percentage,
    tickId,
    reason: "MATCHES conditions met: leader frequency is at least 12% and the cursor touched the leader digit."
  };
}
