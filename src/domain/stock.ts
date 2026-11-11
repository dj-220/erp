import Big from "big.js";
import { DomainError } from "./errors";
import { type Decimalish, type Paise, assertPaise, lineAmount } from "./money";

const HALF_UP = Big.roundHalfUp;

export function parseDecimal(value: Decimalish, label = "Value"): Big {
  try {
    return new Big(value);
  } catch {
    throw new DomainError("INVALID_NUMBER", `${label} "${String(value)}" is not a number`);
  }
}

/** Number of digits after the decimal point (big.js drops trailing zeros, so 2.50 has 1). */
export function decimalPlaces(value: Big): number {
  const text = value.toFixed();
  const point = text.indexOf(".");
  return point < 0 ? 0 : text.length - point - 1;
}

/** A stock quantity must be positive and must not use more decimals than the unit allows. */
export function assertQty(qty: Decimalish, decimals: number, label = "Quantity"): Big {
  const q = parseDecimal(qty, label);
  if (q.lte(0)) throw new DomainError("INVALID_QTY", `${label} must be greater than zero`);
  if (decimalPlaces(q) > decimals) {
    throw new DomainError("QTY_PRECISION", `${label} ${q.toString()} has more than ${decimals} decimal places for this unit`);
  }
  return q;
}

/** Weighted-average cost in rupees per unit, or null when nothing is in stock. */
export function averageCost(qty: Decimalish, valuePaise: Paise): Big | null {
  const q = new Big(qty);
  if (q.lte(0)) return null;
  return new Big(valuePaise).div(100).div(q);
}

/**
 * Value (paise) of stock leaving, at the item's weighted-average cost. Taking everything that
 * is on hand takes exactly all of its value, so no rounding residue is ever left behind.
 *
 * If stock is allowed to go negative, the part beyond what is on hand is valued at
 * `fallbackRate` (rupees per unit, e.g. the last purchase price) when given, else at the average.
 */
export function outboundValue(args: {
  qty: Decimalish;
  onHandQty: Decimalish;
  onHandValue: Paise;
  fallbackRate?: Decimalish;
}): Paise {
  const qty = new Big(args.qty);
  const onHandQty = new Big(args.onHandQty);
  assertPaise(args.onHandValue, "on-hand value");

  if (onHandQty.lte(0)) return args.fallbackRate === undefined ? 0 : lineAmount(qty, args.fallbackRate);
  if (qty.lt(onHandQty)) {
    return assertPaise(new Big(args.onHandValue).times(qty).div(onHandQty).round(0, HALF_UP).toNumber());
  }
  const excess = qty.minus(onHandQty);
  if (excess.eq(0)) return args.onHandValue;
  const rate = args.fallbackRate ?? averageCost(onHandQty, args.onHandValue);
  return assertPaise(args.onHandValue + (rate === null ? 0 : lineAmount(excess, rate)));
}

/**
 * How much to reorder when available stock (on hand + on order) has fallen to or below the
 * reorder level. Returns the larger of the fixed reorder quantity and what is needed to get back
 * to the level, or null when no reorder is needed or no level is set.
 */
export function reorderSuggestion(args: {
  onHand: Decimalish;
  incoming?: Decimalish;
  reorderLevel: Decimalish;
  reorderQty: Decimalish;
}): Big | null {
  const level = new Big(args.reorderLevel);
  if (level.lte(0)) return null;
  const available = new Big(args.onHand).plus(args.incoming ?? 0);
  if (available.gt(level)) return null;
  const toLevel = level.minus(available);
  const fixed = new Big(args.reorderQty);
  return fixed.gt(toLevel) ? fixed : toLevel;
}
