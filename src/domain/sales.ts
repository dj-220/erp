import Big from "big.js";
import { daysBetween } from "./dates";
import { DomainError } from "./errors";
import { type Decimalish, type Paise, toPaise } from "./money";

/** Taxable value of a line: qty x unit price, less a percentage discount, rounded to paise. */
export function lineTaxableValue(args: { qty: Decimalish; unitPrice: Decimalish; discountPct?: Decimalish }): Paise {
  const discount = new Big(args.discountPct ?? 0);
  if (discount.lt(0) || discount.gt(100)) {
    throw new DomainError("INVALID_DISCOUNT", "Discount must be between 0 and 100 percent");
  }
  // Multiply first and divide last so that no intermediate rounding creeps in.
  return toPaise(new Big(args.qty).times(args.unitPrice).times(new Big(100).minus(discount)).div(100));
}

/**
 * How much of an order line can be invoiced now. Goods are invoiced when they leave (what has
 * been delivered); services have no delivery, so the ordered quantity is the limit.
 */
export function invoiceableQty(args: {
  ordered: Decimalish;
  delivered: Decimalish;
  invoiced: Decimalish;
  isGoods: boolean;
}): Big {
  const limit = new Big(args.isGoods ? args.delivered : args.ordered);
  const open = limit.minus(args.invoiced);
  return open.gt(0) ? open : new Big(0);
}

/**
 * GST requires invoice numbers to be consecutive. As a safeguard (a design choice, not a quoted
 * statute) an invoice cannot carry a date earlier than a lower-numbered one already issued in the
 * same series, so numbers and dates always read in the same order on an audit.
 */
export function assertInvoiceDateOrder(invoiceDate: string, latestPostedDate: string | null): void {
  if (latestPostedDate !== null && invoiceDate < latestPostedDate) {
    throw new DomainError(
      "INVOICE_DATE_ORDER",
      `An invoice dated ${invoiceDate} cannot be numbered after one already issued on ${latestPostedDate}`,
    );
  }
}

export type OrderStatus = "fulfilled" | "on_time" | "at_risk" | "late";

export interface OrderAssessment {
  status: OrderStatus;
  reason: string;
}

/**
 * The status shown on the orders board.
 *  - fulfilled: nothing left to deliver.
 *  - late: the promised date has passed and goods are still owed.
 *  - at risk: not late yet, but stock for what remains cannot be covered.
 *  - on time: stock covers what remains.
 */
export function classifyOrder(args: {
  today: string;
  promisedDate: string;
  hasRemainingGoods: boolean;
  shortageNames: readonly string[];
}): OrderAssessment {
  if (!args.hasRemainingGoods) return { status: "fulfilled", reason: "Delivered in full" };
  const short = args.shortageNames.length > 0 ? `short of ${args.shortageNames.join(", ")}` : "";
  const overdue = daysBetween(args.promisedDate, args.today);
  if (overdue > 0) {
    const days = `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
    return { status: "late", reason: short ? `${days}, ${short}` : days };
  }
  if (short) return { status: "at_risk", reason: short.charAt(0).toUpperCase() + short.slice(1) };
  return { status: "on_time", reason: "Stock covers what remains" };
}
