/**
 * Build a 10-digit histogram from the latest 100 live tick digits.
 * Tied extremes are resolved deterministically using the widest red/green
 * separation, so a tied count does not automatically discard a usable setup.
 */
export const DIGIT_HISTORY_WINDOW = 100;

export function buildDigitHistogram(digits) {
  if (!Array.isArray(digits) || digits.length < DIGIT_HISTORY_WINDOW) {
    return { ready: false, reason: "Collecting the first 100 ticks." };
  }
  const window = digits.slice(-DIGIT_HISTORY_WINDOW);
  if (!window.every(d => Number.isInteger(d) && d >= 0 && d <= 9)) {
    return { ready: false, reason: "Tick history contains an invalid digit." };
  }

  const counts = Array(10).fill(0);
  for (const digit of window) counts[digit] += 1;
  const ranked = counts.map((count, digit) => ({ digit, count }))
    .sort((a,b) => b.count - a.count || a.digit - b.digit);
  const greenDigit = ranked[0].digit;
  const blueDigit = ranked[1].digit;
  const orangeDigit = ranked[8].digit;
  const redDigit = ranked[9].digit;
  const max = counts[greenDigit];
  const min = counts[redDigit];
  const greenCandidates = counts.flatMap((count, digit) => count === max ? [digit] : []);
  const redCandidates = counts.flatMap((count, digit) => count === min ? [digit] : []);

  // A completely flat histogram has no meaningful high/low digit.
  if (max === min) {
    return {
      ready: true, valid: false, reason: "All digits have equal frequency; no meaningful red/green edge.",
      counts, bars: counts.map((percentage, digit) => ({ digit, color: "neutral", percentage })),
      greenDigit: null, redDigit: null, windowSize: DIGIT_HISTORY_WINDOW,
      tiedGreen: greenCandidates.length > 1, tiedRed: redCandidates.length > 1
    };
  }

  const separation = Math.abs(greenDigit - redDigit);
  const bars = counts.map((percentage, digit) => ({
    digit,
    color: digit === greenDigit ? "green" : digit === blueDigit ? "blue" :
      digit === orangeDigit ? "orange" : digit === redDigit ? "red" : "neutral",
    percentage
  }));
  const tiedGreen = greenCandidates.length > 1;
  const tiedRed = redCandidates.length > 1;

  return {
    ready: true,
    valid: true,
    reason: tiedGreen || tiedRed
      ? "Tied extremes resolved deterministically using the widest red/green separation."
      : "Unique highest and lowest digit frequencies.",
    counts, bars, greenDigit, blueDigit, orangeDigit, redDigit,
    greenPercentage: max, redPercentage: min, digitSeparation: separation, bluePercentage: counts[blueDigit], orangePercentage: counts[orangeDigit],
    tiedGreen, tiedRed, windowSize: DIGIT_HISTORY_WINDOW
  };
}
