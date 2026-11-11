import Big from "big.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Transactor, Tx } from "../db/client";
import { items, parties, purchaseRequestLines, purchaseRequests, uoms } from "../db/schema";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import { openQty } from "../domain/purchasing";
import { assertQty } from "../domain/stock";
import { recordAudit } from "./audit";
import { requireMember } from "./members";
import { allocateDocNumber } from "./numbering";
import { orderedByRequestLine } from "./purchase-queries";
import { type ShortageInput, calculateShortages, getReorderSuggestions } from "./stock-queries";
import { one } from "./util";

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const CreatePurchaseRequestInput = z.object({
  companyId: z.uuid(),
  /** Who is asking; must belong to the company. */
  actorUserId: z.uuid(),
  requestDate: dateString,
  neededBy: dateString,
  notes: z.string().trim().min(1).optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        qty: decimal,
        preferredSupplierId: z.uuid().optional(),
        note: z.string().trim().min(1).optional(),
      }),
    )
    .min(1, "A request needs at least one line"),
});
export type CreatePurchaseRequestInput = z.input<typeof CreatePurchaseRequestInput>;

async function lockRequest(tx: Tx, companyId: string, requestId: string) {
  await tx.execute(sql`SELECT 1 FROM purchase_requests WHERE company_id = ${companyId} AND id = ${requestId} FOR UPDATE`);
  const request = (
    await tx.select().from(purchaseRequests).where(and(eq(purchaseRequests.companyId, companyId), eq(purchaseRequests.id, requestId)))
  )[0];
  if (!request) throw new DomainError("UNKNOWN_REQUEST", "That purchase request does not exist");
  return request;
}

/** Save a draft purchase request. */
export async function createPurchaseRequest(db: Transactor, rawInput: CreatePurchaseRequestInput) {
  const input = CreatePurchaseRequestInput.parse(rawInput);
  financialYearOf(input.requestDate);
  financialYearOf(input.neededBy);
  if (input.neededBy < input.requestDate) {
    throw new DomainError("NEEDED_BEFORE_REQUEST", "The needed-by date cannot be before the request date");
  }

  return db.transaction(async (tx) => {
    await requireMember(tx, input.companyId, input.actorUserId);
    const skus = [...new Set(input.lines.map((l) => l.sku))];
    const found = await tx
      .select({ item: items, decimals: uoms.decimals })
      .from(items)
      .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
      .where(and(eq(items.companyId, input.companyId), inArray(items.sku, skus)));
    const bySku = new Map(found.map((r) => [r.item.sku, r]));

    const supplierIds = [...new Set(input.lines.map((l) => l.preferredSupplierId).filter((id): id is string => id !== undefined))];
    if (supplierIds.length > 0) {
      const suppliers = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.companyId, input.companyId), inArray(parties.id, supplierIds)));
      for (const id of supplierIds) {
        const party = suppliers.find((p) => p.id === id);
        if (!party) throw new DomainError("UNKNOWN_PARTY", "A preferred supplier does not exist in this company");
        if (party.kind === "customer") throw new DomainError("WRONG_PARTY_KIND", `${party.name} is a customer, not a supplier`);
      }
    }

    const prepared = input.lines.map((line, index) => {
      const row = bySku.get(line.sku);
      if (!row) throw new DomainError("UNKNOWN_ITEM", `Item "${line.sku}" does not exist`);
      if (row.item.kind === "service") {
        throw new DomainError("NOT_STOCKED", `${line.sku} is a service; purchase requests are for stocked goods for now`);
      }
      if (!row.item.isActive) throw new DomainError("INACTIVE_ITEM", `${line.sku} is inactive`);
      return {
        companyId: input.companyId,
        lineNo: index + 1,
        itemId: row.item.id,
        qty: assertQty(line.qty, row.decimals, `Quantity for ${line.sku}`).toString(),
        preferredSupplierId: line.preferredSupplierId ?? null,
        note: line.note ?? null,
      };
    });

    const request = one(
      await tx
        .insert(purchaseRequests)
        .values({
          companyId: input.companyId,
          requestDate: input.requestDate,
          neededBy: input.neededBy,
          requestedBy: input.actorUserId,
          notes: input.notes ?? null,
        })
        .returning(),
      "purchase request",
    );
    await tx.insert(purchaseRequestLines).values(prepared.map((p) => ({ ...p, requestId: request.id })));
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "purchase_request.created",
      entityType: "purchase_request",
      entityId: request.id,
      after: { lines: prepared.length, neededBy: request.neededBy },
    });
    return getPurchaseRequest(tx, { companyId: input.companyId, requestId: request.id });
  });
}

/** Submit a draft: it takes its number and can now be ordered against. */
export async function submitPurchaseRequest(
  db: Transactor,
  args: { companyId: string; requestId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, args.companyId, args.requestId);
    if (request.state !== "draft") throw new DomainError("NOT_DRAFT", `This request is already ${request.state}`);
    const number = await allocateDocNumber(tx, { companyId: args.companyId, docType: "purchase_request", date: request.requestDate });
    await tx
      .update(purchaseRequests)
      .set({ state: "submitted", number, submittedAt: new Date() })
      .where(eq(purchaseRequests.id, request.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_request.submitted",
      entityType: "purchase_request",
      entityId: request.id,
      before: { state: "draft" },
      after: { state: "submitted", number },
    });
    return getPurchaseRequest(tx, { companyId: args.companyId, requestId: request.id });
  });
}

/** Cancel a request. Once orders exist against it, close it instead. */
export async function cancelPurchaseRequest(
  db: Transactor,
  args: { companyId: string; requestId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, args.companyId, args.requestId);
    if (request.state === "closed" || request.state === "cancelled") {
      throw new DomainError("NOT_CANCELLABLE", `This request is already ${request.state}`);
    }
    if (request.state === "submitted") {
      const ids = (await tx.select({ id: purchaseRequestLines.id }).from(purchaseRequestLines).where(eq(purchaseRequestLines.requestId, request.id))).map((l) => l.id);
      if ((await orderedByRequestLine(tx, args.companyId, ids)).size > 0) {
        throw new DomainError("HAS_ORDERS", "Purchase orders exist against this request; close it instead of cancelling");
      }
    }
    await tx.update(purchaseRequests).set({ state: "cancelled" }).where(eq(purchaseRequests.id, request.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_request.cancelled",
      entityType: "purchase_request",
      entityId: request.id,
      before: { state: request.state },
      after: { state: "cancelled" },
    });
    return getPurchaseRequest(tx, { companyId: args.companyId, requestId: request.id });
  });
}

/** Close a submitted request: nothing more will be ordered against it. */
export async function closePurchaseRequest(
  db: Transactor,
  args: { companyId: string; requestId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, args.companyId, args.requestId);
    if (request.state !== "submitted") {
      throw new DomainError("NOT_SUBMITTED", `Only a submitted request can be closed; this one is ${request.state}`);
    }
    await tx.update(purchaseRequests).set({ state: "closed" }).where(eq(purchaseRequests.id, request.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_request.closed",
      entityType: "purchase_request",
      entityId: request.id,
      before: { state: "submitted" },
      after: { state: "closed" },
    });
    return getPurchaseRequest(tx, { companyId: args.companyId, requestId: request.id });
  });
}

/** A request with its lines and how much of each has been put on order so far. */
export async function getPurchaseRequest(db: Executor, args: { companyId: string; requestId: string }) {
  const request = (
    await db.select().from(purchaseRequests).where(and(eq(purchaseRequests.companyId, args.companyId), eq(purchaseRequests.id, args.requestId)))
  )[0];
  if (!request) throw new DomainError("UNKNOWN_REQUEST", "That purchase request does not exist");
  const rows = await db
    .select({ line: purchaseRequestLines, sku: items.sku, name: items.name, uom: uoms.code })
    .from(purchaseRequestLines)
    .innerJoin(items, and(eq(items.companyId, purchaseRequestLines.companyId), eq(items.id, purchaseRequestLines.itemId)))
    .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
    .where(and(eq(purchaseRequestLines.companyId, args.companyId), eq(purchaseRequestLines.requestId, request.id)))
    .orderBy(asc(purchaseRequestLines.lineNo));
  const ordered = await orderedByRequestLine(db, args.companyId, rows.map((r) => r.line.id));
  return {
    ...request,
    lines: rows.map(({ line, sku, name, uom }) => {
      const done = ordered.get(line.id) ?? new Big(0);
      return {
        ...line,
        sku,
        name,
        uom,
        qty: new Big(line.qty).toFixed(3),
        ordered: done.toFixed(3),
        stillToOrder: openQty(line.qty, done).toFixed(3),
      };
    }),
  };
}

/**
 * Draft a purchase request for what the demands are short of (see `calculateShortages`; stock
 * already on approved orders and arriving in time is not asked for again). Needed-by defaults to
 * the earliest date any shortage is needed.
 */
export async function createRequestFromShortages(
  db: Transactor & Executor,
  args: { companyId: string; actorUserId: string; requestDate: string; neededBy?: string; demands: ShortageInput["demands"]; notes?: string },
) {
  const shortages = await calculateShortages(db, { companyId: args.companyId, demands: args.demands });
  const first = shortages[0];
  if (!first) throw new DomainError("NOTHING_SHORT", "Stock and orders already cover these demands");
  return createPurchaseRequest(db, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    requestDate: args.requestDate,
    neededBy: args.neededBy ?? first.firstNeededBy,
    notes: args.notes ?? "Raised from a shortage calculation",
    lines: shortages.map((s) => ({ sku: s.sku, qty: s.qtyToBuy })),
  });
}

/** Draft a purchase request for every item at or below its reorder level. */
export async function createRequestFromReorder(
  db: Transactor & Executor,
  args: { companyId: string; actorUserId: string; requestDate: string; neededBy: string; notes?: string },
) {
  const suggestions = await getReorderSuggestions(db, { companyId: args.companyId });
  if (suggestions.length === 0) throw new DomainError("NOTHING_TO_REORDER", "No item is at or below its reorder level");
  return createPurchaseRequest(db, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    requestDate: args.requestDate,
    neededBy: args.neededBy,
    notes: args.notes ?? "Raised from reorder levels",
    lines: suggestions.map((s) => ({ sku: s.sku, qty: s.suggestedQty })),
  });
}
