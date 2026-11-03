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
  const max = Math.max(...counts);
  const min = Math.min(...counts);
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

  // Resolve ties consistently: select the red/green pair with the widest
  // separation. Remaining ties prefer the lower red digit and higher green digit.
  const pairs = [];
  for (const redDigit of redCandidates) {
    for (const greenDigit of greenCandidates) {
      const separation = Math.abs(greenDigit - redDigit);
      if (separation >= 2) pairs.push({ redDigit, greenDigit, separation });
    }
  }
  pairs.sort((a, b) =>
    b.separation - a.separation ||
    a.redDigit - b.redDigit ||
    b.greenDigit - a.greenDigit
  );

  if (!pairs.length) {
    return {
      ready: true, valid: false, reason: "No red/green candidate pair has the required two-digit separation.",
      counts, bars: counts.map((percentage, digit) => ({ digit, color: "neutral", percentage })),
      greenDigit: null, redDigit: null, windowSize: DIGIT_HISTORY_WINDOW,
      tiedGreen: greenCandidates.length > 1, tiedRed: redCandidates.length > 1
    };
  }

  const { redDigit, greenDigit, separation } = pairs[0];
  const bars = counts.map((percentage, digit) => ({
    digit,
    color: digit === redDigit ? "red" : digit === greenDigit ? "green" : "neutral",
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
    counts, bars, greenDigit, redDigit,
    greenPercentage: max, redPercentage: min, digitSeparation: separation,
    tiedGreen, tiedRed, windowSize: DIGIT_HISTORY_WINDOW
  };
}
