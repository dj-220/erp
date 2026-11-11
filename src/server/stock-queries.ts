import Big from "big.js";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "../db/client";
import { bomLines, boms, items, uoms } from "../db/schema";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import type { Paise } from "../domain/money";
import { type PlanBom, type PlanSupply, planShortages } from "../domain/planning";
import { assertQty, averageCost, reorderSuggestion } from "../domain/stock";
import { openIncoming } from "./purchase-queries";

type Row = Record<string, unknown>;

export interface OnHand {
  qty: Big;
  valuePaise: Paise;
}

/**
 * Company-wide stock per item: what sits in internal locations, from done moves only.
 * Moves between two internal locations cancel out, so only receipts, deliveries and
 * adjustments change the totals. Pass `itemIds` to limit the query.
 */
export async function onHandByItem(
  db: Executor,
  companyId: string,
  itemIds?: readonly string[],
): Promise<Map<string, OnHand>> {
  const result = new Map<string, OnHand>();
  if (itemIds && itemIds.length === 0) return result;
  const filter =
    itemIds === undefined ? sql`` : sql`AND m.item_id IN (${sql.join(itemIds.map((id) => sql`${id}`), sql`, `)})`;
  const { rows } = await db.execute(sql`
    SELECT m.item_id AS item_id,
      (sum(CASE WHEN tl.kind = 'internal' THEN m.qty ELSE 0 END)
        - sum(CASE WHEN fl.kind = 'internal' THEN m.qty ELSE 0 END))::text AS qty,
      (sum(CASE WHEN tl.kind = 'internal' THEN m.value_paise ELSE 0 END)
        - sum(CASE WHEN fl.kind = 'internal' THEN m.value_paise ELSE 0 END))::text AS value
    FROM stock_moves m
    JOIN locations fl ON fl.company_id = m.company_id AND fl.id = m.from_location_id
    JOIN locations tl ON tl.company_id = m.company_id AND tl.id = m.to_location_id
    WHERE m.company_id = ${companyId} AND m.state = 'done' ${filter}
    GROUP BY m.item_id`);
  for (const row of rows as Row[]) {
    result.set(String(row.item_id), { qty: new Big(String(row.qty)), valuePaise: Number(row.value) });
  }
  return result;
}

/** Quantity of one item at one location (done moves only). */
export async function balanceAt(db: Executor, companyId: string, itemId: string, locationId: string): Promise<Big> {
  const { rows } = await db.execute(sql`
    SELECT (coalesce(sum(CASE WHEN to_location_id = ${locationId} THEN qty ELSE 0 END), 0)
          - coalesce(sum(CASE WHEN from_location_id = ${locationId} THEN qty ELSE 0 END), 0))::text AS qty
    FROM stock_moves
    WHERE company_id = ${companyId} AND item_id = ${itemId} AND state = 'done'
      AND (to_location_id = ${locationId} OR from_location_id = ${locationId})`);
  return new Big(String((rows as Row[])[0]?.qty ?? "0"));
}

export interface StockBalance {
  sku: string;
  name: string;
  uom: string;
  location: string;
  qty: string;
}

/** Stock per item per internal location. Zero balances are left out. */
export async function getStockBalances(
  db: Executor,
  args: { companyId: string; sku?: string; locationName?: string },
): Promise<StockBalance[]> {
  const skuFilter = args.sku ? sql`AND i.sku = ${args.sku}` : sql``;
  const locFilter = args.locationName ? sql`AND l.name = ${args.locationName}` : sql``;
  const { rows } = await db.execute(sql`
    SELECT i.sku AS sku, i.name AS name, u.code AS uom, l.name AS location, t.qty::text AS qty
    FROM (
      SELECT item_id, location_id, sum(delta) AS qty FROM (
        SELECT item_id, to_location_id AS location_id, qty AS delta
          FROM stock_moves WHERE company_id = ${args.companyId} AND state = 'done'
        UNION ALL
        SELECT item_id, from_location_id AS location_id, -qty AS delta
          FROM stock_moves WHERE company_id = ${args.companyId} AND state = 'done'
      ) x GROUP BY item_id, location_id HAVING sum(delta) <> 0
    ) t
    JOIN items i ON i.company_id = ${args.companyId} AND i.id = t.item_id
    JOIN uoms u ON u.company_id = i.company_id AND u.id = i.uom_id
    JOIN locations l ON l.company_id = i.company_id AND l.id = t.location_id AND l.kind = 'internal'
    WHERE true ${skuFilter} ${locFilter}
    ORDER BY i.sku, l.name`);
  return (rows as Row[]).map((r) => ({
    sku: String(r.sku),
    name: String(r.name),
    uom: String(r.uom),
    location: String(r.location),
    qty: new Big(String(r.qty)).toFixed(3),
  }));
}

export interface ValuationRow {
  sku: string;
  name: string;
  uom: string;
  qty: string;
  valuePaise: Paise;
  /** Rupees per unit, four decimals; null when nothing is in stock. */
  avgCost: string | null;
}

/** Stock value per item at weighted-average cost, plus the total. */
export async function getStockValuation(
  db: Executor,
  args: { companyId: string },
): Promise<{ rows: ValuationRow[]; totalValuePaise: Paise }> {
  const onHand = await onHandByItem(db, args.companyId);
  const catalogue = await db
    .select({ id: items.id, sku: items.sku, name: items.name, uom: uoms.code })
    .from(items)
    .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
    .where(eq(items.companyId, args.companyId));
  const rows: ValuationRow[] = [];
  for (const item of catalogue) {
    const stock = onHand.get(item.id);
    if (!stock || (stock.qty.eq(0) && stock.valuePaise === 0)) continue;
    rows.push({
      sku: item.sku,
      name: item.name,
      uom: item.uom,
      qty: stock.qty.toFixed(3),
      valuePaise: stock.valuePaise,
      avgCost: averageCost(stock.qty, stock.valuePaise)?.toFixed(4) ?? null,
    });
  }
  rows.sort((a, b) => a.sku.localeCompare(b.sku));
  return { rows, totalValuePaise: rows.reduce((sum, r) => sum + r.valuePaise, 0) };
}

export interface ReorderRow {
  sku: string;
  name: string;
  uom: string;
  onHand: string;
  reorderLevel: string;
  suggestedQty: string;
}

/** Active items that are at or below their reorder level, with a suggested order quantity. */
export async function getReorderSuggestions(
  db: Executor,
  args: {
    companyId: string;
    incomingBySku?: ReadonlyMap<string, string | number>;
    /** Count approved and sent purchase orders as already on order. Default true. */
    includePurchaseOrders?: boolean;
  },
): Promise<ReorderRow[]> {
  const onHand = await onHandByItem(db, args.companyId);
  const onOrder = new Map<string, Big>();
  if (args.includePurchaseOrders ?? true) {
    for (const supply of await openIncoming(db, args.companyId)) {
      onOrder.set(supply.itemId, (onOrder.get(supply.itemId) ?? new Big(0)).plus(supply.qty));
    }
  }
  const catalogue = await db
    .select({
      id: items.id,
      sku: items.sku,
      name: items.name,
      uom: uoms.code,
      reorderLevel: items.reorderLevel,
      reorderQty: items.reorderQty,
    })
    .from(items)
    .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
    .where(and(eq(items.companyId, args.companyId), eq(items.isActive, true)));
  const out: ReorderRow[] = [];
  for (const item of catalogue) {
    const have = onHand.get(item.id)?.qty ?? new Big(0);
    const suggestion = reorderSuggestion({
      onHand: have,
      incoming: new Big(args.incomingBySku?.get(item.sku) ?? 0).plus(onOrder.get(item.id) ?? 0),
      reorderLevel: item.reorderLevel,
      reorderQty: item.reorderQty,
    });
    if (suggestion) {
      out.push({
        sku: item.sku,
        name: item.name,
        uom: item.uom,
        onHand: have.toFixed(3),
        reorderLevel: item.reorderLevel,
        suggestedQty: suggestion.toFixed(3),
      });
    }
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku));
}

export const ShortageInput = z.object({
  companyId: z.uuid(),
  /** What must be produced or shipped. Until sales orders exist this is supplied by hand. */
  demands: z.array(z.object({ sku: z.string().min(1), qty: z.union([z.string(), z.number()]), needBy: z.string() })).min(1),
  /** Extra stock you know is coming that is not on a purchase order, by SKU. Counted as available now. */
  incoming: z.array(z.object({ sku: z.string().min(1), qty: z.union([z.string(), z.number()]) })).default([]),
  /** Count approved and sent purchase orders as stock on order, by their expected dates. */
  includePurchaseOrders: z.boolean().default(true),
});
export type ShortageInput = z.input<typeof ShortageInput>;

export interface ShortageRow {
  sku: string;
  name: string;
  uom: string;
  qtyToBuy: string;
  firstNeededBy: string;
}

export interface PlanningInputs {
  catalogue: { id: string; sku: string; name: string; kind: string; uom: string; decimals: number }[];
  bySku: Map<string, PlanningInputs["catalogue"][number]>;
  byId: Map<string, PlanningInputs["catalogue"][number]>;
  /** Active BOM per produced item. */
  planBoms: Map<string, PlanBom>;
  /** Stock on hand per item id (internal locations). */
  onHand: Map<string, Big>;
  /** Stock on order from suppliers (approved or sent purchase orders), with expected dates. */
  incoming: PlanSupply[];
}

/** Everything the planner needs from the database: items, active BOMs and stock on hand. */
export async function loadPlanningInputs(db: Executor, companyId: string): Promise<PlanningInputs> {
  const catalogue = await db
    .select({ id: items.id, sku: items.sku, name: items.name, kind: items.kind, uom: uoms.code, decimals: uoms.decimals })
    .from(items)
    .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
    .where(eq(items.companyId, companyId));
  const activeBoms = await db
    .select({ id: boms.id, itemId: boms.itemId, outputQty: boms.outputQty })
    .from(boms)
    .where(and(eq(boms.companyId, companyId), eq(boms.isActive, true)));
  const lines = await db.select().from(bomLines).where(eq(bomLines.companyId, companyId));
  const planBoms = new Map<string, PlanBom>();
  for (const bom of activeBoms) {
    planBoms.set(bom.itemId, {
      outputQty: bom.outputQty,
      lines: lines
        .filter((l) => l.bomId === bom.id)
        .map((l) => ({ componentId: l.componentItemId, qty: l.qty, scrapPct: l.scrapPct })),
    });
  }
  const onHand = new Map<string, Big>();
  for (const [itemId, stock] of await onHandByItem(db, companyId)) onHand.set(itemId, stock.qty);
  return {
    catalogue,
    bySku: new Map(catalogue.map((i) => [i.sku, i])),
    byId: new Map(catalogue.map((i) => [i.id, i])),
    planBoms,
    onHand,
    incoming: await openIncoming(db, companyId),
  };
}

/**
 * What to buy to meet the demands: demands x active BOMs, minus stock on hand and incoming
 * (see `planShortages` for the exact rules and limits).
 */
export async function calculateShortages(db: Executor, rawInput: ShortageInput): Promise<ShortageRow[]> {
  const input = ShortageInput.parse(rawInput);
  const { bySku, byId, planBoms, onHand, incoming } = await loadPlanningInputs(db, input.companyId);
  const itemOf = (sku: string) => {
    const item = bySku.get(sku);
    if (!item) throw new DomainError("UNKNOWN_ITEM", `Item "${sku}" does not exist`);
    return item;
  };

  const demands = input.demands.map((d) => {
    const item = itemOf(d.sku);
    financialYearOf(d.needBy); // validates the date
    return { itemId: item.id, qty: assertQty(d.qty, item.decimals, `Demand for ${d.sku}`), needBy: d.needBy };
  });

  const available = new Map(onHand);
  for (const inc of input.incoming) {
    const item = itemOf(inc.sku);
    available.set(item.id, (available.get(item.id) ?? new Big(0)).plus(assertQty(inc.qty, item.decimals, `Incoming ${inc.sku}`)));
  }

  return planShortages({
    demands,
    boms: planBoms,
    available,
    incoming: input.includePurchaseOrders ? incoming : [],
    decimalsOf: (itemId) => byId.get(itemId)?.decimals ?? 3,
  }).map((s) => {
    const item = byId.get(s.itemId) as NonNullable<ReturnType<typeof byId.get>>;
    return { sku: item.sku, name: item.name, uom: item.uom, qtyToBuy: s.qty, firstNeededBy: s.firstNeededBy };
  }).sort((a, b) => a.firstNeededBy.localeCompare(b.firstNeededBy) || a.sku.localeCompare(b.sku));
}
