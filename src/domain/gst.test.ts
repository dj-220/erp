import { describe, expect, it } from "vitest";
import {
  computeInvoiceTax,
  computeTax,
  isAllowedGstRate,
  supplyKind,
} from "./gst";

describe("supplyKind", () => {
  it("is intra-state only when supplier state equals place of supply", () => {
    expect(supplyKind("27", "27")).toBe("intra");
    expect(supplyKind("27", "29")).toBe("inter");
    expect(supplyKind("27", "97")).toBe("inter");
  });

  it("rejects unknown state codes", () => {
    expect(() => supplyKind("27", "00")).toThrow(/Unknown GST state code/);
  });
});

describe("computeTax", () => {
  const base = { taxableValue: 100000, ratePercent: "18" } as const; // Rs 1,000.00 at 18%

  it("splits intra-state tax equally into CGST and SGST", () => {
    const t = computeTax({ ...base, supplierState: "27", placeOfSupply: "27" });
    expect(t).toMatchObject({ kind: "intra", cgst: 9000, sgst: 9000, utgst: 0, igst: 0, totalTax: 18000 });
  });

  it("charges IGST on inter-state supply", () => {
    const t = computeTax({ ...base, supplierState: "27", placeOfSupply: "29" });
    expect(t).toMatchObject({ kind: "inter", cgst: 0, sgst: 0, igst: 18000, totalTax: 18000 });
  });

  it("charges UTGST instead of SGST in a union territory without a legislature", () => {
    const t = computeTax({ ...base, supplierState: "04", placeOfSupply: "04" }); // Chandigarh
    expect(t).toMatchObject({ cgst: 9000, sgst: 0, utgst: 9000, totalTax: 18000 });
    const delhi = computeTax({ ...base, supplierState: "07", placeOfSupply: "07" }); // has a legislature
    expect(delhi).toMatchObject({ sgst: 9000, utgst: 0 });
  });

  it("keeps CGST equal to SGST when a half-rate leaves a fraction of a paisa", () => {
    // 50 paise at 5% -> 2.5% each = 1.25 paise -> 1 paisa each
    const t = computeTax({ taxableValue: 50, ratePercent: "5", supplierState: "27", placeOfSupply: "27" });
    expect(t.cgst).toBe(1);
    expect(t.sgst).toBe(1);
  });

  it("adds cess as its own head", () => {
    const t = computeTax({ ...base, supplierState: "27", placeOfSupply: "29", cessPercent: "1" });
    expect(t).toMatchObject({ igst: 18000, cess: 1000, totalTax: 19000 });
  });

  it("handles zero-rated and negative (credit note) amounts", () => {
    expect(computeTax({ taxableValue: 100000, ratePercent: "0", supplierState: "27", placeOfSupply: "27" }).totalTax).toBe(0);
    const credit = computeTax({ taxableValue: -100000, ratePercent: "18", supplierState: "27", placeOfSupply: "29" });
    expect(credit.igst).toBe(-18000);
  });

  it("rejects a negative rate", () => {
    expect(() => computeTax({ taxableValue: 100, ratePercent: "-5", supplierState: "27", placeOfSupply: "27" })).toThrow();
  });
});

describe("computeInvoiceTax", () => {
  it("sums per-line tax and rounds the total to the nearest rupee", () => {
    const inv = computeInvoiceTax([
      { taxableValue: 100000, ratePercent: "18", supplierState: "27", placeOfSupply: "27" }, // tax 180.00
      { taxableValue: 33333, ratePercent: "5", supplierState: "27", placeOfSupply: "27" }, // 2.5% = 8.33325 -> 8.33 each
    ]);
    expect(inv.taxableValue).toBe(133333);
    expect(inv.cgst).toBe(9000 + 833);
    expect(inv.sgst).toBe(9000 + 833);
    expect(inv.totalTax).toBe(19666);
    expect(inv.subtotal).toBe(152999); // Rs 1,529.99
    expect(inv.total).toBe(153000); // Rs 1,530
    expect(inv.roundOff).toBe(1);
    expect(inv.lines).toHaveLength(2);
  });

  it("is zero for an empty invoice", () => {
    expect(computeInvoiceTax([])).toMatchObject({ total: 0, roundOff: 0, totalTax: 0 });
  });
});

describe("isAllowedGstRate", () => {
  it("accepts current slabs and rejects retired ones unless asked", () => {
    expect(isAllowedGstRate("18")).toBe(true);
    expect(isAllowedGstRate("5.0")).toBe(true);
    expect(isAllowedGstRate("12")).toBe(false);
    expect(isAllowedGstRate("12", { allowLegacy: true })).toBe(true);
    expect(isAllowedGstRate("7")).toBe(false);
    expect(isAllowedGstRate("abc")).toBe(false);
  });
});
