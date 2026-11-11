import Big from "big.js";
import { DomainError } from "./errors";
import { type Decimalish, type Paise, percentOf, roundToRupee, sumPaise } from "./money";
import { requireState } from "./states";

/**
 * GST rate slabs are DATA, not logic: the Council changes them. Verify these with your
 * chartered accountant before go-live. Legacy slabs stay valid so that documents
 * dated before a rate change can still be read and re-exported.
 */
export const GST_RATES_CURRENT = ["0", "0.25", "3", "5", "18", "40"] as const;
export const GST_RATES_LEGACY = ["12", "28"] as const;

export function isAllowedGstRate(rate: Decimalish, options: { allowLegacy?: boolean } = {}): boolean {
  let value: Big;
  try {
    value = new Big(rate);
  } catch {
    return false;
  }
  const allowed: readonly string[] = options.allowLegacy
    ? [...GST_RATES_CURRENT, ...GST_RATES_LEGACY]
    : GST_RATES_CURRENT;
  return allowed.some((r) => value.eq(r));
}

export type SupplyKind = "intra" | "inter";

/** Intra-state when the supplier's state equals the place of supply, otherwise inter-state. */
export function supplyKind(supplierState: string, placeOfSupply: string): SupplyKind {
  requireState(supplierState);
  requireState(placeOfSupply);
  return supplierState === placeOfSupply ? "intra" : "inter";
}

export interface TaxInput {
  /** Taxable value after discounts, in paise. */
  taxableValue: Paise;
  /** Total GST rate in percent, e.g. "18". Split in half for CGST + SGST/UTGST. */
  ratePercent: Decimalish;
  /** State code of the supplier (the company when selling, the vendor when buying). */
  supplierState: string;
  /** State code where the supply is made (ship-to for goods). */
  placeOfSupply: string;
  /** Optional compensation cess, in percent. */
  cessPercent?: Decimalish;
}

export interface TaxBreakup {
  kind: SupplyKind;
  taxableValue: Paise;
  ratePercent: string;
  cgst: Paise;
  sgst: Paise;
  utgst: Paise;
  igst: Paise;
  cess: Paise;
  totalTax: Paise;
}

/**
 * Tax for one invoice line. Intra-state supplies split the rate equally into CGST and
 * SGST (UTGST for union territories without a legislature); each head is rounded to whole
 * paise separately, so CGST always equals SGST. Inter-state supplies charge IGST.
 */
export function computeTax(input: TaxInput): TaxBreakup {
  const rate = new Big(input.ratePercent);
  if (rate.lt(0)) throw new DomainError("NEGATIVE_RATE", "GST rate cannot be negative");
  const kind = supplyKind(input.supplierState, input.placeOfSupply);
  const supplier = requireState(input.supplierState);

  let cgst = 0;
  let sgst = 0;
  let utgst = 0;
  let igst = 0;
  if (kind === "intra") {
    const half = percentOf(input.taxableValue, rate.div(2));
    cgst = half;
    if (supplier.utgst) utgst = half;
    else sgst = half;
  } else {
    igst = percentOf(input.taxableValue, rate);
  }
  const cess = input.cessPercent === undefined ? 0 : percentOf(input.taxableValue, input.cessPercent);

  return {
    kind,
    taxableValue: input.taxableValue,
    ratePercent: rate.toString(),
    cgst,
    sgst,
    utgst,
    igst,
    cess,
    totalTax: sumPaise([cgst, sgst, utgst, igst, cess]),
  };
}

export interface InvoiceTax {
  lines: TaxBreakup[];
  taxableValue: Paise;
  cgst: Paise;
  sgst: Paise;
  utgst: Paise;
  igst: Paise;
  cess: Paise;
  totalTax: Paise;
  /** Taxable value + tax, before rounding. */
  subtotal: Paise;
  /** Final payable, rounded to the nearest rupee. */
  total: Paise;
  /** The adjustment applied to reach `total` (can be negative). */
  roundOff: Paise;
}

/** Tax is computed per line and summed, so every line is traceable on its own. */
export function computeInvoiceTax(inputs: readonly TaxInput[]): InvoiceTax {
  const lines = inputs.map(computeTax);
  const sum = (pick: (l: TaxBreakup) => Paise) => sumPaise(lines.map(pick));
  const taxableValue = sum((l) => l.taxableValue);
  const totalTax = sum((l) => l.totalTax);
  const subtotal = sumPaise([taxableValue, totalTax]);
  const { rounded, roundOff } = roundToRupee(subtotal);
  return {
    lines,
    taxableValue,
    cgst: sum((l) => l.cgst),
    sgst: sum((l) => l.sgst),
    utgst: sum((l) => l.utgst),
    igst: sum((l) => l.igst),
    cess: sum((l) => l.cess),
    totalTax,
    subtotal,
    total: rounded,
    roundOff,
  };
}
