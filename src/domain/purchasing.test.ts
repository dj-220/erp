import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import {
  type PurchaseOrderState,
  PO_TRANSITIONS,
  assertPoTransition,
  canReceive,
  openQty,
  purchaseTaxRate,
  unitCostAfterDiscount,
} from "./purchasing";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `non-domain: ${String(e)}`;
  }
  return undefined;
}

describe("purchaseTaxRate", () => {
  it("charges the item's rate only when the supplier is a regular registered dealer", () => {
    expect(purchaseTaxRate("regular", "18")).toBe("18");
    expect(purchaseTaxRate("regular", "5.0")).toBe("5");
  });

  it("charges nothing when the supplier is not allowed to collect GST", () => {
    expect(purchaseTaxRate("composition", "18")).toBe("0");
    expect(purchaseTaxRate("unregistered", "18")).toBe("0");
    expect(purchaseTaxRate("consumer", "18")).toBe("0");
  });

  it("refuses imports and SEZ suppliers rather than guessing", () => {
    expect(codeOf(() => purchaseTaxRate("overseas", "18"))).toBe("UNSUPPORTED_REGISTRATION");
    expect(codeOf(() => purchaseTaxRate("sez", "18"))).toBe("UNSUPPORTED_REGISTRATION");
  });
});

describe("unitCostAfterDiscount", () => {
  it("applies the discount and rounds to four decimals, half up", () => {
    expect(unitCostAfterDiscount("241.5", "10").toString()).toBe("217.35");
    expect(unitCostAfterDiscount("100", "0").toString()).toBe("100");
    expect(unitCostAfterDiscount("33.33", "12.5").toString()).toBe("29.1638"); // 29.16375
    expect(unitCostAfterDiscount("1", "33.3333").toString()).toBe("0.6667");
  });
});

describe("openQty", () => {
  it("is what is left, never negative", () => {
    expect(openQty(10, 4).toString()).toBe("6");
    expect(openQty(10, 12).toString()).toBe("0");
  });
});

describe("purchase order states", () => {
  it("allows the normal path", () => {
    expect(codeOf(() => assertPoTransition("draft", "pending_approval"))).toBeUndefined();
    expect(codeOf(() => assertPoTransition("draft", "approved"))).toBeUndefined(); // within the requester's own limit
    expect(codeOf(() => assertPoTransition("pending_approval", "approved"))).toBeUndefined();
    expect(codeOf(() => assertPoTransition("pending_approval", "rejected"))).toBeUndefined();
    expect(codeOf(() => assertPoTransition("approved", "sent"))).toBeUndefined();
    expect(codeOf(() => assertPoTransition("sent", "closed"))).toBeUndefined();
  });

  it("refuses everything else, including leaving a final state", () => {
    expect(codeOf(() => assertPoTransition("draft", "sent"))).toBe("INVALID_TRANSITION");
    expect(codeOf(() => assertPoTransition("approved", "draft"))).toBe("INVALID_TRANSITION");
    expect(codeOf(() => assertPoTransition("sent", "approved"))).toBe("INVALID_TRANSITION");
    for (const final of ["rejected", "closed", "cancelled"] as PurchaseOrderState[]) {
      expect(PO_TRANSITIONS[final]).toEqual([]);
    }
  });

  it("lets goods be received only against an approved or sent order", () => {
    expect(canReceive("approved")).toBe(true);
    expect(canReceive("sent")).toBe(true);
    for (const s of ["draft", "pending_approval", "rejected", "closed", "cancelled"] as PurchaseOrderState[]) {
      expect(canReceive(s)).toBe(false);
    }
  });
});
