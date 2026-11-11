import Big from "big.js";
import { computeInvoiceTax } from "./gst";
import { parseGstin } from "./gstin";
import { type Decimalish, type Paise, formatINR, lineAmount, sumPaise } from "./money";

/** How far a bill may stray from the order before it is held. All default to "not at all", except rounding. */
export interface MatchTolerance {
  /** Percent the billed unit price may exceed the ordered price. */
  ratePct: Decimalish;
  /** Percent the billed quantity may exceed what has been received and not yet billed. */
  qtyPct: Decimalish;
  /** Rounding allowance on money totals, in paise. */
  amountPaise: Paise;
}
export const DEFAULT_TOLERANCE: MatchTolerance = { ratePct: 0, qtyPct: 0, amountPaise: 100 };

/** What the order and the goods received say about one order line. */
export interface MatchPoLine {
  lineNo: number;
  sku: string;
  received: Decimalish;
  /** Quantity already billed on other bills (held, matched or posted). */
  billedBefore: Decimalish;
  /** Ordered rupees per unit after discount. */
  unitCost: Decimalish;
  /** GST rate the order carries (0 for a supplier that may not charge GST). */
  gstRate: Decimalish;
}

/** One line as the supplier billed it. */
export interface MatchBillLine {
  lineNo: number;
  poLineNo: number;
  qty: Decimalish;
  /** Billed rupees per unit after discount. */
  unitCost: Decimalish;
  gstRate: Decimalish;
  /** Billed value of the line before tax. */
  taxablePaise: Paise;
}

/** The totals exactly as printed on the supplier's bill. */
export interface StatedAmounts {
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  utgst: Paise;
  igst: Paise;
  cess: Paise;
  roundOff: Paise;
  total: Paise;
}

export interface MatchInput {
  tolerance: MatchTolerance;
  /** The supplier as held in master data. */
  supplier: { gstin: string | null; registration: string };
  /** Decide whether CGST + SGST or IGST is due. */
  place: { supplierState: string; placeOfSupply: string };
  bill: { gstin: string | null; lines: readonly MatchBillLine[]; stated: StatedAmounts };
  poLines: readonly MatchPoLine[];
}

export type FindingCode =
  | "GSTIN_MISSING"
  | "GSTIN_INVALID"
  | "GSTIN_MISMATCH"
  | "QTY_OVER_RECEIVED"
  | "RATE_MISMATCH"
  | "GST_RATE_MISMATCH"
  | "AMOUNT_OVER_RECEIVED_VALUE"
  | "ARITHMETIC"
  | "TAX_TYPE_MISMATCH"
  | "TAX_AMOUNT_MISMATCH";

/** One reason a bill does not match. Any finding holds the bill. */
export interface Finding {
  code: FindingCode;
  /** The bill line it concerns, when it concerns one. */
  line?: number;
  message: string;
  expected?: string;
  actual?: string;
}

const qtyText = (v: Big) => v.toFixed(3).replace(/\.?0+$/, "");

/**
 * Three-way match: the supplier's bill against what was ordered and what actually arrived.
 * Returns every reason the bill should not be paid as it stands; an empty list means it matches.
 * Pure: no database, no clock.
 */
export function threeWayMatch(input: MatchInput): Finding[] {
  const findings: Finding[] = [];
  const tol = input.tolerance;
  const money = tol.amountPaise;
  const poByLine = new Map(input.poLines.map((l) => [l.lineNo, l]));

  // Supplier identity: a missing or wrong GSTIN means the buyer cannot claim input tax credit.
  const billGstin = input.bill.gstin?.trim().toUpperCase() || null;
  if (billGstin === null) {
    if (input.supplier.registration === "regular") {
      findings.push({ code: "GSTIN_MISSING", message: "The bill has no supplier GSTIN, so input tax credit is at risk" });
    }
  } else {
    const parsed = parseGstin(billGstin);
    if (!parsed.valid) {
      findings.push({ code: "GSTIN_INVALID", message: `The supplier GSTIN on the bill (${billGstin}) is not valid`, actual: billGstin });
    } else if (input.supplier.gstin && parsed.gstin !== input.supplier.gstin.toUpperCase()) {
      findings.push({
        code: "GSTIN_MISMATCH",
        message: `The bill carries GSTIN ${parsed.gstin} but the supplier on the order is ${input.supplier.gstin}`,
        expected: input.supplier.gstin,
        actual: parsed.gstin,
      });
    }
  }

  // Line by line: quantity, price and tax rate.
  let rateMismatch = false;
  let okValue: Paise = 0;
  for (const line of input.bill.lines) {
    const po = poByLine.get(line.poLineNo);
    if (!po) throw new Error(`Bill line ${line.lineNo} refers to order line ${line.poLineNo}, which was not supplied`);
    const qty = new Big(line.qty);
    const open = new Big(po.received).minus(po.billedBefore);
    const available = open.gt(0) ? open : new Big(0);
    const billableQty = available.times(new Big(100).plus(tol.qtyPct)).div(100);
    if (qty.gt(billableQty)) {
      findings.push({
        code: "QTY_OVER_RECEIVED",
        line: line.lineNo,
        message: `${po.sku}: billed ${qtyText(qty)} but only ${qtyText(available)} received and not yet billed`,
        expected: qtyText(available),
        actual: qtyText(qty),
      });
    }

    const orderedCost = new Big(po.unitCost);
    const allowedCost = orderedCost.times(new Big(100).plus(tol.ratePct)).div(100);
    const billedCost = new Big(line.unitCost);
    if (billedCost.gt(allowedCost)) {
      findings.push({
        code: "RATE_MISMATCH",
        line: line.lineNo,
        message: `${po.sku}: billed at ₹${billedCost.toString()} per unit but the order says ₹${orderedCost.toString()}`,
        expected: orderedCost.toString(),
        actual: billedCost.toString(),
      });
    }
    if (!new Big(line.gstRate).eq(po.gstRate)) {
      rateMismatch = true;
      findings.push({
        code: "GST_RATE_MISMATCH",
        line: line.lineNo,
        message: `${po.sku}: GST charged at ${new Big(line.gstRate).toString()}% but the order carries ${new Big(po.gstRate).toString()}%`,
        expected: new Big(po.gstRate).toString(),
        actual: new Big(line.gstRate).toString(),
      });
    }
    // What the goods actually received are worth at the ordered price (plus any allowed tolerance).
    const payable = qty.lt(billableQty) ? qty : billableQty;
    okValue += lineAmount(payable, billedCost.lt(allowedCost) ? billedCost : allowedCost);
  }

  const billedValue = sumPaise(input.bill.lines.map((l) => l.taxablePaise));
  if (billedValue - okValue > money) {
    findings.push({
      code: "AMOUNT_OVER_RECEIVED_VALUE",
      message: `The bill is for ${formatINR(billedValue)} before tax; the goods received, at the ordered prices, come to ${formatINR(okValue)} (${formatINR(billedValue - okValue)} more)`,
      expected: String(okValue),
      actual: String(billedValue),
    });
  }

  // Does the bill add up?
  const s = input.bill.stated;
  if (Math.abs(s.taxable - billedValue) > money) {
    findings.push({
      code: "ARITHMETIC",
      message: `The lines add up to ${formatINR(billedValue)} but the bill states ${formatINR(s.taxable)} before tax`,
      expected: String(billedValue),
      actual: String(s.taxable),
    });
  }
  const statedSum = s.taxable + s.cgst + s.sgst + s.utgst + s.igst + s.cess + s.roundOff;
  if (Math.abs(s.total - statedSum) > money) {
    findings.push({
      code: "ARITHMETIC",
      message: `The bill total ${formatINR(s.total)} does not equal its own parts (${formatINR(statedSum)})`,
      expected: String(statedSum),
      actual: String(s.total),
    });
  }

  // Tax: the right kind (IGST vs CGST + SGST) and the right amounts, worked out at the order's rates.
  if (!rateMismatch && input.bill.lines.length > 0) {
    const expected = computeInvoiceTax(
      input.bill.lines.map((l) => ({
        taxableValue: l.taxablePaise,
        ratePercent: (poByLine.get(l.poLineNo) as MatchPoLine).gstRate,
        supplierState: input.place.supplierState,
        placeOfSupply: input.place.placeOfSupply,
      })),
    );
    const kind = expected.lines[0]?.kind;
    const statedLocal = s.cgst + s.sgst + s.utgst;
    let wrongType = false;
    if (expected.totalTax > 0) {
      if (kind === "intra" && s.igst > money) {
        wrongType = true;
        findings.push({ code: "TAX_TYPE_MISMATCH", message: `IGST of ${formatINR(s.igst)} is charged but this supply is within the state, so CGST + SGST is due; input credit may be refused` });
      } else if (kind === "inter" && statedLocal > money) {
        wrongType = true;
        findings.push({ code: "TAX_TYPE_MISMATCH", message: `CGST + SGST of ${formatINR(statedLocal)} is charged but this supply is between states, so IGST is due; input credit may be refused` });
      }
    }
    if (!wrongType) {
      const heads: [string, Paise, Paise][] = [
        ["CGST", s.cgst, expected.cgst],
        ["SGST", s.sgst, expected.sgst],
        ["UTGST", s.utgst, expected.utgst],
        ["IGST", s.igst, expected.igst],
        ["Cess", s.cess, expected.cess],
      ];
      for (const [name, stated, due] of heads) {
        if (Math.abs(stated - due) > money) {
          findings.push({
            code: "TAX_AMOUNT_MISMATCH",
            message: `${name} on the bill is ${formatINR(stated)} but ${formatINR(due)} is due on ${formatINR(billedValue)}`,
            expected: String(due),
            actual: String(stated),
          });
        }
      }
    }
  }
  return findings;
}
