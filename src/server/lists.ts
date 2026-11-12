import Big from "big.js";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import {
  auditLog,
  items,
  locations,
  parties,
  payments,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequestLines,
  purchaseRequests,
  salesInvoices,
  salesOrderLines,
  salesOrders,
  stockDocuments,
  stockMoves,
  uoms,
  users,
  warehouses,
} from "../db/schema";
import { lineTaxableValue } from "../domain/sales";
import { receivedByLine } from "./purchase-queries";
import { loadInvoiceBalances } from "./ledger-queries";

export interface Page {
  /** How many rows to return (1 to 200, default 50). */
  limit?: number;
  offset?: number;
}
export interface Paged<T> {
  rows: T[];
  total: number;
}

const clamp = (page: Page) => ({ limit: Math.min(Math.max(page.limit ?? 50, 1), 200), offset: Math.max(page.offset ?? 0, 0) });
/** Escape LIKE wildcards so a search for "50%" finds "50%", not everything. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listParties(
  db: Executor,
  args: { companyId: string; kind?: "customer" | "supplier"; q?: string } & Page,
): Promise<Paged<typeof parties.$inferSelect>> {
  const { limit, offset } = clamp(args);
  const where = and(
    eq(parties.companyId, args.companyId),
    args.kind === "customer" ? inArray(parties.kind, ["customer", "both"]) : args.kind === "supplier" ? inArray(parties.kind, ["supplier", "both"]) : undefined,
    args.q ? or(ilike(parties.name, like(args.q)), ilike(parties.gstin, like(args.q))) : undefined,
  );
  const rows = await db.select().from(parties).where(where).orderBy(asc(parties.name), asc(parties.id)).limit(limit).offset(offset);
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(parties).where(where))[0]?.n ?? 0);
  return { rows, total };
}

export async function listItems(db: Executor, args: { companyId: string; q?: string } & Page) {
  const { limit, offset } = clamp(args);
  const where = and(
    eq(items.companyId, args.companyId),
    args.q ? or(ilike(items.name, like(args.q)), ilike(items.sku, like(args.q))) : undefined,
  );
  const rows = await db
    .select({ item: items, uom: uoms.code })
    .from(items)
    .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
    .where(where)
    .orderBy(asc(items.sku), asc(items.id))
    .limit(limit)
    .offset(offset);
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(items).where(where))[0]?.n ?? 0);
  return { rows: rows.map((r) => ({ ...r.item, uom: r.uom })), total } satisfies Paged<unknown>;
}

export async function listUoms(db: Executor, companyId: string) {
  return db.select().from(uoms).where(eq(uoms.companyId, companyId)).orderBy(asc(uoms.code));
}

export async function listWarehouses(db: Executor, companyId: string) {
  const whs = await db.select().from(warehouses).where(eq(warehouses.companyId, companyId)).orderBy(asc(warehouses.code));
  const locs = await db.select().from(locations).where(eq(locations.companyId, companyId)).orderBy(asc(locations.name));
  return whs.map((w) => ({ ...w, locations: locs.filter((l) => l.warehouseId === w.id) }));
}

/** Active BOMs with their components, by finished item. */
export async function listBoms(db: Executor, companyId: string) {
  const rows = await db.execute(sql`
    SELECT b.id AS bom_id, fi.sku AS sku, fi.name AS name, b.version AS version, b.output_qty::text AS output_qty,
           ci.sku AS component_sku, ci.name AS component_name, l.qty::text AS qty, l.scrap_pct::text AS scrap_pct
    FROM boms b
    JOIN items fi ON fi.company_id = b.company_id AND fi.id = b.item_id
    JOIN bom_lines l ON l.company_id = b.company_id AND l.bom_id = b.id
    JOIN items ci ON ci.company_id = b.company_id AND ci.id = l.component_item_id
    WHERE b.company_id = ${companyId} AND b.is_active
    ORDER BY fi.sku, ci.sku`);
  const out = new Map<string, { sku: string; name: string; version: number; outputQty: string; components: { sku: string; name: string; qty: string; scrapPct: string }[] }>();
  for (const r of rows.rows as Record<string, string>[]) {
    const key = r.bom_id as string;
    if (!out.has(key)) out.set(key, { sku: r.sku as string, name: r.name as string, version: Number(r.version), outputQty: r.output_qty as string, components: [] });
    out.get(key)?.components.push({ sku: r.component_sku as string, name: r.component_name as string, qty: r.qty as string, scrapPct: r.scrap_pct as string });
  }
  return [...out.values()];
}

export async function listSalesOrders(db: Executor, args: { companyId: string; state?: "draft" | "confirmed" | "closed" | "cancelled"; q?: string } & Page) {
  const { limit, offset } = clamp(args);
  const where = and(
    eq(salesOrders.companyId, args.companyId),
    args.state ? eq(salesOrders.state, args.state) : undefined,
    args.q ? or(ilike(salesOrders.number, like(args.q)), ilike(parties.name, like(args.q))) : undefined,
  );
  const base = db
    .select({ order: salesOrders, customerName: parties.name })
    .from(salesOrders)
    .innerJoin(parties, and(eq(parties.companyId, salesOrders.companyId), eq(parties.id, salesOrders.customerId)))
    .where(where);
  const rows = await base.orderBy(desc(salesOrders.createdAt), desc(salesOrders.id)).limit(limit).offset(offset);
  const total = Number(
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(salesOrders)
        .innerJoin(parties, and(eq(parties.companyId, salesOrders.companyId), eq(parties.id, salesOrders.customerId)))
        .where(where)
    )[0]?.n ?? 0,
  );
  const lines = rows.length
    ? await db.select().from(salesOrderLines).where(and(eq(salesOrderLines.companyId, args.companyId), inArray(salesOrderLines.orderId, rows.map((r) => r.order.id))))
    : [];
  return {
    total,
    rows: rows.map(({ order, customerName }) => {
      const own = lines.filter((l) => l.orderId === order.id);
      return {
        id: order.id,
        number: order.number,
        state: order.state,
        customerId: order.customerId,
        customerName,
        orderDate: order.orderDate,
        promisedDate: order.promisedDate,
        customerPoRef: order.customerPoRef,
        lineCount: own.length,
        taxableValuePaise: own.reduce((s, l) => s + lineTaxableValue({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct }), 0),
      };
    }),
  };
}

export async function listSalesInvoices(
  db: Executor,
  args: { companyId: string; kind?: "tax_invoice" | "credit_note" | "debit_note"; state?: "draft" | "posted" | "cancelled"; customerId?: string; q?: string } & Page,
) {
  const { limit, offset } = clamp(args);
  const where = and(
    eq(salesInvoices.companyId, args.companyId),
    args.kind ? eq(salesInvoices.kind, args.kind) : undefined,
    args.state ? eq(salesInvoices.state, args.state) : undefined,
    args.customerId ? eq(salesInvoices.customerId, args.customerId) : undefined,
    args.q ? or(ilike(salesInvoices.number, like(args.q)), ilike(salesInvoices.customerName, like(args.q))) : undefined,
  );
  const rows = await db.select().from(salesInvoices).where(where).orderBy(desc(salesInvoices.invoiceDate), desc(salesInvoices.createdAt), desc(salesInvoices.id)).limit(limit).offset(offset);
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(salesInvoices).where(where))[0]?.n ?? 0);
  const open = new Map((await loadInvoiceBalances(db, args.companyId, rows.filter((r) => r.state === "posted" && r.kind !== "credit_note").map((r) => r.id))).map((d) => [d.docId, d.outstandingPaise]));
  return {
    total,
    rows: rows.map((i) => ({
      id: i.id,
      kind: i.kind,
      number: i.number,
      state: i.state,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      customerName: i.customerName,
      customerGstin: i.customerGstin,
      supplyKind: i.supplyKind,
      taxableValuePaise: i.taxableValuePaise,
      totalPaise: i.totalPaise,
      outstandingPaise: open.get(i.id) ?? null,
    })),
  };
}

export async function listPurchaseOrders(
  db: Executor,
  args: { companyId: string; state?: typeof purchaseOrders.$inferSelect["state"]; q?: string } & Page,
) {
  const { limit, offset } = clamp(args);
  const where = and(
    eq(purchaseOrders.companyId, args.companyId),
    args.state ? eq(purchaseOrders.state, args.state) : undefined,
    args.q ? or(ilike(purchaseOrders.number, like(args.q)), ilike(purchaseOrders.supplierName, like(args.q))) : undefined,
  );
  const rows = await db.select().from(purchaseOrders).where(where).orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id)).limit(limit).offset(offset);
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(purchaseOrders).where(where))[0]?.n ?? 0);
  const lines = rows.length
    ? await db.select().from(purchaseOrderLines).where(and(eq(purchaseOrderLines.companyId, args.companyId), inArray(purchaseOrderLines.orderId, rows.map((r) => r.id))))
    : [];
  const received = await receivedByLine(db, args.companyId, lines.map((l) => l.id));
  return {
    total,
    rows: rows.map((o) => {
      const own = lines.filter((l) => l.orderId === o.id);
      const ordered = own.reduce((s, l) => s.plus(l.qty), new Big(0));
      const got = own.reduce((s, l) => s.plus(received.get(l.id) ?? 0), new Big(0));
      return {
        id: o.id,
        number: o.number,
        state: o.state,
        supplierId: o.supplierId,
        supplierName: o.supplierName,
        orderDate: o.orderDate,
        expectedDate: o.expectedDate,
        taxableValuePaise: o.taxableValuePaise,
        totalPaise: o.totalPaise,
        lineCount: own.length,
        receivedPercent: ordered.gt(0) ? Math.min(100, Math.round(got.div(ordered).times(100).toNumber())) : 0,
      };
    }),
  };
}

export async function listPurchaseRequests(
  db: Executor,
  args: { companyId: string; state?: typeof purchaseRequests.$inferSelect["state"] } & Page,
) {
  const { limit, offset } = clamp(args);
  const where = and(eq(purchaseRequests.companyId, args.companyId), args.state ? eq(purchaseRequests.state, args.state) : undefined);
  const rows = await db
    .select({ r: purchaseRequests, by: users.name })
    .from(purchaseRequests)
    .innerJoin(users, eq(users.id, purchaseRequests.requestedBy))
    .where(where)
    .orderBy(desc(purchaseRequests.createdAt), desc(purchaseRequests.id))
    .limit(limit)
    .offset(offset);
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(purchaseRequests).where(where))[0]?.n ?? 0);
  const lines = rows.length
    ? await db.select({ requestId: purchaseRequestLines.requestId }).from(purchaseRequestLines).where(and(eq(purchaseRequestLines.companyId, args.companyId), inArray(purchaseRequestLines.requestId, rows.map((r) => r.r.id))))
    : [];
  return {
    total,
    rows: rows.map(({ r, by }) => ({
      id: r.id,
      number: r.number,
      state: r.state,
      requestDate: r.requestDate,
      neededBy: r.neededBy,
      requestedByName: by,
      lineCount: lines.filter((l) => l.requestId === r.id).length,
    })),
  };
}

export async function listStockDocuments(
  db: Executor,
  args: { companyId: string; docType?: typeof stockDocuments.$inferSelect["docType"]; state?: typeof stockDocuments.$inferSelect["state"] } & Page,
) {
  const { limit, offset } = clamp(args);
  const where = and(
    eq(stockDocuments.companyId, args.companyId),
    args.docType ? eq(stockDocuments.docType, args.docType) : undefined,
    args.state ? eq(stockDocuments.state, args.state) : undefined,
  );
  const rows = await db
    .select({ d: stockDocuments, party: parties.name })
    .from(stockDocuments)
    .leftJoin(parties, and(eq(parties.companyId, stockDocuments.companyId), eq(parties.id, stockDocuments.partyId)))
    .where(where)
    .orderBy(desc(stockDocuments.docDate), desc(stockDocuments.createdAt), desc(stockDocuments.id))
    .limit(limit)
    .offset(offset);
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(stockDocuments).where(where))[0]?.n ?? 0);
  const moves = rows.length
    ? await db
        .select({ documentId: stockMoves.documentId, valuePaise: stockMoves.valuePaise })
        .from(stockMoves)
        .where(and(eq(stockMoves.companyId, args.companyId), inArray(stockMoves.documentId, rows.map((r) => r.d.id))))
    : [];
  return {
    total,
    rows: rows.map(({ d, party }) => {
      const own = moves.filter((m) => m.documentId === d.id);
      return {
        id: d.id,
        number: d.number,
        docType: d.docType,
        state: d.state,
        docDate: d.docDate,
        partyName: party,
        reference: d.reference,
        lineCount: own.length,
        valuePaise: d.state === "done" ? own.reduce((s, m) => s + (m.valuePaise ?? 0), 0) : null,
      };
    }),
  };
}

export async function listPayments(
  db: Executor,
  args: { companyId: string; direction?: "paid" | "received"; partyId?: string } & Page,
) {
  const { limit, offset } = clamp(args);
  const where = and(
    eq(payments.companyId, args.companyId),
    args.direction ? eq(payments.direction, args.direction) : undefined,
    args.partyId ? eq(payments.partyId, args.partyId) : undefined,
  );
  const rows = await db
    .select({ p: payments, party: parties.name })
    .from(payments)
    .innerJoin(parties, and(eq(parties.companyId, payments.companyId), eq(parties.id, payments.partyId)))
    .where(where)
    .orderBy(desc(payments.paymentDate), desc(payments.createdAt), desc(payments.id))
    .limit(limit)
    .offset(offset);
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(payments).where(where))[0]?.n ?? 0);
  const allocated = new Map<string, number>();
  if (rows.length > 0) {
    const { rows: sums } = await db.execute(sql`
      SELECT payment_id, sum(amount_paise)::text AS total FROM payment_allocations
      WHERE company_id = ${args.companyId} AND payment_id IN (${sql.join(rows.map((r) => sql`${r.p.id}`), sql`, `)})
      GROUP BY payment_id`);
    for (const s of sums as { payment_id: string; total: string }[]) allocated.set(s.payment_id, Number(s.total));
  }
  return {
    total,
    rows: rows.map(({ p, party }) => ({
      id: p.id,
      number: p.number,
      direction: p.direction,
      partyId: p.partyId,
      partyName: party,
      paymentDate: p.paymentDate,
      amountPaise: p.amountPaise,
      mode: p.mode,
      reference: p.reference,
      state: p.state,
      allocatedPaise: allocated.get(p.id) ?? 0,
    })),
  };
}

/** The audit trail, newest first, with the names of the people who did things. */
export async function listAudit(db: Executor, args: { companyId: string; entityType?: string; entityId?: string } & Page) {
  const { limit, offset } = clamp(args);
  const where = and(
    eq(auditLog.companyId, args.companyId),
    args.entityType ? eq(auditLog.entityType, args.entityType) : undefined,
    args.entityId ? eq(auditLog.entityId, args.entityId) : undefined,
  );
  const rows = await db
    .select({ a: auditLog, actor: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(where)
    .orderBy(desc(auditLog.id))
    .limit(limit)
    .offset(offset);
  const total = Number((await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(where))[0]?.n ?? 0);
  return {
    total,
    rows: rows.map(({ a, actor }) => ({
      id: a.id,
      at: a.occurredAt,
      actorName: actor,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      before: a.before,
      after: a.after,
    })),
  };
}
