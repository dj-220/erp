import Big from "big.js";

/**
 * Money is stored and computed as an integer number of paise (1 rupee = 100 paise).
 * Never use floating-point rupees: 1.005 * 100 !== 100.5 in JavaScript.
 * Quantities and rates are decimals and go through big.js; only the final
 * rounded amount becomes Paise.
 */
export type Paise = number;
export type Decimalish = string | number | Big;

/** Round half away from zero, which is what Indian invoicing/Tally expect. */
const HALF_UP = Big.roundHalfUp;

export function assertPaise(value: number, label = "amount"): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a whole number of paise, got ${value}`);
  }
  // Normalise -0 to 0.
  return value + 0;
}

/** Convert a rupee amount (e.g. "1234.565") to paise, rounding half up. */
export function toPaise(rupees: Decimalish): Paise {
  return assertPaise(new Big(rupees).times(100).round(0, HALF_UP).toNumber());
}

/** Paise to a plain rupee string with exactly two decimals, e.g. 123450 -> "1234.50". */
export function fromPaise(paise: Paise): string {
  assertPaise(paise);
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${paise < 0 ? "-" : ""}${rupees}.${rem}`;
}

/** Indian digit grouping: 1234567 -> "12,34,567". */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

export function formatINR(paise: Paise, options: { symbol?: boolean } = {}): string {
  const { symbol = true } = options;
  const [int, frac] = fromPaise(Math.abs(paise)).split(".") as [string, string];
  return `${paise < 0 ? "-" : ""}${symbol ? "₹" : ""}${groupIndian(int)}.${frac}`;
}

/** quantity x rate (both decimals) rounded to whole paise. */
export function lineAmount(qty: Decimalish, rate: Decimalish): Paise {
  return toPaise(new Big(qty).times(rate));
}

/** `percent`% of an amount, rounded half up to whole paise. */
export function percentOf(paise: Paise, percent: Decimalish): Paise {
  assertPaise(paise);
  return assertPaise(new Big(paise).times(percent).div(100).round(0, HALF_UP).toNumber());
}

export function sumPaise(values: readonly Paise[]): Paise {
  return assertPaise(values.reduce((a, b) => a + b, 0));
}

/**
 * Invoice totals are rounded to the nearest rupee, with the difference shown as a
 * separate "Round Off" line (a ledger in Tally).
 */
export function roundToRupee(paise: Paise): { rounded: Paise; roundOff: Paise } {
  assertPaise(paise);
  const rounded = assertPaise(new Big(paise).div(100).round(0, HALF_UP).times(100).toNumber());
  return { rounded, roundOff: assertPaise(rounded - paise) };
}
