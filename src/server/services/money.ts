/**
 * THE shared whole-currency validator for every stored currency amount.
 *
 * Normalizes with Number() and accepts only finite, non-negative, SAFE
 * integers (whole currency units). Fractional values, NaN, ±Infinity,
 * negatives and unsafe integers (> Number.MAX_SAFE_INTEGER) are rejected
 * with the caller's own error type — amounts are NEVER silently rounded.
 * null / undefined / "" normalize to null (absent).
 *
 * Percentages are NOT currency and must not go through this validator.
 */
export function makeWholeCurrency(mkError: (message: string) => Error) {
  return function wholeCurrency(raw: unknown, label: string): number | null {
    if (raw === null || raw === undefined || raw === "") return null;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v) || !Number.isSafeInteger(v)) {
      throw mkError(`${label} must be a non-negative whole-currency amount (integer)`);
    }
    return v;
  };
}
