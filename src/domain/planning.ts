import Big from "big.js";
import { DomainError } from "./errors";
import type { Decimalish } from "./money";

export interface PlanLine {
  componentId: string;
  qty: Decimalish;
  /** Expected wastage as a percent of qty (10 means 10% extra is needed). */
  scrapPct: Decimalish;
}
/** One run of the BOM yields `outputQty` of the item. */
export interface PlanBom {
  outputQty: Decimalish;
  lines: readonly PlanLine[];
}
export interface PlanDemand {
  itemId: string;
  qty: Decimalish;
  /** "YYYY-MM-DD" */
  needBy: string;
  /** Optional label (e.g. a sales order id) reported back on every shortage this demand causes. */
  id?: string;
}
/** Stock on order: it only helps a demand if it arrives on or before the date the demand needs it. */
export interface PlanSupply {
  itemId: string;
  qty: Decimalish;
  /** "YYYY-MM-DD" */
  expectedBy: string;
}
export interface PlanShortage {
  itemId: string;
  /** Quantity to buy, rounded up to the unit's decimals. */
  qty: string;
  /** Earliest date any demand needs it by. */
  firstNeededBy: string;
  /** Labels of the demands left short on this item. Present only when demands carry an `id`. */
  demandIds?: string[];
}

const MAX_DEPTH = 25;
const ZERO = new Big(0);

/**
 * Material requirements: what must be bought to meet the demand.
 *
 * Demands are served earliest-need-first. For each item, what is available (on hand plus
 * incoming) is used first. Whatever is still missing is, if the item has a BOM, produced by
 * exploding the BOM and repeating for its components (so stock of semi-finished goods is used
 * before raw materials are asked for); otherwise it is a shortage to buy. Stock used by one
 * demand is not available to the next.
 *
 * `available` is stock that can be used at once. `incoming` is stock on order: used after
 * `available`, earliest arrival first, and only if it arrives by the demand's date. Stock used by
 * one demand is not available to the next.
 */
export function planShortages(args: {
  demands: readonly PlanDemand[];
  boms: ReadonlyMap<string, PlanBom>;
  available: ReadonlyMap<string, Decimalish>;
  incoming?: readonly PlanSupply[];
  /** Decimal places of an item's unit; defaults to 3. */
  decimalsOf?: (itemId: string) => number;
}): PlanShortage[] {
  const available = new Map<string, Big>();
  for (const [itemId, qty] of args.available) {
    const q = new Big(qty);
    available.set(itemId, q.gt(0) ? q : ZERO); // negative stock cannot be used
  }
  const lots = new Map<string, { qty: Big; expectedBy: string }[]>();
  for (const supply of [...(args.incoming ?? [])].sort((a, b) => a.expectedBy.localeCompare(b.expectedBy))) {
    const qty = new Big(supply.qty);
    if (qty.lte(0)) continue;
    lots.set(supply.itemId, [...(lots.get(supply.itemId) ?? []), { qty, expectedBy: supply.expectedBy }]);
  }
  const shortages = new Map<string, { qty: Big; firstNeededBy: string; sources: Set<string> }>();

  const need = (itemId: string, qty: Big, needBy: string, demandId: string | undefined, depth: number): void => {
    if (depth > MAX_DEPTH) {
      throw new DomainError("BOM_TOO_DEEP", `Bill of materials is nested more than ${MAX_DEPTH} levels (circular?)`);
    }
    const have = available.get(itemId) ?? ZERO;
    const used = qty.lt(have) ? qty : have;
    available.set(itemId, have.minus(used));
    let remaining = qty.minus(used);
    for (const lot of lots.get(itemId) ?? []) {
      if (remaining.lte(0) || lot.expectedBy > needBy) break; // sorted by arrival: later ones are later still
      const take = remaining.lt(lot.qty) ? remaining : lot.qty;
      lot.qty = lot.qty.minus(take);
      remaining = remaining.minus(take);
    }
    if (remaining.lte(0)) return;

    const bom = args.boms.get(itemId);
    if (!bom) {
      const existing = shortages.get(itemId);
      const sources = existing?.sources ?? new Set<string>();
      if (demandId !== undefined) sources.add(demandId);
      shortages.set(itemId, {
        qty: (existing?.qty ?? ZERO).plus(remaining),
        firstNeededBy: existing?.firstNeededBy ?? needBy,
        sources,
      });
      return;
    }
    for (const line of bom.lines) {
      // Multiply first and divide last, so repeating decimals do not creep in.
      const componentQty = remaining
        .times(line.qty)
        .times(new Big(100).plus(line.scrapPct))
        .div(new Big(bom.outputQty).times(100));
      need(line.componentId, componentQty, needBy, demandId, depth + 1);
    }
  };

  const ordered = args.demands
    .map((demand, index) => ({ demand, index }))
    .sort((a, b) => a.demand.needBy.localeCompare(b.demand.needBy) || a.index - b.index);
  for (const { demand } of ordered) need(demand.itemId, new Big(demand.qty), demand.needBy, demand.id, 0);

  return [...shortages]
    .map(([itemId, s]): PlanShortage => {
      const dp = args.decimalsOf?.(itemId) ?? 3;
      // Round off arithmetic noise first, then round UP: never under-buy by a fraction.
      const base = { itemId, qty: s.qty.round(9).round(dp, Big.roundUp).toFixed(dp), firstNeededBy: s.firstNeededBy };
      return s.sources.size > 0 ? { ...base, demandIds: [...s.sources].sort() } : base;
    })
    .sort((a, b) => a.firstNeededBy.localeCompare(b.firstNeededBy) || a.itemId.localeCompare(b.itemId));
}
