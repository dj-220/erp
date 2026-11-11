import Big from "big.js";
import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { assertQty, averageCost, outboundValue, reorderSuggestion } from "./stock";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `non-domain: ${String(e)}`;
  }
  return undefined;
}

describe("assertQty", () => {
  it("accepts positive quantities within the unit's precision", () => {
    expect(assertQty("5", 0).toString()).toBe("5");
    expect(assertQty("2.125", 3).toString()).toBe("2.125");
  });

  it("rejects zero, negatives, too many decimals and non-numbers with a code", () => {
    expect(codeOf(() => assertQty("0", 3))).toBe("INVALID_QTY");
    expect(codeOf(() => assertQty("-1", 3))).toBe("INVALID_QTY");
    expect(codeOf(() => assertQty("1.5", 0))).toBe("QTY_PRECISION");
    expect(codeOf(() => assertQty("1.2345", 3))).toBe("QTY_PRECISION");
    expect(codeOf(() => assertQty("abc", 3))).toBe("INVALID_NUMBER");
  });
});

describe("averageCost", () => {
  it("is value divided by quantity, in rupees", () => {
    // 200 m worth Rs 3,000 -> Rs 15 a metre
    expect(averageCost(200, 300000)?.toString()).toBe("15");
    expect(averageCost(0, 0)).toBeNull();
    expect(averageCost(-3, 0)).toBeNull();
  });
});

describe("outboundValue", () => {
  it("values stock leaving at the weighted average", () => {
    expect(outboundValue({ qty: 50, onHandQty: 200, onHandValue: 300000 })).toBe(75000);
  });

  it("taking everything takes exactly all the value", () => {
    expect(outboundValue({ qty: 200, onHandQty: 200, onHandValue: 300000 })).toBe(300000);
  });

  it("never leaves a rounding residue when stock is issued piece by piece", () => {
    // 3 units worth 100 paise: 33, then 34, then the remaining 33
    let qty = 3;
    let value = 100;
    const issued: number[] = [];
    while (qty > 0) {
      const v = outboundValue({ qty: 1, onHandQty: qty, onHandValue: value });
      issued.push(v);
      qty -= 1;
      value -= v;
    }
    expect(issued).toEqual([33, 34, 33]);
    expect(value).toBe(0);
  });

  it("values stock that is not on hand at the fallback rate, else at the average", () => {
    expect(outboundValue({ qty: 5, onHandQty: 0, onHandValue: 0, fallbackRate: "7" })).toBe(3500);
    expect(outboundValue({ qty: 5, onHandQty: 0, onHandValue: 0 })).toBe(0);
    // 10 on hand worth Rs 100 (Rs 10 each); issuing 15
    expect(outboundValue({ qty: 15, onHandQty: 10, onHandValue: 10000 })).toBe(15000);
    expect(outboundValue({ qty: 15, onHandQty: 10, onHandValue: 10000, fallbackRate: "7" })).toBe(13500);
  });
});

describe("reorderSuggestion", () => {
  const base = { reorderLevel: 50, reorderQty: 200 };

  it("suggests the fixed quantity once stock is at or below the level", () => {
    expect(reorderSuggestion({ ...base, onHand: 40 })?.toString()).toBe("200");
    expect(reorderSuggestion({ ...base, onHand: 50 })?.toString()).toBe("200");
  });

  it("stays quiet while stock is above the level or covered by incoming orders", () => {
    expect(reorderSuggestion({ ...base, onHand: 60 })).toBeNull();
    expect(reorderSuggestion({ ...base, onHand: 40, incoming: 100 })).toBeNull();
  });

  it("orders at least enough to get back to the level", () => {
    expect(reorderSuggestion({ reorderLevel: 50, reorderQty: 20, onHand: 10 })?.toString()).toBe("40");
  });

  it("does nothing without a reorder level", () => {
    expect(reorderSuggestion({ reorderLevel: 0, reorderQty: 100, onHand: 0 })).toBeNull();
    expect(reorderSuggestion({ reorderLevel: new Big(0), reorderQty: 100, onHand: -5 })).toBeNull();
  });
});
