import Big from "big.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Transactor, Tx } from "../db/client";
import { items, parties, salesInvoiceLines, salesOrderLines, salesOrders, uoms } from "../db/schema";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import { isAllowedGstRate } from "../domain/gst";
import { assertQty, parseDecimal } from "../domain/stock";
import { recordAudit } from "./audit";
import { createStockDocument, getStockDocument, postStockDocument } from "./inventory";
import { allocateDocNumber } from "./numbering";
import { deliveredByLine } from "./sales-queries";
import { one } from "./util";

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Customers we cannot invoice correctly yet: supplies to SEZ units and exports have special tax treatment. */
const UNSUPPORTED_REGISTRATIONS = new Set(["sez", "overseas"]);

export const CreateSalesOrderInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  customerId: z.uuid(),
  orderDate: dateString,
  /** The date the customer was promised delivery. */
  promisedDate: dateString,
  /** State the goods go to. Defaults to the customer's state. */
  shipToStateCode: z.string().length(2).optional(),
  customerPoRef: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        qty: decimal,
        /** Rupees per unit. Defaults to the item's sales price. */
        unitPrice: decimal.optional(),
        discountPct: decimal.default("0"),
        /** GST rate in percent. Defaults to the item's rate. */
        gstRate: decimal.optional(),
        description: z.string().trim().min(1).optional(),
      }),
    )
    .min(1, "An order needs at least one line"),
});
export type CreateSalesOrderInput = z.input<typeof CreateSalesOrderInput>;

/** Lock the order row so concurrent confirm / deliver / invoice calls on it run one at a time. */
async function lockOrder(tx: Tx, companyId: string, orderId: string) {
  await tx.execute(sql`SELECT 1 FROM sales_orders WHERE company_id = ${companyId} AND id = ${orderId} FOR UPDATE`);
  const order = (
    await tx.select().from(salesOrders).where(and(eq(salesOrders.companyId, companyId), eq(salesOrders.id, orderId)))
  )[0];
  if (!order) throw new DomainError("UNKNOWN_ORDER", "That sales order does not exist");
  return order;
}

/** Save a draft sales order. */
export async function createSalesOrder(db: Transactor, rawInput: CreateSalesOrderInput) {
  const input = CreateSalesOrderInput.parse(rawInput);
  financialYearOf(input.orderDate);
  financialYearOf(input.promisedDate);
  if (input.promisedDate < input.orderDate) {
    throw new DomainError("PROMISE_BEFORE_ORDER", "The promised date cannot be before the order date");
  }

  return db.transaction(async (tx) => {
    const customer = (
      await tx.select().from(parties).where(and(eq(parties.companyId, input.companyId), eq(parties.id, input.customerId)))
    )[0];
    if (!customer) throw new DomainError("UNKNOWN_PARTY", "That customer does not exist in this company");
    if (customer.kind === "supplier") {
      throw new DomainError("WRONG_PARTY_KIND", `${customer.name} is a supplier, not a customer`);
    }
    if (!customer.isActive) throw new DomainError("INACTIVE_PARTY", `${customer.name} is inactive`);
    if (UNSUPPORTED_REGISTRATIONS.has(customer.registrationType)) {
      throw new DomainError(
        "UNSUPPORTED_REGISTRATION",
        `${customer.name} is a ${customer.registrationType} customer; SEZ supplies and exports are not supported yet`,
      );
    }
    const shipTo = input.shipToStateCode ?? customer.stateCode;

    const skus = [...new Set(input.lines.map((l) => l.sku))];
    const found = await tx
      .select({ item: items, decimals: uoms.decimals })
      .from(items)
      .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
      .where(and(eq(items.companyId, input.companyId), inArray(items.sku, skus)));
    const bySku = new Map(found.map((r) => [r.item.sku, r]));

    const prepared = input.lines.map((line, index) => {
      const row = bySku.get(line.sku);
      if (!row) throw new DomainError("UNKNOWN_ITEM", `Item "${line.sku}" does not exist`);
      const { item, decimals } = row;
      if (!item.isActive) throw new DomainError("INACTIVE_ITEM", `${line.sku} is inactive`);
      const qty = assertQty(line.qty, decimals, `Quantity for ${line.sku}`);

      const unitPrice = line.unitPrice ?? item.salesPrice;
      if (unitPrice === null || unitPrice === undefined) {
        throw new DomainError("PRICE_REQUIRED", `${line.sku}: give a unit price, or set a sales price on the item`);
      }
      if (parseDecimal(unitPrice, `Price for ${line.sku}`).lt(0)) {
        throw new DomainError("INVALID_PRICE", `${line.sku}: the price cannot be negative`);
      }
      const discount = parseDecimal(line.discountPct, `Discount for ${line.sku}`);
      if (discount.lt(0) || discount.gt(100)) {
        throw new DomainError("INVALID_DISCOUNT", `${line.sku}: discount must be between 0 and 100 percent`);
      }
      const gstRate = line.gstRate ?? item.gstRate;
      if (!isAllowedGstRate(gstRate)) {
        throw new DomainError("INVALID_GST_RATE", `${line.sku}: ${gstRate}% is not a current GST rate slab`);
      }
      return {
        companyId: input.companyId,
        lineNo: index + 1,
        itemId: item.id,
        description: line.description ?? null,
        hsnSac: item.hsnSac,
        qty: qty.toString(),
        unitPrice: String(unitPrice),
        discountPct: discount.toString(),
        gstRate: new Big(gstRate).toFixed(2),
      };
    });

    const order = one(
      await tx
        .insert(salesOrders)
        .values({
          companyId: input.companyId,
          orderDate: input.orderDate,
          promisedDate: input.promisedDate,
          customerId: customer.id,
          customerPoRef: input.customerPoRef ?? null,
          shipToStateCode: shipTo,
          notes: input.notes ?? null,
          createdBy: input.actorUserId ?? null,
        })
        .returning(),
      "sales order",
    );
    const lines = await tx
      .insert(salesOrderLines)
      .values(prepared.map((p) => ({ ...p, orderId: order.id })))
      .returning();
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "sales_order.created",
      entityType: "sales_order",
      entityId: order.id,
      after: { customer: customer.name, lines: lines.length, promisedDate: order.promisedDate },
    });
    return { ...order, lines };
  });
}

/** Confirm a draft: it gets its order number and its terms are frozen. */
export async function confirmSalesOrder(
  db: Transactor,
  args: { companyId: string; orderId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, args.companyId, args.orderId);
    if (order.state !== "draft") throw new DomainError("NOT_DRAFT", `This order is already ${order.state}`);
    const number = await allocateDocNumber(tx, { companyId: args.companyId, docType: "sales_order", date: order.orderDate });
    const confirmed = one(
      await tx
        .update(salesOrders)
        .set({ state: "confirmed", number, confirmedAt: new Date() })
        .where(eq(salesOrders.id, order.id))
        .returning(),
      "confirmed order",
    );
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "sales_order.confirmed",
      entityType: "sales_order",
      entityId: order.id,
      before: { state: "draft" },
      after: { state: "confirmed", number },
    });
    return confirmed;
  });
}

/** Cancel an order. Once goods have gone out or an invoice exists, close it instead. */
export async function cancelSalesOrder(
  db: Transactor,
  args: { companyId: string; orderId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, args.companyId, args.orderId);
    if (order.state === "closed" || order.state === "cancelled") {
      throw new DomainError("NOT_CANCELLABLE", `This order is already ${order.state}`);
    }
    if (order.state === "confirmed") {
      const lines = await tx.select({ id: salesOrderLines.id }).from(salesOrderLines).where(eq(salesOrderLines.orderId, order.id));
      const ids = lines.map((l) => l.id);
      const delivered = await deliveredByLine(tx, args.companyId, ids);
      const invoiced =
        ids.length === 0
          ? []
          : await tx
              .select({ id: salesInvoiceLines.id })
              .from(salesInvoiceLines)
              .where(and(eq(salesInvoiceLines.companyId, args.companyId), inArray(salesInvoiceLines.salesOrderLineId, ids)))
              .limit(1);
      if (delivered.size > 0 || invoiced.length > 0) {
        throw new DomainError("HAS_ACTIVITY", "Goods were delivered or an invoice exists for this order; close it instead of cancelling");
      }
    }
    const cancelled = one(
      await tx.update(salesOrders).set({ state: "cancelled" }).where(eq(salesOrders.id, order.id)).returning(),
      "cancelled order",
    );
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "sales_order.cancelled",
      entityType: "sales_order",
      entityId: order.id,
      before: { state: order.state },
      after: { state: "cancelled" },
    });
    return cancelled;
  });
}

/** Short-close a confirmed order: nothing more will be delivered against it. */
export async function closeSalesOrder(
  db: Transactor,
  args: { companyId: string; orderId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, args.companyId, args.orderId);
    if (order.state !== "confirmed") throw new DomainError("NOT_CONFIRMED", `Only a confirmed order can be closed; this one is ${order.state}`);
    const closed = one(
      await tx.update(salesOrders).set({ state: "closed" }).where(eq(salesOrders.id, order.id)).returning(),
      "closed order",
    );
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "sales_order.closed",
      entityType: "sales_order",
      entityId: order.id,
      before: { state: "confirmed" },
      after: { state: "closed" },
    });
    return closed;
  });
}

/**
 * Ship goods against a confirmed order: creates and posts a stock delivery, so stock falls and
 * the order's delivered quantities rise. All or nothing: if any line is short of stock, nothing
 * is delivered. Omit `lines` to deliver everything still owed.
 */
export async function deliverSalesOrder(
  db: Transactor,
  args: {
    companyId: string;
    orderId: string;
    docDate: string;
    actorUserId?: string;
    lines?: { lineNo: number; qty: string | number }[];
    /** Stock location to ship from; defaults to the warehouse's primary location. */
    fromLocation?: string;
  },
) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, args.companyId, args.orderId);
    if (order.state !== "confirmed") {
      throw new DomainError("NOT_CONFIRMED", `Goods can only be delivered against a confirmed order; this one is ${order.state}`);
    }
    if (args.docDate < order.orderDate) {
      throw new DomainError("DELIVERY_BEFORE_ORDER", "A delivery cannot be dated before the order");
    }
    const rows = await tx
      .select({ line: salesOrderLines, item: items, decimals: uoms.decimals })
      .from(salesOrderLines)
      .innerJoin(items, and(eq(items.companyId, salesOrderLines.companyId), eq(items.id, salesOrderLines.itemId)))
      .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
      .where(and(eq(salesOrderLines.companyId, args.companyId), eq(salesOrderLines.orderId, order.id)));
    const delivered = await deliveredByLine(tx, args.companyId, rows.map((r) => r.line.id));
    const owed = (r: (typeof rows)[number]) => new Big(r.line.qty).minus(delivered.get(r.line.id) ?? 0);

    const wanted: { row: (typeof rows)[number]; qty: Big }[] = [];
    if (args.lines) {
      for (const want of args.lines) {
        const row = rows.find((r) => r.line.lineNo === want.lineNo);
        if (!row) throw new DomainError("UNKNOWN_LINE", `The order has no line ${want.lineNo}`);
        if (row.item.kind === "service") throw new DomainError("SERVICE_LINE", `Line ${want.lineNo} is a service; there is nothing to deliver`);
        const qty = assertQty(want.qty, row.decimals, `Quantity for line ${want.lineNo}`);
        if (qty.gt(owed(row))) {
          throw new DomainError("OVER_DELIVERY", `Line ${want.lineNo}: only ${owed(row).toFixed(3)} still to deliver, ${qty.toFixed(3)} requested`);
        }
        wanted.push({ row, qty });
      }
    } else {
      for (const row of rows.sort((a, b) => a.line.lineNo - b.line.lineNo)) {
        if (row.item.kind !== "service" && owed(row).gt(0)) wanted.push({ row, qty: owed(row) });
      }
    }
    if (wanted.length === 0) throw new DomainError("NOTHING_TO_DELIVER", "Nothing is left to deliver on this order");
    if (new Set(wanted.map((w) => w.row.line.id)).size !== wanted.length) {
      throw new DomainError("DUPLICATE_LINE", "A line appears more than once");
    }

    const draft = await createStockDocument(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      docType: "delivery",
      docDate: args.docDate,
      partyId: order.customerId,
      salesOrderId: order.id,
      reference: `Order ${order.number}`,
      lines: wanted.map((w) => ({
        sku: w.row.item.sku,
        qty: w.qty.toString(),
        salesOrderLineId: w.row.line.id,
        ...(args.fromLocation ? { fromLocation: args.fromLocation } : {}),
      })),
    });
    await postStockDocument(tx, { companyId: args.companyId, documentId: draft.id, actorUserId: args.actorUserId });
    return getStockDocument(tx, { companyId: args.companyId, documentId: draft.id });
  });
}
