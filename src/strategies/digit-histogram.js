/**
 * Build a 10-digit histogram from the latest 100 live tick digits.
 * Unique maximum = green; unique minimum = red. Tied extremes are rejected.
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
  const maxDigits = counts.flatMap((count, digit) => count === max ? [digit] : []);
  const minDigits = counts.flatMap((count, digit) => count === min ? [digit] : []);
  const uniqueGreen = maxDigits.length === 1;
  const uniqueRed = minDigits.length === 1;
  const bars = counts.map((count, digit) => ({
    digit,
    color: uniqueGreen && digit === maxDigits[0] ? "green" :
      uniqueRed && digit === minDigits[0] ? "red" : "neutral",
    percentage: count
  }));
  if (!uniqueGreen || !uniqueRed) {
    return {
      ready: true, valid: false, reason: "Tied highest or lowest digit frequency; setup rejected.",
      counts, bars, greenDigit: null, redDigit: null, windowSize: DIGIT_HISTORY_WINDOW
    };
  }
  return {
    ready: true, valid: true, reason: "Unique highest and lowest digit frequencies.",
    counts, bars, greenDigit: maxDigits[0], redDigit: minDigits[0],
    greenPercentage: max, redPercentage: min, windowSize: DIGIT_HISTORY_WINDOW
  };
}
