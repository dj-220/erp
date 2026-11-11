import Big from "big.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Transactor, Tx } from "../db/client";
import {
  approvalRequests,
  items,
  parties,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequestLines,
  purchaseRequests,
  uoms,
  warehouses,
} from "../db/schema";
import { planApproval } from "../domain/approval";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import { type TaxInput, computeInvoiceTax, isAllowedGstRate } from "../domain/gst";
import { type PurchaseOrderState, assertPoTransition, canReceive, openQty, purchaseTaxRate, unitCostAfterDiscount } from "../domain/purchasing";
import { lineTaxableValue } from "../domain/sales";
import { assertQty, parseDecimal } from "../domain/stock";
import { recordAudit } from "./audit";
import { createStockDocument, getStockDocument, postStockDocument } from "./inventory";
import { loadMembers, requireMember } from "./members";
import { allocateDocNumber } from "./numbering";
import { orderedByRequestLine, receivedByLine } from "./purchase-queries";
import { one } from "./util";

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const CreatePurchaseOrderInput = z.object({
  companyId: z.uuid(),
  /** Who is raising the order; must belong to the company. */
  actorUserId: z.uuid(),
  supplierId: z.uuid(),
  orderDate: dateString,
  /** The date the supplier has promised delivery. */
  expectedDate: dateString,
  /** Warehouse the goods go to; its state is the place of supply. Defaults to "MAIN". */
  warehouseCode: z.string().trim().min(1).default("MAIN"),
  supplierRef: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        qty: decimal,
        /** Rupees per unit. Defaults to the item's purchase price. */
        unitPrice: decimal.optional(),
        discountPct: decimal.default("0"),
        /** GST rate in percent as the supplier charges it. Defaults to the item's rate. */
        gstRate: decimal.optional(),
        description: z.string().trim().min(1).optional(),
        /** The purchase request line this fulfils. */
        requestLineId: z.uuid().optional(),
      }),
    )
    .min(1, "An order needs at least one line"),
});
export type CreatePurchaseOrderInput = z.input<typeof CreatePurchaseOrderInput>;

/** Lock the order row so approve / receive / cancel on it run one at a time. */
export async function lockPurchaseOrder(tx: Tx, companyId: string, orderId: string) {
  await tx.execute(sql`SELECT 1 FROM purchase_orders WHERE company_id = ${companyId} AND id = ${orderId} FOR UPDATE`);
  const order = (
    await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.id, orderId)))
  )[0];
  if (!order) throw new DomainError("UNKNOWN_ORDER", "That purchase order does not exist");
  return order;
}

/** Save a draft purchase order, with tax worked out from the supplier's state and the delivery state. */
export async function createPurchaseOrder(db: Transactor, rawInput: CreatePurchaseOrderInput) {
  const input = CreatePurchaseOrderInput.parse(rawInput);
  financialYearOf(input.orderDate);
  financialYearOf(input.expectedDate);
  if (input.expectedDate < input.orderDate) {
    throw new DomainError("EXPECTED_BEFORE_ORDER", "The expected delivery date cannot be before the order date");
  }

  return db.transaction(async (tx) => {
    await requireMember(tx, input.companyId, input.actorUserId);
    const supplier = (
      await tx.select().from(parties).where(and(eq(parties.companyId, input.companyId), eq(parties.id, input.supplierId)))
    )[0];
    if (!supplier) throw new DomainError("UNKNOWN_PARTY", "That supplier does not exist in this company");
    if (supplier.kind === "customer") throw new DomainError("WRONG_PARTY_KIND", `${supplier.name} is a customer, not a supplier`);
    if (!supplier.isActive) throw new DomainError("INACTIVE_PARTY", `${supplier.name} is inactive`);
    const warehouse = (
      await tx
        .select()
        .from(warehouses)
        .where(and(eq(warehouses.companyId, input.companyId), eq(warehouses.code, input.warehouseCode)))
    )[0];
    if (!warehouse) throw new DomainError("UNKNOWN_WAREHOUSE", `Warehouse "${input.warehouseCode}" does not exist`);

    const skus = [...new Set(input.lines.map((l) => l.sku))];
    const found = await tx
      .select({ item: items, decimals: uoms.decimals })
      .from(items)
      .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
      .where(and(eq(items.companyId, input.companyId), inArray(items.sku, skus)));
    const bySku = new Map(found.map((r) => [r.item.sku, r]));

    const requestLineIds = input.lines.map((l) => l.requestLineId).filter((id): id is string => id !== undefined);
    const requestLines =
      requestLineIds.length === 0
        ? []
        : await tx
            .select({ line: purchaseRequestLines, state: purchaseRequests.state })
            .from(purchaseRequestLines)
            .innerJoin(
              purchaseRequests,
              and(eq(purchaseRequests.companyId, purchaseRequestLines.companyId), eq(purchaseRequests.id, purchaseRequestLines.requestId)),
            )
            .where(and(eq(purchaseRequestLines.companyId, input.companyId), inArray(purchaseRequestLines.id, requestLineIds)));
    const alreadyOrdered = await orderedByRequestLine(tx, input.companyId, requestLineIds);
    const planned = new Map<string, Big>(); // ordered so far within this very order

    const prepared = input.lines.map((line) => {
      const row = bySku.get(line.sku);
      if (!row) throw new DomainError("UNKNOWN_ITEM", `Item "${line.sku}" does not exist`);
      const { item, decimals } = row;
      if (!item.isActive) throw new DomainError("INACTIVE_ITEM", `${line.sku} is inactive`);
      if (item.kind === "service") {
        throw new DomainError("NOT_STOCKED", `${line.sku} is a service; purchase orders are for stocked goods for now`);
      }
      const qty = assertQty(line.qty, decimals, `Quantity for ${line.sku}`);

      const price = line.unitPrice ?? item.purchasePrice;
      if (price === null || price === undefined) {
        throw new DomainError("PRICE_REQUIRED", `${line.sku}: give a unit price, or set a purchase price on the item`);
      }
      if (parseDecimal(price, `Price for ${line.sku}`).lt(0)) {
        throw new DomainError("INVALID_PRICE", `${line.sku}: the price cannot be negative`);
      }
      const discount = parseDecimal(line.discountPct, `Discount for ${line.sku}`);
      if (discount.lt(0) || discount.gt(100)) {
        throw new DomainError("INVALID_DISCOUNT", `${line.sku}: discount must be between 0 and 100 percent`);
      }
      const charged = line.gstRate ?? item.gstRate;
      if (!isAllowedGstRate(charged)) {
        throw new DomainError("INVALID_GST_RATE", `${line.sku}: ${charged}% is not a current GST rate slab`);
      }
      const gstRate = purchaseTaxRate(supplier.registrationType, charged);

      if (line.requestLineId) {
        const request = requestLines.find((r) => r.line.id === line.requestLineId);
        if (!request) throw new DomainError("UNKNOWN_REQUEST_LINE", "That purchase request line does not exist");
        if (request.state !== "submitted") {
          throw new DomainError("REQUEST_NOT_OPEN", `The purchase request is ${request.state}; only a submitted request can be ordered against`);
        }
        if (request.line.itemId !== item.id) {
          throw new DomainError("REQUEST_ITEM_MISMATCH", `The request line is for a different item than ${line.sku}`);
        }
        const used = (alreadyOrdered.get(request.line.id) ?? new Big(0)).plus(planned.get(request.line.id) ?? 0).plus(qty);
        if (used.gt(request.line.qty)) {
          throw new DomainError("OVER_REQUESTED", `${line.sku}: the request was for ${new Big(request.line.qty).toFixed(3)} and ordering this would make ${used.toFixed(3)}`);
        }
        planned.set(request.line.id, (planned.get(request.line.id) ?? new Big(0)).plus(qty));
      }
      return {
        item,
        description: line.description ?? null,
        qty: qty.toString(),
        unitPrice: String(price),
        discountPct: discount.toString(),
        gstRate: new Big(gstRate).toFixed(2),
        taxable: lineTaxableValue({ qty, unitPrice: price, discountPct: discount }),
        requestLineId: line.requestLineId ?? null,
      };
    });

    const taxInputs: TaxInput[] = prepared.map((p) => ({
      taxableValue: p.taxable,
      ratePercent: p.gstRate,
      supplierState: supplier.stateCode,
      placeOfSupply: warehouse.stateCode,
    }));
    const tax = computeInvoiceTax(taxInputs);

    const order = one(
      await tx
        .insert(purchaseOrders)
        .values({
          companyId: input.companyId,
          orderDate: input.orderDate,
          expectedDate: input.expectedDate,
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          supplierRef: input.supplierRef ?? null,
          notes: input.notes ?? null,
          supplierName: supplier.legalName ?? supplier.name,
          supplierGstin: supplier.gstin,
          supplierStateCode: supplier.stateCode,
          placeOfSupplyStateCode: warehouse.stateCode,
          supplyKind: tax.lines[0]?.kind ?? "intra",
          taxableValuePaise: tax.taxableValue,
          cgstPaise: tax.cgst,
          sgstPaise: tax.sgst,
          utgstPaise: tax.utgst,
          igstPaise: tax.igst,
          cessPaise: tax.cess,
          roundOffPaise: tax.roundOff,
          totalPaise: tax.total,
          createdBy: input.actorUserId,
        })
        .returning(),
      "purchase order",
    );
    await tx.insert(purchaseOrderLines).values(
      prepared.map((p, i) => {
        const t = tax.lines[i];
        if (!t) throw new Error("tax lines out of step with order lines");
        return {
          companyId: input.companyId,
          orderId: order.id,
          lineNo: i + 1,
          itemId: p.item.id,
          description: p.description,
          hsnSac: p.item.hsnSac,
          qty: p.qty,
          unitPrice: p.unitPrice,
          discountPct: p.discountPct,
          gstRate: p.gstRate,
          taxableValuePaise: p.taxable,
          cgstPaise: t.cgst,
          sgstPaise: t.sgst,
          utgstPaise: t.utgst,
          igstPaise: t.igst,
          cessPaise: t.cess,
          purchaseRequestLineId: p.requestLineId,
        };
      }),
    );
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "purchase_order.created",
      entityType: "purchase_order",
      entityId: order.id,
      after: { supplier: order.supplierName, lines: prepared.length, totalPaise: tax.total },
    });
    return getPurchaseOrder(tx, { companyId: input.companyId, orderId: order.id });
  });
}

/**
 * Send a draft for approval. It takes its order number now. Within the submitter's own approval
 * limit it is approved on the spot (and recorded as such); otherwise it waits for the next person
 * up the chain whose limit covers the order's total including GST.
 */
export async function submitPurchaseOrder(
  db: Transactor,
  args: { companyId: string; orderId: string; actorUserId: string },
) {
  return db.transaction(async (tx) => {
    const order = await lockPurchaseOrder(tx, args.companyId, args.orderId);
    if (order.state !== "draft") throw new DomainError("NOT_DRAFT", `This order is already ${order.state}`);

    const members = await loadMembers(tx, args.companyId);
    const requester = members.find((m) => m.userId === args.actorUserId);
    if (!requester) throw new DomainError("NOT_A_MEMBER", "That user does not belong to this company");
    const plan = planApproval({ amountPaise: order.totalPaise, requester, members });

    const number = await allocateDocNumber(tx, { companyId: args.companyId, docType: "purchase_order", date: order.orderDate });
    const now = new Date();
    const next: PurchaseOrderState = plan.auto ? "approved" : "pending_approval";
    assertPoTransition("draft", next);
    await tx
      .update(purchaseOrders)
      .set({ state: next, number, submittedAt: now, ...(plan.auto ? { approvedAt: now } : {}) })
      .where(eq(purchaseOrders.id, order.id));
    await tx.insert(approvalRequests).values({
      companyId: args.companyId,
      docType: "purchase_order",
      docId: order.id,
      amountPaise: order.totalPaise,
      requestedBy: args.actorUserId,
      ...(plan.auto
        ? { state: "approved" as const, decidedBy: args.actorUserId, decidedAt: now, isAuto: true, comment: "Within the requester's own approval limit" }
        : { assignedTo: plan.assignee.userId }),
    });
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: plan.auto ? "purchase_order.approved_automatically" : "purchase_order.submitted",
      entityType: "purchase_order",
      entityId: order.id,
      before: { state: "draft" },
      after: { state: next, number, amountPaise: order.totalPaise, ...(plan.auto ? {} : { waitingOn: plan.assignee.userId }) },
    });
    return getPurchaseOrder(tx, { companyId: args.companyId, orderId: order.id });
  });
}

/** Tell the supplier: marks an approved order as sent. */
export async function markPurchaseOrderSent(
  db: Transactor,
  args: { companyId: string; orderId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const order = await lockPurchaseOrder(tx, args.companyId, args.orderId);
    assertPoTransition(order.state, "sent");
    await tx.update(purchaseOrders).set({ state: "sent", sentAt: new Date() }).where(eq(purchaseOrders.id, order.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_order.sent",
      entityType: "purchase_order",
      entityId: order.id,
      before: { state: order.state },
      after: { state: "sent" },
    });
    return getPurchaseOrder(tx, { companyId: args.companyId, orderId: order.id });
  });
}

/** Cancel an order. Once goods have been received, close it instead. */
export async function cancelPurchaseOrder(
  db: Transactor,
  args: { companyId: string; orderId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const order = await lockPurchaseOrder(tx, args.companyId, args.orderId);
    assertPoTransition(order.state, "cancelled");
    const lineIds = (await tx.select({ id: purchaseOrderLines.id }).from(purchaseOrderLines).where(eq(purchaseOrderLines.orderId, order.id))).map((l) => l.id);
    if ((await receivedByLine(tx, args.companyId, lineIds)).size > 0) {
      throw new DomainError("HAS_RECEIPTS", "Goods were received against this order; close it instead of cancelling");
    }
    if (order.state === "pending_approval") {
      await tx
        .update(approvalRequests)
        .set({ state: "cancelled" })
        .where(and(eq(approvalRequests.companyId, args.companyId), eq(approvalRequests.docId, order.id), eq(approvalRequests.state, "pending")));
    }
    await tx.update(purchaseOrders).set({ state: "cancelled" }).where(eq(purchaseOrders.id, order.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_order.cancelled",
      entityType: "purchase_order",
      entityId: order.id,
      before: { state: order.state },
      after: { state: "cancelled" },
    });
    return getPurchaseOrder(tx, { companyId: args.companyId, orderId: order.id });
  });
}

/** Short-close: nothing more will be received against this order. */
export async function closePurchaseOrder(
  db: Transactor,
  args: { companyId: string; orderId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const order = await lockPurchaseOrder(tx, args.companyId, args.orderId);
    assertPoTransition(order.state, "closed");
    await tx.update(purchaseOrders).set({ state: "closed" }).where(eq(purchaseOrders.id, order.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_order.closed",
      entityType: "purchase_order",
      entityId: order.id,
      before: { state: order.state },
      after: { state: "closed" },
    });
    return getPurchaseOrder(tx, { companyId: args.companyId, orderId: order.id });
  });
}

/**
 * Receive goods against an approved or sent order: creates and posts a goods receipt, valued at
 * the order's price after discount (GST is claimed back, so it is not part of stock cost). Omit
 * `lines` to receive everything still outstanding. You cannot receive more than was ordered.
 */
export async function receivePurchaseOrder(
  db: Transactor,
  args: {
    companyId: string;
    orderId: string;
    docDate: string;
    actorUserId?: string;
    lines?: { lineNo: number; qty: string | number }[];
    /** The supplier's delivery challan or invoice number. */
    supplierChallanRef?: string;
    /** Stock location to put the goods in; defaults to the warehouse's primary location. */
    toLocation?: string;
  },
) {
  return db.transaction(async (tx) => {
    const order = await lockPurchaseOrder(tx, args.companyId, args.orderId);
    if (!canReceive(order.state)) {
      throw new DomainError("NOT_RECEIVABLE", `Goods can only be received against an approved or sent order; this one is ${order.state}`);
    }
    if (args.docDate < order.orderDate) {
      throw new DomainError("RECEIPT_BEFORE_ORDER", "A receipt cannot be dated before the order");
    }
    const rows = await tx
      .select({ line: purchaseOrderLines, item: items, decimals: uoms.decimals })
      .from(purchaseOrderLines)
      .innerJoin(items, and(eq(items.companyId, purchaseOrderLines.companyId), eq(items.id, purchaseOrderLines.itemId)))
      .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
      .where(and(eq(purchaseOrderLines.companyId, args.companyId), eq(purchaseOrderLines.orderId, order.id)))
      .orderBy(asc(purchaseOrderLines.lineNo));
    const received = await receivedByLine(tx, args.companyId, rows.map((r) => r.line.id));
    const open = (r: (typeof rows)[number]) => openQty(r.line.qty, received.get(r.line.id) ?? 0);

    const chosen: { row: (typeof rows)[number]; qty: Big }[] = [];
    if (args.lines) {
      for (const want of args.lines) {
        const row = rows.find((r) => r.line.lineNo === want.lineNo);
        if (!row) throw new DomainError("UNKNOWN_LINE", `The order has no line ${want.lineNo}`);
        const qty = assertQty(want.qty, row.decimals, `Quantity for line ${want.lineNo}`);
        if (qty.gt(open(row))) {
          throw new DomainError("OVER_RECEIPT", `Line ${want.lineNo}: only ${open(row).toFixed(3)} still expected, ${qty.toFixed(3)} received`);
        }
        chosen.push({ row, qty });
      }
    } else {
      for (const row of rows) if (open(row).gt(0)) chosen.push({ row, qty: open(row) });
    }
    if (chosen.length === 0) throw new DomainError("NOTHING_TO_RECEIVE", "Everything on this order has already been received");
    if (new Set(chosen.map((c) => c.row.line.id)).size !== chosen.length) {
      throw new DomainError("DUPLICATE_LINE", "A line appears more than once");
    }

    // Goods go into the warehouse the order was placed for, not always the main one.
    const warehouse = one(
      await tx.select().from(warehouses).where(and(eq(warehouses.companyId, args.companyId), eq(warehouses.id, order.warehouseId))),
      "warehouse",
    );
    const draft = await createStockDocument(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      docType: "goods_receipt",
      docDate: args.docDate,
      warehouseCode: warehouse.code,
      partyId: order.supplierId,
      purchaseOrderId: order.id,
      reference: args.supplierChallanRef ? `Order ${order.number} / ${args.supplierChallanRef}` : `Order ${order.number}`,
      lines: chosen.map((c) => ({
        sku: c.row.item.sku,
        qty: c.qty.toString(),
        unitCost: unitCostAfterDiscount(c.row.line.unitPrice, c.row.line.discountPct).toString(),
        purchaseOrderLineId: c.row.line.id,
        ...(args.toLocation ? { toLocation: args.toLocation } : {}),
      })),
    });
    await postStockDocument(tx, { companyId: args.companyId, documentId: draft.id, actorUserId: args.actorUserId });
    return getStockDocument(tx, { companyId: args.companyId, documentId: draft.id });
  });
}

/** An order with its lines (ordered, received, still open) and its latest approval request. */
export async function getPurchaseOrder(db: Executor, args: { companyId: string; orderId: string }) {
  const order = (
    await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, args.companyId), eq(purchaseOrders.id, args.orderId)))
  )[0];
  if (!order) throw new DomainError("UNKNOWN_ORDER", "That purchase order does not exist");
  const rows = await db
    .select({ line: purchaseOrderLines, sku: items.sku, name: items.name, uom: uoms.code })
    .from(purchaseOrderLines)
    .innerJoin(items, and(eq(items.companyId, purchaseOrderLines.companyId), eq(items.id, purchaseOrderLines.itemId)))
    .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
    .where(and(eq(purchaseOrderLines.companyId, args.companyId), eq(purchaseOrderLines.orderId, order.id)))
    .orderBy(asc(purchaseOrderLines.lineNo));
  const received = await receivedByLine(db, args.companyId, rows.map((r) => r.line.id));
  const approval =
    (
      await db
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.companyId, args.companyId), eq(approvalRequests.docType, "purchase_order"), eq(approvalRequests.docId, order.id)))
        .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
        .limit(1)
    )[0] ?? null;
  return {
    ...order,
    approval,
    lines: rows.map(({ line, sku, name, uom }) => {
      const got = received.get(line.id) ?? new Big(0);
      return {
        ...line,
        sku,
        name,
        uom,
        received: got.toFixed(3),
        open: openQty(line.qty, got).toFixed(3),
        totalPaise: line.taxableValuePaise + line.cgstPaise + line.sgstPaise + line.utgstPaise + line.igstPaise + line.cessPaise,
      };
    }),
  };
}
