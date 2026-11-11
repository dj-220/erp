import Big from "big.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor, Transactor } from "../db/client";
import { items, locations, parties, stockDocuments, stockMoves, uoms, warehouses } from "../db/schema";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import { lineAmount } from "../domain/money";
import type { DocType } from "../domain/numbering";
import { assertQty, averageCost, decimalPlaces, outboundValue, parseDecimal } from "../domain/stock";
import { recordAudit } from "./audit";
import { allocateDocNumber } from "./numbering";
import { balanceAt, onHandByItem } from "./stock-queries";
import { one } from "./util";

type StockDocType = "goods_receipt" | "delivery" | "transfer" | "adjustment";
type Location = typeof locations.$inferSelect;

const NUMBER_TYPE: Record<StockDocType, DocType> = {
  goods_receipt: "goods_receipt",
  delivery: "delivery",
  transfer: "stock_transfer",
  adjustment: "stock_adjustment",
};

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const LineInput = z.object({
  sku: z.string().trim().min(1),
  qty: decimal,
  /** Rupees per unit. Required on goods receipts; optional on stock increases; not allowed elsewhere. */
  unitCost: decimal.optional(),
  /** Location names. Defaults depend on the document type; see `routeLine`. */
  fromLocation: z.string().trim().min(1).optional(),
  toLocation: z.string().trim().min(1).optional(),
  /** Adjustments only. */
  direction: z.enum(["increase", "decrease"]).optional(),
  /** Deliveries only: the sales order line this serves. */
  salesOrderLineId: z.uuid().optional(),
  /** Goods receipts only: the purchase order line this serves. */
  purchaseOrderLineId: z.uuid().optional(),
});

export const CreateStockDocumentInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  docType: z.enum(["goods_receipt", "delivery", "transfer", "adjustment"]),
  docDate: dateString,
  /** Supplier for a receipt, customer for a delivery. */
  partyId: z.uuid().optional(),
  /** Deliveries only: the sales order being delivered against. */
  salesOrderId: z.uuid().optional(),
  /** Goods receipts only: the purchase order being received against. */
  purchaseOrderId: z.uuid().optional(),
  reference: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  /** Warehouse whose main stock location is the default. Defaults to "MAIN". */
  warehouseCode: z.string().trim().min(1).default("MAIN"),
  lines: z.array(LineInput).min(1, "A stock document needs at least one line"),
});
export type CreateStockDocumentInput = z.input<typeof CreateStockDocumentInput>;

interface Context {
  itemBySku: Map<string, typeof items.$inferSelect & { decimals: number }>;
  locByName: Map<string, Location>;
  defaultInternal: Location;
  supplier: Location;
  customer: Location;
  adjustment: Location;
}

async function loadContext(
  db: Executor,
  companyId: string,
  skus: readonly string[],
  warehouseCode: string,
): Promise<Context> {
  const itemRows = await db
    .select({ item: items, decimals: uoms.decimals })
    .from(items)
    .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
    .where(and(eq(items.companyId, companyId), inArray(items.sku, [...skus])));
  const locs = await db.select().from(locations).where(eq(locations.companyId, companyId));
  const warehouse = (
    await db.select().from(warehouses).where(and(eq(warehouses.companyId, companyId), eq(warehouses.code, warehouseCode)))
  )[0];
  if (!warehouse) throw new DomainError("UNKNOWN_WAREHOUSE", `Warehouse "${warehouseCode}" does not exist`);

  const firstOfKind = (kind: Location["kind"]) => {
    const loc = locs.find((l) => l.kind === kind && l.isActive);
    if (!loc) throw new DomainError("MISSING_LOCATION", `This company has no active "${kind}" location`);
    return loc;
  };
  const defaultInternal = locs.find((l) => l.warehouseId === warehouse.id && l.isPrimary && l.isActive);
  if (!defaultInternal) {
    throw new DomainError(
      "MISSING_LOCATION",
      `Warehouse "${warehouseCode}" has no primary stock location; name a location on each line or set one as primary`,
    );
  }
  return {
    itemBySku: new Map(itemRows.map((r) => [r.item.sku, { ...r.item, decimals: r.decimals }])),
    locByName: new Map(locs.map((l) => [l.name, l])),
    defaultInternal,
    supplier: firstOfKind("supplier"),
    customer: firstOfKind("customer"),
    adjustment: firstOfKind("adjustment"),
  };
}

/** Work out the from/to locations of one line from the document type. */
function routeLine(docType: StockDocType, line: z.infer<typeof LineInput>, ctx: Context): { from: Location; to: Location } {
  const internal = (name: string | undefined, fallback?: Location): Location => {
    if (name === undefined) {
      if (fallback) return fallback;
      throw new DomainError("LOCATION_REQUIRED", `A location is required for ${line.sku}`);
    }
    const loc = ctx.locByName.get(name);
    if (!loc) throw new DomainError("UNKNOWN_LOCATION", `Location "${name}" does not exist`);
    if (loc.kind !== "internal") throw new DomainError("NOT_INTERNAL_LOCATION", `"${name}" is not a stock location`);
    return loc;
  };

  switch (docType) {
    case "goods_receipt":
      return { from: ctx.supplier, to: internal(line.toLocation, ctx.defaultInternal) };
    case "delivery":
      return { from: internal(line.fromLocation, ctx.defaultInternal), to: ctx.customer };
    case "transfer": {
      const from = internal(line.fromLocation);
      const to = internal(line.toLocation);
      if (from.id === to.id) throw new DomainError("SAME_LOCATION", "A transfer needs two different locations");
      return { from, to };
    }
    case "adjustment": {
      if (!line.direction) throw new DomainError("DIRECTION_REQUIRED", `Say whether ${line.sku} is an increase or a decrease`);
      const place = internal(line.toLocation ?? line.fromLocation, ctx.defaultInternal);
      return line.direction === "increase" ? { from: ctx.adjustment, to: place } : { from: place, to: ctx.adjustment };
    }
  }
}

/** Save a draft stock document. Nothing moves until it is posted. */
export async function createStockDocument(db: Transactor, rawInput: CreateStockDocumentInput) {
  const input = CreateStockDocumentInput.parse(rawInput);
  financialYearOf(input.docDate); // validates the calendar date

  return db.transaction(async (tx) => {
    const ctx = await loadContext(tx, input.companyId, input.lines.map((l) => l.sku), input.warehouseCode);

    if (input.partyId) {
      const party = (
        await tx.select().from(parties).where(and(eq(parties.companyId, input.companyId), eq(parties.id, input.partyId)))
      )[0];
      if (!party) throw new DomainError("UNKNOWN_PARTY", "That party does not exist in this company");
      const wanted = input.docType === "goods_receipt" ? "supplier" : input.docType === "delivery" ? "customer" : null;
      if (wanted && party.kind !== wanted && party.kind !== "both") {
        throw new DomainError("WRONG_PARTY_KIND", `A ${input.docType.replace("_", " ")} needs a ${wanted}, but ${party.name} is a ${party.kind}`);
      }
    }

    const prepared = input.lines.map((line, index) => {
      const item = ctx.itemBySku.get(line.sku);
      if (!item) throw new DomainError("UNKNOWN_ITEM", `Item "${line.sku}" does not exist`);
      if (item.kind === "service") throw new DomainError("NOT_STOCKED", `${line.sku} is a service and has no stock`);
      if (!item.isActive) throw new DomainError("INACTIVE_ITEM", `${line.sku} is inactive`);
      if (item.trackBatch) {
        throw new DomainError("BATCH_NOT_SUPPORTED", `${line.sku} is batch-tracked; batch tracking is not available yet`);
      }
      const qty = assertQty(line.qty, item.decimals, `Quantity for ${line.sku}`);
      const { from, to } = routeLine(input.docType, line, ctx);

      const takesCost = input.docType === "goods_receipt" || (input.docType === "adjustment" && line.direction === "increase");
      if (line.unitCost !== undefined && !takesCost) {
        throw new DomainError("COST_NOT_ALLOWED", `${line.sku}: stock leaving or moving is valued automatically; remove the unit cost`);
      }
      if (input.docType === "goods_receipt" && line.unitCost === undefined) {
        throw new DomainError("COST_REQUIRED", `${line.sku}: a goods receipt needs the unit cost`);
      }
      if (line.unitCost !== undefined && parseDecimal(line.unitCost, "Unit cost").lt(0)) {
        throw new DomainError("INVALID_COST", `${line.sku}: unit cost cannot be negative`);
      }
      return {
        companyId: input.companyId,
        lineNo: index + 1,
        itemId: item.id,
        fromLocationId: from.id,
        toLocationId: to.id,
        qty: qty.toString(),
        unitCost: line.unitCost ?? null,
        salesOrderLineId: line.salesOrderLineId ?? null,
        purchaseOrderLineId: line.purchaseOrderLineId ?? null,
      };
    });

    const doc = one(
      await tx
        .insert(stockDocuments)
        .values({
          companyId: input.companyId,
          docType: input.docType,
          docDate: input.docDate,
          partyId: input.partyId ?? null,
          salesOrderId: input.salesOrderId ?? null,
          purchaseOrderId: input.purchaseOrderId ?? null,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          createdBy: input.actorUserId ?? null,
        })
        .returning(),
      "stock document",
    );
    const moves = await tx
      .insert(stockMoves)
      .values(prepared.map((p) => ({ ...p, documentId: doc.id })))
      .returning();
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "stock_document.created",
      entityType: "stock_document",
      entityId: doc.id,
      after: { docType: doc.docType, docDate: doc.docDate, lines: moves.length },
    });
    return { ...doc, moves };
  });
}

/**
 * Post a draft: check availability, value every move, take the document number and make the
 * moves part of the ledger. All or nothing: if any line fails, nothing is posted and no
 * number is used. Stock postings of one company run one at a time, so two users cannot both
 * spend the same stock.
 */
export async function postStockDocument(
  db: Transactor,
  args: { companyId: string; documentId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const company = one(
      await tx.execute(sql`SELECT allow_negative_stock FROM companies WHERE id = ${args.companyId} FOR UPDATE`)
        .then((r) => r.rows as { allow_negative_stock: boolean }[]),
      "company",
    );
    const allowNegative = company.allow_negative_stock;

    const doc = (
      await tx
        .select()
        .from(stockDocuments)
        .where(and(eq(stockDocuments.companyId, args.companyId), eq(stockDocuments.id, args.documentId)))
    )[0];
    if (!doc) throw new DomainError("UNKNOWN_DOCUMENT", "That stock document does not exist");
    if (doc.state !== "draft") throw new DomainError("NOT_DRAFT", `This document is already ${doc.state}`);

    const moves = await tx
      .select()
      .from(stockMoves)
      .where(and(eq(stockMoves.companyId, args.companyId), eq(stockMoves.documentId, doc.id)))
      .orderBy(asc(stockMoves.lineNo));
    if (moves.length === 0) throw new DomainError("EMPTY_DOCUMENT", "A stock document needs at least one line");

    const locById = new Map(
      (await tx.select().from(locations).where(eq(locations.companyId, args.companyId))).map((l) => [l.id, l]),
    );
    const itemById = new Map(
      (await tx.select().from(items).where(eq(items.companyId, args.companyId))).map((i) => [i.id, i]),
    );

    let totalValue = 0;
    for (const move of moves) {
      const item = itemById.get(move.itemId) as typeof items.$inferSelect;
      const from = locById.get(move.fromLocationId) as Location;
      const to = locById.get(move.toLocationId) as Location;
      const qty = new Big(move.qty);
      const leavesStock = from.kind === "internal";
      const entersStock = to.kind === "internal";
      if (!leavesStock && !entersStock) {
        throw new DomainError("NO_INTERNAL_LOCATION", `${item.sku}: a move must start or end at a stock location`);
      }

      if (leavesStock && !allowNegative) {
        const available = await balanceAt(tx, args.companyId, item.id, from.id);
        if (available.lt(qty)) {
          throw new DomainError(
            "INSUFFICIENT_STOCK",
            `${item.sku}: only ${available.toFixed(3)} at ${from.name}, ${qty.toFixed(3)} needed`,
          );
        }
      }

      const onHand = (await onHandByItem(tx, args.companyId, [item.id])).get(item.id) ?? { qty: new Big(0), valuePaise: 0 };
      let value: number;
      if (!leavesStock) {
        // Stock coming in from outside: the stated cost, else the current average, else the item's purchase price.
        const rate = move.unitCost ?? averageCost(onHand.qty, onHand.valuePaise) ?? item.purchasePrice;
        if (rate === null) {
          throw new DomainError("COST_REQUIRED", `${item.sku}: no cost is known for this stock; give a unit cost or set a purchase price`);
        }
        value = lineAmount(qty, rate);
      } else {
        value = outboundValue({
          qty,
          onHandQty: onHand.qty,
          onHandValue: onHand.valuePaise,
          fallbackRate: item.purchasePrice ?? undefined,
        });
      }
      await tx.update(stockMoves).set({ state: "done", valuePaise: value }).where(eq(stockMoves.id, move.id));
      if (!leavesStock || !entersStock) totalValue += value;
    }

    const number = await allocateDocNumber(tx, {
      companyId: args.companyId,
      docType: NUMBER_TYPE[doc.docType],
      date: doc.docDate,
    });
    const posted = one(
      await tx
        .update(stockDocuments)
        .set({ state: "done", number, postedAt: new Date() })
        .where(eq(stockDocuments.id, doc.id))
        .returning(),
      "posted document",
    );
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "stock_document.posted",
      entityType: "stock_document",
      entityId: doc.id,
      before: { state: "draft" },
      after: { state: "done", number, docType: doc.docType, lines: moves.length, valueChangePaise: totalValue },
    });
    return posted;
  });
}

/** Discard a draft. A posted document cannot be cancelled; correct it with a new document. */
export async function cancelStockDocument(
  db: Transactor,
  args: { companyId: string; documentId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const doc = (
      await tx
        .select()
        .from(stockDocuments)
        .where(and(eq(stockDocuments.companyId, args.companyId), eq(stockDocuments.id, args.documentId)))
    )[0];
    if (!doc) throw new DomainError("UNKNOWN_DOCUMENT", "That stock document does not exist");
    if (doc.state !== "draft") throw new DomainError("NOT_DRAFT", `This document is already ${doc.state}`);
    await tx.update(stockMoves).set({ state: "cancelled" }).where(eq(stockMoves.documentId, doc.id));
    const cancelled = one(
      await tx.update(stockDocuments).set({ state: "cancelled" }).where(eq(stockDocuments.id, doc.id)).returning(),
      "cancelled document",
    );
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "stock_document.cancelled",
      entityType: "stock_document",
      entityId: doc.id,
      before: { state: "draft" },
      after: { state: "cancelled" },
    });
    return cancelled;
  });
}

/** A document with its lines, using SKUs and location names instead of ids. */
export async function getStockDocument(db: Executor, args: { companyId: string; documentId: string }) {
  const doc = (
    await db
      .select()
      .from(stockDocuments)
      .where(and(eq(stockDocuments.companyId, args.companyId), eq(stockDocuments.id, args.documentId)))
  )[0];
  if (!doc) throw new DomainError("UNKNOWN_DOCUMENT", "That stock document does not exist");
  const moves = await db
    .select()
    .from(stockMoves)
    .where(and(eq(stockMoves.companyId, args.companyId), eq(stockMoves.documentId, doc.id)))
    .orderBy(asc(stockMoves.lineNo));
  const locs = new Map((await db.select().from(locations).where(eq(locations.companyId, args.companyId))).map((l) => [l.id, l.name]));
  const skus = new Map((await db.select().from(items).where(eq(items.companyId, args.companyId))).map((i) => [i.id, i.sku]));
  return {
    ...doc,
    lines: moves.map((m) => ({
      lineNo: m.lineNo,
      sku: skus.get(m.itemId) as string,
      from: locs.get(m.fromLocationId) as string,
      to: locs.get(m.toLocationId) as string,
      qty: m.qty,
      unitCost: m.unitCost,
      valuePaise: m.valuePaise,
      state: m.state,
    })),
  };
}

/**
 * Turn a physical count into an adjustment draft: for each counted item, the difference between
 * what was counted and what the books say at that location. Items that already agree are left out.
 */
export async function createStockCount(
  db: Db,
  args: {
    companyId: string;
    actorUserId?: string;
    docDate: string;
    /** Stock location counted; defaults to the main warehouse's stock location. */
    location?: string;
    reference?: string;
    counts: { sku: string; countedQty: string | number; unitCost?: string | number }[];
  },
) {
  const ctx = await loadContext(db, args.companyId, args.counts.map((c) => c.sku), "MAIN");
  const place = args.location ? ctx.locByName.get(args.location) : ctx.defaultInternal;
  if (!place) throw new DomainError("UNKNOWN_LOCATION", `Location "${args.location}" does not exist`);
  if (place.kind !== "internal") throw new DomainError("NOT_INTERNAL_LOCATION", `"${place.name}" is not a stock location`);

  const lines: z.input<typeof LineInput>[] = [];
  for (const count of args.counts) {
    const item = ctx.itemBySku.get(count.sku);
    if (!item) throw new DomainError("UNKNOWN_ITEM", `Item "${count.sku}" does not exist`);
    const counted = parseDecimal(count.countedQty, `Count for ${count.sku}`);
    if (counted.lt(0)) throw new DomainError("INVALID_QTY", `Count for ${count.sku} cannot be negative`);
    if (decimalPlaces(counted) > item.decimals) {
      throw new DomainError("QTY_PRECISION", `Count for ${count.sku} has too many decimal places for its unit`);
    }
    const delta = counted.minus(await balanceAt(db, args.companyId, item.id, place.id));
    if (delta.eq(0)) continue;
    lines.push({
      sku: count.sku,
      qty: delta.abs().toString(),
      direction: delta.gt(0) ? "increase" : "decrease",
      toLocation: place.name,
      ...(delta.gt(0) && count.unitCost !== undefined ? { unitCost: count.unitCost.toString() } : {}),
    });
  }
  if (lines.length === 0) throw new DomainError("NOTHING_TO_ADJUST", "The count matches the books; nothing to adjust");

  return createStockDocument(db, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    docType: "adjustment",
    docDate: args.docDate,
    reference: args.reference ?? "Stock count",
    lines,
  });
}
