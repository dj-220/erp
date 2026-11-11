import { addDays, daysBetween } from "./dates";
import { type Paise, formatINR } from "./money";

export type AgeBucket = "not_due" | "1_30" | "31_60" | "61_90" | "over_90";
export const AGE_BUCKETS: readonly AgeBucket[] = ["not_due", "1_30", "31_60", "61_90", "over_90"];

/** Which ageing column an unpaid amount falls in, by how many days past its due date it is. */
export function ageBucket(dueDate: string, asOf: string): AgeBucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return "not_due";
  if (overdue <= 30) return "1_30";
  if (overdue <= 60) return "31_60";
  if (overdue <= 90) return "61_90";
  return "over_90";
}

export function emptyBuckets(): Record<AgeBucket, Paise> {
  return { not_due: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 };
}

/**
 * Days a micro or small supplier may be left unpaid after the bill is accepted. The Income-tax
 * Act (section 43B(h)) ties the buyer's deduction to paying such suppliers within this limit.
 * Informational only: confirm the rule and your suppliers' status with your chartered accountant.
 */
export const MSME_PAYMENT_DAYS = 45;

export function msmeDeadline(billDate: string): string {
  return addDays(billDate, MSME_PAYMENT_DAYS);
}

/** Thresholds in paise, kept as data. */
export const CASH_PAID_DAILY_LIMIT = 1_000_000; // Rs 10,000 to one person in a day
export const CASH_RECEIVED_LIMIT = 20_000_000; // Rs 2,00,000 from one person in a day

/**
 * Cash is legal, but large amounts have tax consequences in India. These are warnings, not
 * blocks, and the figures are data to be confirmed with a chartered accountant:
 *  - paying more than Rs 10,000 in cash to one person in a day can lose the expense deduction
 *    (Income-tax Act section 40A(3));
 *  - receiving Rs 2,00,000 or more in cash from one person in a day is restricted (section 269ST).
 */
export function cashWarnings(args: {
  direction: "paid" | "received";
  mode: string;
  /** Cash already recorded with this party on the same day, not counting this payment. */
  sameDayCashPaise: Paise;
  amountPaise: Paise;
}): string[] {
  if (args.mode !== "cash") return [];
  const day = args.sameDayCashPaise + args.amountPaise;
  if (args.direction === "paid" && day > CASH_PAID_DAILY_LIMIT) {
    return [
      `Cash payments to this supplier today total ${formatINR(day)}, over ${formatINR(CASH_PAID_DAILY_LIMIT)}; the expense may not be deductible (Income-tax Act section 40A(3)). Check with your accountant.`,
    ];
  }
  if (args.direction === "received" && day >= CASH_RECEIVED_LIMIT) {
    return [
      `Cash received from this customer today totals ${formatINR(day)}, at or over ${formatINR(CASH_RECEIVED_LIMIT)}, which section 269ST restricts. Check with your accountant.`,
    ];
  }
  return [];
}
