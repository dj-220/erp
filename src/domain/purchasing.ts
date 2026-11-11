import Big from "big.js";
import { DomainError } from "./errors";
import type { Decimalish } from "./money";

/**
 * The GST rate a purchase carries. Only a regular registered supplier charges GST. A composition
 * dealer or an unregistered supplier may not, so the line is taxed at 0 whatever the item says.
 * Imports and purchases from SEZ units have their own tax treatment and are not supported yet.
 */
export function purchaseTaxRate(supplierRegistration: string, itemRate: Decimalish): string {
  switch (supplierRegistration) {
    case "regular":
      return new Big(itemRate).toString();
    case "composition":
    case "unregistered":
    case "consumer":
      return "0";
    default:
      throw new DomainError(
        "UNSUPPORTED_REGISTRATION",
        `Purchases from a ${supplierRegistration} supplier (imports, SEZ units) are not supported yet`,
      );
  }
}

/** Rupees per unit after the line discount, to four decimals: what the goods really cost per unit. */
export function unitCostAfterDiscount(unitPrice: Decimalish, discountPct: Decimalish): Big {
  return new Big(unitPrice).times(new Big(100).minus(discountPct)).div(100).round(4, Big.roundHalfUp);
}

/** What is still to come on an order line; never negative. */
export function openQty(ordered: Decimalish, received: Decimalish): Big {
  const open = new Big(ordered).minus(received);
  return open.gt(0) ? open : new Big(0);
}

export type PurchaseOrderState = "draft" | "pending_approval" | "approved" | "rejected" | "sent" | "closed" | "cancelled";

/** Allowed state changes; the database enforces the same table. */
export const PO_TRANSITIONS: Record<PurchaseOrderState, readonly PurchaseOrderState[]> = {
  draft: ["pending_approval", "approved", "cancelled"],
  pending_approval: ["approved", "rejected", "cancelled"],
  approved: ["sent", "closed", "cancelled"],
  sent: ["closed", "cancelled"],
  rejected: [],
  closed: [],
  cancelled: [],
};

export function assertPoTransition(from: PurchaseOrderState, to: PurchaseOrderState): void {
  if (!PO_TRANSITIONS[from].includes(to)) {
    throw new DomainError("INVALID_TRANSITION", `A purchase order cannot go from ${from} to ${to}`);
  }
}

/** States in which goods may be received against the order. */
export function canReceive(state: PurchaseOrderState): boolean {
  return state === "approved" || state === "sent";
}
