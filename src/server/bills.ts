import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Transactor, Tx } from "../db/client";
import { pgErrorCode } from "../db/client";
import {
  companies,
  items,
  parties,
  purchaseBillLines,
  purchaseBills,
  purchaseOrderLines,
  purchaseOrders,
  uoms,
} from "../db/schema";
import { canCommit } from "../domain/approval";
import { addDays } from "../domain/dates";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import { computeInvoiceTax } from "../domain/gst";
import { type Finding, type MatchInput, threeWayMatch } from "../domain/matching";
import { type Paise, formatINR, toPaise } from "../domain/money";
import { unitCostAfterDiscount } from "../domain/purchasing";
import { lineTaxableValue } from "../domain/sales";
import { assertQty, parseDecimal } from "../domain/stock";
import { recordAudit } from "./audit";
import { allocatedByDoc, billedByPoLine } from "./bill-queries";
import { assertCanWrite, requireMember } from "./members";
import { allocateDocNumber } from "./numbering";
import { receivedByLine } from "./purchase-queries";
import { lockPurchaseOrder } from "./purchasing";
import { one } from "./util";

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Bill states in which the supplier's order can still be billed against. */
const BILLABLE_ORDER_STATES = new Set(["approved", "sent", "closed"]);

export const CreateBillInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid(),
  purchaseOrderId: z.uuid(),
  /** The supplier's own number for the bill. */
  supplierBillNo: z.string().trim().min(1),
  billDate: dateString,
  /** The supplier GSTIN exactly as printed on the bill; leave out if the bill has none. */
  supplierGstin: z.string().trim().min(1).optional(),
  lines: z
    .array(
      z.object({
        /** Line number on the purchase order this bills. */
        poLineNo: z.number().int().positive(),
        qty: decimal,
        /** Rupees per unit as billed. */
        unitPrice: decimal,
        discountPct: decimal.default("0"),
        /** GST rate in percent as billed. */
        gstRate: decimal,
      }),
    )
    .min(1, "A bill needs at least one line"),
  /**
   * The totals printed on the bill, in rupees. Give them whenever you have the paper bill: the match
   * checks them. Leave `stated` out and they are worked out from the lines at the rates billed.
   */
  stated: z
    .object({
      taxable: decimal.optional(),
      cgst: decimal.optional(),
      sgst: decimal.optional(),
      utgst: decimal.optional(),
      igst: decimal.optional(),
      cess: decimal.optional(),
      roundOff: decimal.optional(),
      total: decimal.optional(),
    })
    .optional(),
  notes: z.string().trim().min(1).optional(),
});
export type CreateBillInput = z.input<typeof CreateBillInput>;

const billKey = (billNo: string) => billNo.trim().toLowerCase().replace(/\s+/g, " ");

async function lockBill(tx: Tx, companyId: string, billId: string) {
  await tx.execute(sql`SELECT 1 FROM purchase_bills WHERE company_id = ${companyId} AND id = ${billId} FOR UPDATE`);
  const bill = (
    await tx.select().from(purchaseBills).where(and(eq(purchaseBills.companyId, companyId), eq(purchaseBills.id, billId)))
  )[0];
  if (!bill) throw new DomainError("UNKNOWN_BILL", "That bill does not exist");
  return bill;
}

/** Lock in the fixed order every purchase operation uses: the order first, then the bill. */
async function lockOrderThenBill(tx: Tx, companyId: string, billId: string) {
  const peek = (
    await tx.select().from(purchaseBills).where(and(eq(purchaseBills.companyId, companyId), eq(purchaseBills.id, billId)))
  )[0];
  if (!peek) throw new DomainError("UNKNOWN_BILL", "That bill does not exist");
  const order = await lockPurchaseOrder(tx, companyId, peek.purchaseOrderId);
  const bill = await lockBill(tx, companyId, billId);
  return { order, bill };
}

/**
 * Record a supplier's bill as printed. It is saved as a draft; submit it to run the three-way
 * match. The same supplier's bill number cannot be entered twice.
 */
export async function createBill(db: Transactor, rawInput: CreateBillInput) {
  const input = CreateBillInput.parse(rawInput);
  financialYearOf(input.billDate);

  try {
    return await db.transaction(async (tx) => {
      assertCanWrite(await requireMember(tx, input.companyId, input.actorUserId));
      const order = (
        await tx
          .select()
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.companyId, input.companyId), eq(purchaseOrders.id, input.purchaseOrderId)))
      )[0];
      if (!order) throw new DomainError("UNKNOWN_ORDER", "That purchase order does not exist");
      if (!BILLABLE_ORDER_STATES.has(order.state)) {
        throw new DomainError("ORDER_NOT_BILLABLE", `A bill can only be recorded against an approved, sent or closed order; this one is ${order.state}`);
      }
      if (input.billDate < order.orderDate) {
        throw new DomainError("BILL_BEFORE_ORDER", "A bill cannot be dated before the order it bills");
      }
      const supplier = one(await tx.select().from(parties).where(eq(parties.id, order.supplierId)), "supplier");

      const poLines = await tx
        .select({ line: purchaseOrderLines, decimals: uoms.decimals })
        .from(purchaseOrderLines)
        .innerJoin(items, and(eq(items.companyId, purchaseOrderLines.companyId), eq(items.id, purchaseOrderLines.itemId)))
        .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
        .where(and(eq(purchaseOrderLines.companyId, input.companyId), eq(purchaseOrderLines.orderId, order.id)));

      const seen = new Set<number>();
      const prepared = input.lines.map((line, index) => {
        const po = poLines.find((p) => p.line.lineNo === line.poLineNo);
        if (!po) throw new DomainError("UNKNOWN_LINE", `The order has no line ${line.poLineNo}`);
        if (seen.has(line.poLineNo)) throw new DomainError("DUPLICATE_LINE", `Order line ${line.poLineNo} appears twice on the bill`);
        seen.add(line.poLineNo);
        const qty = assertQty(line.qty, po.decimals, `Quantity for line ${line.poLineNo}`);
        if (parseDecimal(line.unitPrice, "Unit price").lt(0)) {
          throw new DomainError("INVALID_PRICE", `Line ${line.poLineNo}: the price cannot be negative`);
        }
        const discount = parseDecimal(line.discountPct, "Discount");
        if (discount.lt(0) || discount.gt(100)) {
          throw new DomainError("INVALID_DISCOUNT", `Line ${line.poLineNo}: discount must be between 0 and 100 percent`);
        }
        const rate = parseDecimal(line.gstRate, "GST rate");
        if (rate.lt(0) || rate.gt(100)) {
          throw new DomainError("INVALID_GST_RATE", `Line ${line.poLineNo}: the GST rate must be between 0 and 100 percent`);
        }
        return {
          lineNo: index + 1,
          poLine: po.line,
          qty: qty.toString(),
          unitPrice: line.unitPrice,
          discountPct: discount.toString(),
          gstRate: rate.toFixed(2),
          taxable: lineTaxableValue({ qty, unitPrice: line.unitPrice, discountPct: discount }),
        };
      });

      // Totals as printed, or worked out from the lines when the paper bill is not to hand.
      const computed = computeInvoiceTax(
        prepared.map((p) => ({
          taxableValue: p.taxable,
          ratePercent: p.gstRate,
          supplierState: order.supplierStateCode,
          placeOfSupply: order.placeOfSupplyStateCode,
        })),
      );
      const s = input.stated;
      const rupees = (v: string | undefined) => (v === undefined ? 0 : toPaise(v));
      const stated = s
        ? {
            taxable: s.taxable === undefined ? computed.taxableValue : toPaise(s.taxable),
            cgst: rupees(s.cgst),
            sgst: rupees(s.sgst),
            utgst: rupees(s.utgst),
            igst: rupees(s.igst),
            cess: rupees(s.cess),
            roundOff: rupees(s.roundOff),
            total: 0,
          }
        : {
            taxable: computed.taxableValue,
            cgst: computed.cgst,
            sgst: computed.sgst,
            utgst: computed.utgst,
            igst: computed.igst,
            cess: computed.cess,
            roundOff: computed.roundOff,
            total: computed.total,
          };
      if (s?.total !== undefined) stated.total = toPaise(s.total);
      else if (s) stated.total = stated.taxable + stated.cgst + stated.sgst + stated.utgst + stated.igst + stated.cess + stated.roundOff;

      const bill = one(
        await tx
          .insert(purchaseBills)
          .values({
            companyId: input.companyId,
            purchaseOrderId: order.id,
            supplierId: supplier.id,
            supplierBillNo: input.supplierBillNo,
            supplierBillKey: billKey(input.supplierBillNo),
            billDate: input.billDate,
            dueDate: addDays(input.billDate, supplier.creditDays),
            supplierGstinOnBill: input.supplierGstin ?? null,
            statedTaxablePaise: stated.taxable,
            statedCgstPaise: stated.cgst,
            statedSgstPaise: stated.sgst,
            statedUtgstPaise: stated.utgst,
            statedIgstPaise: stated.igst,
            statedCessPaise: stated.cess,
            statedRoundOffPaise: stated.roundOff,
            statedTotalPaise: stated.total,
            notes: input.notes ?? null,
            createdBy: input.actorUserId,
          })
          .returning(),
        "bill",
      );
      await tx.insert(purchaseBillLines).values(
        prepared.map((p) => ({
          companyId: input.companyId,
          billId: bill.id,
          lineNo: p.lineNo,
          purchaseOrderLineId: p.poLine.id,
          itemId: p.poLine.itemId,
          qty: p.qty,
          unitPrice: String(p.unitPrice),
          discountPct: p.discountPct,
          gstRate: p.gstRate,
          taxableValuePaise: p.taxable,
        })),
      );
      await recordAudit(tx, {
        companyId: input.companyId,
        actorUserId: input.actorUserId,
        action: "purchase_bill.recorded",
        entityType: "purchase_bill",
        entityId: bill.id,
        after: { supplier: supplier.name, supplierBillNo: bill.supplierBillNo, totalPaise: bill.statedTotalPaise },
      });
      return getBill(tx, { companyId: input.companyId, billId: bill.id });
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new DomainError("DUPLICATE_BILL", `This supplier's bill ${input.supplierBillNo} has already been recorded`);
    }
    throw error;
  }
}

/** Gather what the order and the goods received say, and run the pure three-way match. */
async function runMatch(tx: Tx, args: { companyId: string; billId: string; order: typeof purchaseOrders.$inferSelect; bill: typeof purchaseBills.$inferSelect }): Promise<Finding[]> {
  const { companyId, bill, order } = args;
  const company = one(await tx.select().from(companies).where(eq(companies.id, companyId)), "company");
  const supplier = one(await tx.select().from(parties).where(eq(parties.id, order.supplierId)), "supplier");
  const billLines = await tx.select().from(purchaseBillLines).where(eq(purchaseBillLines.billId, bill.id)).orderBy(asc(purchaseBillLines.lineNo));
  const poLines = await tx
    .select({ line: purchaseOrderLines, sku: items.sku })
    .from(purchaseOrderLines)
    .innerJoin(items, and(eq(items.companyId, purchaseOrderLines.companyId), eq(items.id, purchaseOrderLines.itemId)))
    .where(and(eq(purchaseOrderLines.companyId, companyId), eq(purchaseOrderLines.orderId, order.id)));
  const poLineIds = poLines.map((p) => p.line.id);
  const received = await receivedByLine(tx, companyId, poLineIds);
  const billedBefore = await billedByPoLine(tx, companyId, poLineIds, { excludeBillId: bill.id });
  const byId = new Map(poLines.map((p) => [p.line.id, p]));

  const input: MatchInput = {
    tolerance: {
      ratePct: company.billRateTolerancePct,
      qtyPct: company.billQtyTolerancePct,
      amountPaise: company.billAmountTolerancePaise,
    },
    supplier: { gstin: supplier.gstin, registration: supplier.registrationType },
    place: { supplierState: order.supplierStateCode, placeOfSupply: order.placeOfSupplyStateCode },
    poLines: poLines.map((p) => ({
      lineNo: p.line.lineNo,
      sku: p.sku,
      received: received.get(p.line.id) ?? 0,
      billedBefore: billedBefore.get(p.line.id) ?? 0,
      unitCost: unitCostAfterDiscount(p.line.unitPrice, p.line.discountPct),
      gstRate: p.line.gstRate,
    })),
    bill: {
      gstin: bill.supplierGstinOnBill,
      lines: billLines.map((l) => ({
        lineNo: l.lineNo,
        poLineNo: (byId.get(l.purchaseOrderLineId) as NonNullable<ReturnType<typeof byId.get>>).line.lineNo,
        qty: l.qty,
        unitCost: unitCostAfterDiscount(l.unitPrice, l.discountPct),
        gstRate: l.gstRate,
        taxablePaise: l.taxableValuePaise,
      })),
      stated: {
        taxable: bill.statedTaxablePaise,
        cgst: bill.statedCgstPaise,
        sgst: bill.statedSgstPaise,
        utgst: bill.statedUtgstPaise,
        igst: bill.statedIgstPaise,
        cess: bill.statedCessPaise,
        roundOff: bill.statedRoundOffPaise,
        total: bill.statedTotalPaise,
      },
    },
  };
  return threeWayMatch(input);
}

/**
 * Run the three-way match on a draft. A bill that matches is ready to post; any finding holds it,
 * with every reason recorded, until someone with authority releases it or it is rejected.
 */
export async function submitBill(
  db: Transactor,
  args: { companyId: string; billId: string; actorUserId: string },
) {
  return db.transaction(async (tx) => {
    assertCanWrite(await requireMember(tx, args.companyId, args.actorUserId));
    const { order, bill } = await lockOrderThenBill(tx, args.companyId, args.billId);
    if (bill.state !== "draft") throw new DomainError("NOT_DRAFT", `This bill is already ${bill.state}`);

    const findings = await runMatch(tx, { companyId: args.companyId, billId: bill.id, order, bill });
    const next = findings.length > 0 ? "held" : "matched";
    await tx
      .update(purchaseBills)
      .set({ state: next, matchFindings: findings, ...(next === "matched" ? { matchedAt: new Date() } : {}) })
      .where(eq(purchaseBills.id, bill.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: next === "held" ? "purchase_bill.held" : "purchase_bill.matched",
      entityType: "purchase_bill",
      entityId: bill.id,
      before: { state: "draft" },
      after: { state: next, findings: findings.map((f) => f.code) },
    });
    return getBill(tx, { companyId: args.companyId, billId: bill.id });
  });
}

/**
 * Release a held bill despite its findings. Needs someone whose approval limit covers the bill and
 * who did not enter it (an owner may release their own), and a reason. The findings stay on record.
 */
export async function overrideHeldBill(
  db: Transactor,
  args: { companyId: string; billId: string; actorUserId: string; reason: string },
) {
  return db.transaction(async (tx) => {
    const actor = await requireMember(tx, args.companyId, args.actorUserId);
    assertCanWrite(actor);
    const { bill } = await lockOrderThenBill(tx, args.companyId, args.billId);
    if (bill.state !== "held") throw new DomainError("NOT_HELD", `Only a held bill can be released; this one is ${bill.state}`);
    const reason = args.reason.trim();
    if (!reason) throw new DomainError("REASON_REQUIRED", "Say why the bill is being released despite the findings");
    if (actor.userId === bill.createdBy && actor.role !== "owner") {
      throw new DomainError("SELF_OVERRIDE", "The person who entered a bill cannot release it from hold");
    }
    if (!canCommit(actor, bill.statedTotalPaise)) {
      throw new DomainError(
        "INSUFFICIENT_AUTHORITY",
        `This bill is for ${formatINR(bill.statedTotalPaise)}; your approval limit is ${formatINR(actor.limitPaise)}`,
      );
    }
    const now = new Date();
    await tx
      .update(purchaseBills)
      .set({ state: "matched", overriddenBy: actor.userId, overrideReason: reason, overriddenAt: now, matchedAt: now })
      .where(eq(purchaseBills.id, bill.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: actor.userId,
      action: "purchase_bill.released_from_hold",
      entityType: "purchase_bill",
      entityId: bill.id,
      before: { state: "held", findings: (bill.matchFindings as Finding[]).map((f) => f.code) },
      after: { state: "matched", reason },
    });
    return getBill(tx, { companyId: args.companyId, billId: bill.id });
  });
}

/** Send a held bill back: the supplier is asked for a corrected one. A reason is required. */
export async function rejectHeldBill(
  db: Transactor,
  args: { companyId: string; billId: string; actorUserId: string; reason: string },
) {
  return db.transaction(async (tx) => {
    assertCanWrite(await requireMember(tx, args.companyId, args.actorUserId));
    const { bill } = await lockOrderThenBill(tx, args.companyId, args.billId);
    if (bill.state !== "held") throw new DomainError("NOT_HELD", `Only a held bill can be rejected; this one is ${bill.state}`);
    const reason = args.reason.trim();
    if (!reason) throw new DomainError("REASON_REQUIRED", "Say what the supplier needs to correct");
    await tx.update(purchaseBills).set({ state: "rejected", rejectReason: reason }).where(eq(purchaseBills.id, bill.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_bill.rejected",
      entityType: "purchase_bill",
      entityId: bill.id,
      before: { state: "held" },
      after: { state: "rejected", reason },
    });
    return getBill(tx, { companyId: args.companyId, billId: bill.id });
  });
}

/** Discard a bill that has not been posted (a draft, or one that matched but is not wanted). */
export async function cancelBill(
  db: Transactor,
  args: { companyId: string; billId: string; actorUserId: string },
) {
  return db.transaction(async (tx) => {
    assertCanWrite(await requireMember(tx, args.companyId, args.actorUserId));
    const { bill } = await lockOrderThenBill(tx, args.companyId, args.billId);
    if (bill.state !== "draft" && bill.state !== "matched") {
      throw new DomainError("NOT_CANCELLABLE", `A ${bill.state} bill cannot be cancelled${bill.state === "held" ? "; reject it instead" : ""}`);
    }
    await tx.update(purchaseBills).set({ state: "cancelled" }).where(eq(purchaseBills.id, bill.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_bill.cancelled",
      entityType: "purchase_bill",
      entityId: bill.id,
      before: { state: bill.state },
      after: { state: "cancelled" },
    });
    return getBill(tx, { companyId: args.companyId, billId: bill.id });
  });
}

/**
 * Book a matched bill: it takes our voucher number and becomes a payable. A bill that matched
 * on its own is checked again here, in case another bill has since used up the goods received.
 */
export async function postBill(
  db: Transactor,
  args: { companyId: string; billId: string; actorUserId: string },
) {
  return db.transaction(async (tx) => {
    assertCanWrite(await requireMember(tx, args.companyId, args.actorUserId));
    const { order, bill } = await lockOrderThenBill(tx, args.companyId, args.billId);
    if (bill.state !== "matched") {
      throw new DomainError("NOT_MATCHED", bill.state === "held" ? "This bill is on hold; release or reject it first" : `Only a matched bill can be posted; this one is ${bill.state}`);
    }
    if (bill.overriddenBy === null) {
      const findings = await runMatch(tx, { companyId: args.companyId, billId: bill.id, order, bill });
      if (findings.length > 0) {
        throw new DomainError("MATCH_CHANGED", `Since it was matched, this bill no longer matches: ${findings.map((f) => f.message).join("; ")}`);
      }
    }
    const number = await allocateDocNumber(tx, { companyId: args.companyId, docType: "purchase_bill", date: bill.billDate });
    await tx.update(purchaseBills).set({ state: "posted", number, postedAt: new Date() }).where(eq(purchaseBills.id, bill.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "purchase_bill.posted",
      entityType: "purchase_bill",
      entityId: bill.id,
      before: { state: "matched" },
      after: { state: "posted", number, totalPaise: bill.statedTotalPaise, dueDate: bill.dueDate },
    });
    return getBill(tx, { companyId: args.companyId, billId: bill.id });
  });
}

/** A bill with its lines, the reasons it was held, and (once posted) how much is still unpaid. */
export async function getBill(db: Executor, args: { companyId: string; billId: string }) {
  const bill = (
    await db.select().from(purchaseBills).where(and(eq(purchaseBills.companyId, args.companyId), eq(purchaseBills.id, args.billId)))
  )[0];
  if (!bill) throw new DomainError("UNKNOWN_BILL", "That bill does not exist");
  const order = one(await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, bill.purchaseOrderId)), "order");
  const lines = await db
    .select({ line: purchaseBillLines, sku: items.sku, poLineNo: purchaseOrderLines.lineNo })
    .from(purchaseBillLines)
    .innerJoin(items, and(eq(items.companyId, purchaseBillLines.companyId), eq(items.id, purchaseBillLines.itemId)))
    .innerJoin(
      purchaseOrderLines,
      and(eq(purchaseOrderLines.companyId, purchaseBillLines.companyId), eq(purchaseOrderLines.id, purchaseBillLines.purchaseOrderLineId)),
    )
    .where(and(eq(purchaseBillLines.companyId, args.companyId), eq(purchaseBillLines.billId, bill.id)))
    .orderBy(asc(purchaseBillLines.lineNo));
  const paid = bill.state === "posted" ? ((await allocatedByDoc(db, args.companyId, "purchase_bill", [bill.id])).get(bill.id) ?? 0) : 0;
  return {
    ...bill,
    findings: bill.matchFindings as Finding[],
    orderNumber: order.number,
    supplierName: order.supplierName,
    paidPaise: paid,
    outstandingPaise: bill.state === "posted" ? bill.statedTotalPaise - paid : 0,
    lines: lines.map(({ line, sku, poLineNo }) => ({ ...line, sku, poLineNo })),
  };
}

export interface BillRow {
  billId: string;
  state: string;
  number: string | null;
  supplierBillNo: string;
  supplierName: string;
  orderNumber: string | null;
  billDate: string;
  dueDate: string;
  totalPaise: Paise;
  findings: Finding[];
}

/** Bills, newest first; pass `states` to list only some (e.g. the held ones). */
export async function listBills(
  db: Executor,
  args: { companyId: string; states?: readonly ("draft" | "held" | "matched" | "posted" | "rejected" | "cancelled")[] },
): Promise<BillRow[]> {
  const rows = await db
    .select({ bill: purchaseBills, supplierName: purchaseOrders.supplierName, orderNumber: purchaseOrders.number })
    .from(purchaseBills)
    .innerJoin(
      purchaseOrders,
      and(eq(purchaseOrders.companyId, purchaseBills.companyId), eq(purchaseOrders.id, purchaseBills.purchaseOrderId)),
    )
    .where(
      args.states && args.states.length > 0
        ? and(eq(purchaseBills.companyId, args.companyId), inArray(purchaseBills.state, [...args.states]))
        : eq(purchaseBills.companyId, args.companyId),
    )
    .orderBy(desc(purchaseBills.createdAt), desc(purchaseBills.id));
  return rows.map(({ bill, supplierName, orderNumber }) => ({
    billId: bill.id,
    state: bill.state,
    number: bill.number,
    supplierBillNo: bill.supplierBillNo,
    supplierName,
    orderNumber,
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    totalPaise: bill.statedTotalPaise,
    findings: bill.matchFindings as Finding[],
  }));
}
