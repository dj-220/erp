import { describe, expect, it } from "vitest";
import { gstinChecksumChar } from "./gstin";
import { DEFAULT_TOLERANCE, type MatchInput, type StatedAmounts, threeWayMatch } from "./matching";

const gstin = (body14: string) => body14 + gstinChecksumChar(body14);
const SUPPLIER_GSTIN = gstin("29AABCU9603R1Z");

/**
 * 2,500 m of fabric ordered at Rs 262/m with 5% GST, all received, from a Karnataka supplier to a
 * Maharashtra warehouse (so IGST). The default bill below matches this exactly.
 */
function base(overrides: Partial<MatchInput> = {}): MatchInput {
  const taxable = 65_500_000; // 2,500 x Rs 262
  const stated: StatedAmounts = { taxable, cgst: 0, sgst: 0, utgst: 0, igst: 3_275_000, cess: 0, roundOff: 0, total: 68_775_000 };
  return {
    tolerance: DEFAULT_TOLERANCE,
    supplier: { gstin: SUPPLIER_GSTIN, registration: "regular" },
    place: { supplierState: "29", placeOfSupply: "27" },
    bill: { gstin: SUPPLIER_GSTIN, lines: [{ lineNo: 1, poLineNo: 1, qty: 2500, unitCost: 262, gstRate: 5, taxablePaise: taxable }], stated },
    poLines: [{ lineNo: 1, sku: "FAB", received: 2500, billedBefore: 0, unitCost: 262, gstRate: 5 }],
    ...overrides,
  };
}

const codes = (input: MatchInput) => threeWayMatch(input).map((f) => f.code);

/** A bill with its stated totals derived from one line, so tests change one thing at a time. */
function billOf(args: { qty: number; unitCost: number; gstRate: number; taxable: number; igst?: number; cgst?: number; sgst?: number; gstin?: string | null }): MatchInput["bill"] {
  const igst = args.igst ?? 0;
  const cgst = args.cgst ?? 0;
  const sgst = args.sgst ?? 0;
  return {
    gstin: args.gstin === undefined ? SUPPLIER_GSTIN : args.gstin,
    lines: [{ lineNo: 1, poLineNo: 1, qty: args.qty, unitCost: args.unitCost, gstRate: args.gstRate, taxablePaise: args.taxable }],
    stated: { taxable: args.taxable, cgst, sgst, utgst: 0, igst, cess: 0, roundOff: 0, total: args.taxable + igst + cgst + sgst },
  };
}

describe("a bill that matches", () => {
  it("raises no findings", () => {
    expect(threeWayMatch(base())).toEqual([]);
  });

  it("accepts a supplier GSTIN typed in lower case", () => {
    const input = base();
    input.bill.gstin = SUPPLIER_GSTIN.toLowerCase();
    expect(codes(input)).toEqual([]);
  });

  it("accepts a partial bill for part of what was received", () => {
    const taxable = 26_200_000; // 1,000 x 262
    expect(codes(base({ bill: billOf({ qty: 1000, unitCost: 262, gstRate: 5, taxable, igst: 1_310_000 }) }))).toEqual([]);
  });
});

describe("the over-billed bill with no GSTIN", () => {
  // 2,550 m billed, 2,500 m received, supplier GSTIN missing: Rs 13,100 more than the goods justify
  const kyros = () => base({ bill: billOf({ qty: 2550, unitCost: 262, gstRate: 5, taxable: 66_810_000, igst: 3_340_500, gstin: null }) });

  it("is held for each reason", () => {
    expect(codes(kyros())).toEqual(["GSTIN_MISSING", "QTY_OVER_RECEIVED", "AMOUNT_OVER_RECEIVED_VALUE"]);
  });

  it("says what is wrong in plain words", () => {
    const [missing, qty, amount] = threeWayMatch(kyros());
    expect(missing?.message).toContain("input tax credit is at risk");
    expect(qty).toMatchObject({ line: 1, expected: "2500", actual: "2550", message: "FAB: billed 2550 but only 2500 received and not yet billed" });
    expect(amount?.message).toContain("₹13,100.00 more");
  });
});

describe("supplier identity", () => {
  it("rejects an invalid or different GSTIN, but not a missing one from a supplier who need not have one", () => {
    const invalid = base();
    invalid.bill.gstin = `${SUPPLIER_GSTIN.slice(0, 14)}${SUPPLIER_GSTIN[14] === "A" ? "B" : "A"}`;
    expect(codes(invalid)).toEqual(["GSTIN_INVALID"]);

    const other = base();
    other.bill.gstin = gstin("27ABCDE1234F1Z");
    expect(threeWayMatch(other)).toMatchObject([{ code: "GSTIN_MISMATCH", expected: SUPPLIER_GSTIN, actual: other.bill.gstin }]);

    const composition = base({ supplier: { gstin: null, registration: "composition" } });
    composition.bill.gstin = null;
    expect(codes(composition)).toEqual([]);
  });
});

describe("price, tax rate and quantity", () => {
  const dearer = () => base({ bill: billOf({ qty: 2500, unitCost: 265, gstRate: 5, taxable: 66_250_000, igst: 3_312_500 }) });

  it("holds a higher price than ordered", () => {
    expect(codes(dearer())).toEqual(["RATE_MISMATCH", "AMOUNT_OVER_RECEIVED_VALUE"]);
  });

  it("lets a small price difference through when a rate tolerance allows it", () => {
    const tolerant = dearer();
    tolerant.tolerance = { ...DEFAULT_TOLERANCE, ratePct: 2 }; // 265 is within 2% of 262
    expect(codes(tolerant)).toEqual([]);
  });

  it("holds a different GST rate, and reports only that rather than every amount that follows from it", () => {
    const wrongRate = base({ bill: billOf({ qty: 2500, unitCost: 262, gstRate: 18, taxable: 65_500_000, igst: 11_790_000 }) });
    expect(threeWayMatch(wrongRate)).toMatchObject([{ code: "GST_RATE_MISMATCH", line: 1, expected: "5", actual: "18" }]);
  });

  it("counts what earlier bills already used up", () => {
    const input = base({
      poLines: [{ lineNo: 1, sku: "FAB", received: 100, billedBefore: 60, unitCost: 100, gstRate: 5 }],
      bill: billOf({ qty: 50, unitCost: 100, gstRate: 5, taxable: 500_000, igst: 25_000 }),
    });
    expect(threeWayMatch(input)).toMatchObject([{ code: "QTY_OVER_RECEIVED", expected: "40", actual: "50" }, { code: "AMOUNT_OVER_RECEIVED_VALUE" }]);
  });

  it("lets a small over-delivery through when a quantity tolerance allows it", () => {
    const input = base({
      poLines: [{ lineNo: 1, sku: "FAB", received: 100, billedBefore: 0, unitCost: 100, gstRate: 5 }],
      bill: billOf({ qty: 105, unitCost: 100, gstRate: 5, taxable: 1_050_000, igst: 52_500 }),
    });
    expect(codes(input)).toEqual(["QTY_OVER_RECEIVED", "AMOUNT_OVER_RECEIVED_VALUE"]);
    input.tolerance = { ...DEFAULT_TOLERANCE, qtyPct: 10 };
    expect(codes(input)).toEqual([]);
  });

  it("names the line a finding belongs to", () => {
    const input = base({
      poLines: [
        { lineNo: 1, sku: "FAB", received: 100, billedBefore: 0, unitCost: 100, gstRate: 5 },
        { lineNo: 2, sku: "BTN", received: 10, billedBefore: 0, unitCost: 10, gstRate: 5 },
      ],
    });
    input.bill = {
      gstin: SUPPLIER_GSTIN,
      lines: [
        { lineNo: 1, poLineNo: 1, qty: 100, unitCost: 100, gstRate: 5, taxablePaise: 1_000_000 },
        { lineNo: 2, poLineNo: 2, qty: 11, unitCost: 10, gstRate: 5, taxablePaise: 11_000 },
      ],
      stated: { taxable: 1_011_000, cgst: 0, sgst: 0, utgst: 0, igst: 50_550, cess: 0, roundOff: 0, total: 1_061_550 },
    };
    expect(threeWayMatch(input).find((f) => f.code === "QTY_OVER_RECEIVED")).toMatchObject({ line: 2 });
  });
});

describe("tax kind and amounts", () => {
  it("holds IGST charged on a supply within the state, which would cost input credit", () => {
    // Supplier and warehouse both in Maharashtra: CGST + SGST is due, not IGST
    const input = base({
      place: { supplierState: "27", placeOfSupply: "27" },
      poLines: [{ lineNo: 1, sku: "FAB", received: 100, billedBefore: 0, unitCost: 100, gstRate: 18 }],
      bill: billOf({ qty: 100, unitCost: 100, gstRate: 18, taxable: 1_000_000, igst: 180_000 }),
    });
    expect(threeWayMatch(input)).toMatchObject([{ code: "TAX_TYPE_MISMATCH" }]);
  });

  it("holds CGST + SGST charged on a supply between states", () => {
    const input = base({ bill: billOf({ qty: 2500, unitCost: 262, gstRate: 5, taxable: 65_500_000, cgst: 1_637_500, sgst: 1_637_500 }) });
    expect(threeWayMatch(input)).toMatchObject([{ code: "TAX_TYPE_MISMATCH" }]);
  });

  it("accepts correct CGST + SGST within the state", () => {
    const input = base({
      place: { supplierState: "27", placeOfSupply: "27" },
      poLines: [{ lineNo: 1, sku: "FAB", received: 100, billedBefore: 0, unitCost: 100, gstRate: 18 }],
      bill: billOf({ qty: 100, unitCost: 100, gstRate: 18, taxable: 1_000_000, cgst: 90_000, sgst: 90_000 }),
    });
    expect(codes(input)).toEqual([]);
  });

  it("holds a wrong tax amount, but allows a rounding difference", () => {
    const wrong = base({ bill: billOf({ qty: 2500, unitCost: 262, gstRate: 5, taxable: 65_500_000, igst: 3_274_500 }) }); // 500 paise short
    expect(threeWayMatch(wrong)).toMatchObject([{ code: "TAX_AMOUNT_MISMATCH", expected: "3275000", actual: "3274500" }]);
    const rounding = base({ bill: billOf({ qty: 2500, unitCost: 262, gstRate: 5, taxable: 65_500_000, igst: 3_274_950 }) }); // 50 paise short
    expect(codes(rounding)).toEqual([]);
  });

  it("holds tax charged by a supplier who may not charge it", () => {
    const input = base({
      supplier: { gstin: null, registration: "composition" },
      poLines: [{ lineNo: 1, sku: "FAB", received: 100, billedBefore: 0, unitCost: 100, gstRate: 0 }],
      bill: billOf({ qty: 100, unitCost: 100, gstRate: 0, taxable: 1_000_000, igst: 50_000, gstin: null }),
    });
    expect(threeWayMatch(input)).toMatchObject([{ code: "TAX_AMOUNT_MISMATCH", expected: "0", actual: "50000" }]);
  });
});

describe("a bill that does not add up", () => {
  it("is held when the stated value differs from its lines", () => {
    const input = base();
    input.bill.stated = { ...input.bill.stated, taxable: 65_600_000, total: 68_875_000 };
    expect(threeWayMatch(input)).toMatchObject([{ code: "ARITHMETIC", expected: "65500000", actual: "65600000" }]);
  });

  it("is held when the total differs from its own parts", () => {
    const input = base();
    input.bill.stated = { ...input.bill.stated, total: 68_780_000 };
    expect(threeWayMatch(input)).toMatchObject([{ code: "ARITHMETIC", expected: "68775000", actual: "68780000" }]);
  });
});
