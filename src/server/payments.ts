import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Transactor, Tx } from "../db/client";
import { paymentAllocations, payments, parties } from "../db/schema";
import { cashWarnings } from "../domain/ageing";
import { canCommit } from "../domain/approval";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import { formatINR, toPaise } from "../domain/money";
import { recordAudit } from "./audit";
import { type OpenDoc, loadBillBalances, loadInvoiceBalances } from "./ledger-queries";
import { assertCanWrite, requireMember } from "./members";
import { allocateDocNumber } from "./numbering";
import { one } from "./util";

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const RecordPaymentInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid(),
  /** "paid" = money out to a supplier; "received" = money in from a customer. */
  direction: z.enum(["paid", "received"]),
  partyId: z.uuid(),
  paymentDate: dateString,
  /** Rupees. */
  amount: decimal,
  mode: z.enum(["bank", "cash", "upi", "cheque", "card", "other"]),
  /** Cheque number, UTR or bank reference. */
  reference: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  /** What it settles: supplier bills for a payment, sales invoices or debit notes for a receipt. */
  allocations: z.array(z.object({ docId: z.uuid(), amount: decimal })).default([]),
});
export type RecordPaymentInput = z.input<typeof RecordPaymentInput>;

type PayAllocation = { docId: string; amountPaise: number };

/** Lock the documents being settled, in id order, so two payments cannot both spend the same balance. */
async function lockDocs(tx: Tx, table: "purchase_bills" | "sales_invoices", companyId: string, ids: readonly string[]) {
  if (ids.length === 0) return;
  const sorted = [...ids].sort();
  const list = sql.join(sorted.map((id) => sql`${id}`), sql`, `);
  await tx.execute(
    table === "purchase_bills"
      ? sql`SELECT id FROM purchase_bills WHERE company_id = ${companyId} AND id IN (${list}) ORDER BY id FOR UPDATE`
      : sql`SELECT id FROM sales_invoices WHERE company_id = ${companyId} AND id IN (${list}) ORDER BY id FOR UPDATE`,
  );
}

/** Check every allocation against the documents' open balances, then record them. */
async function allocate(
  tx: Tx,
  args: { companyId: string; payment: typeof payments.$inferSelect; allocations: readonly PayAllocation[]; alreadyAllocatedPaise: number },
) {
  const { companyId, payment, allocations } = args;
  if (allocations.length === 0) return;
  const ids = allocations.map((a) => a.docId);
  if (new Set(ids).size !== ids.length) throw new DomainError("DUPLICATE_ALLOCATION", "A document appears more than once");
  for (const a of allocations) {
    if (a.amountPaise <= 0) throw new DomainError("INVALID_ALLOCATION", "Each allocation must be more than zero");
  }
  const total = allocations.reduce((s, a) => s + a.amountPaise, 0);
  const free = payment.amountPaise - args.alreadyAllocatedPaise;
  if (total > free) {
    throw new DomainError("OVER_ALLOCATION", `Allocating ${formatINR(total)} but only ${formatINR(free)} of this payment is unallocated`);
  }

  const isPayment = payment.direction === "paid";
  await lockDocs(tx, isPayment ? "purchase_bills" : "sales_invoices", companyId, ids);
  const docs: OpenDoc[] = isPayment ? await loadBillBalances(tx, companyId, ids) : await loadInvoiceBalances(tx, companyId, ids);
  const byId = new Map(docs.map((d) => [d.docId, d]));
  for (const a of allocations) {
    const doc = byId.get(a.docId);
    if (!doc) {
      throw new DomainError(
        "NOT_PAYABLE",
        isPayment ? "That bill is not posted, so it cannot be paid yet" : "That invoice is not a posted tax invoice or debit note",
      );
    }
    if (doc.partyId !== payment.partyId) throw new DomainError("WRONG_PARTY", `${doc.number} belongs to a different party`);
    if (a.amountPaise > doc.outstandingPaise) {
      throw new DomainError(
        "OVER_ALLOCATION",
        `${doc.number}: ${formatINR(a.amountPaise)} allocated but only ${formatINR(Math.max(doc.outstandingPaise, 0))} is outstanding`,
      );
    }
  }
  await tx.insert(paymentAllocations).values(
    allocations.map((a) => ({
      companyId,
      paymentId: payment.id,
      docType: isPayment ? ("purchase_bill" as const) : ("sales_invoice" as const),
      docId: a.docId,
      amountPaise: a.amountPaise,
    })),
  );
}

async function allocatedSoFar(tx: Executor, companyId: string, paymentId: string): Promise<number> {
  const { rows } = await tx.execute(
    sql`SELECT coalesce(sum(amount_paise), 0)::text AS total FROM payment_allocations WHERE company_id = ${companyId} AND payment_id = ${paymentId}`,
  );
  return Number((rows as { total: string }[])[0]?.total ?? 0);
}

/**
 * Record money paid to a supplier or received from a customer, and what it settles. The amount a
 * person can pay out is limited by their approval limit (owners are unlimited). A payment can only
 * settle posted bills (or posted invoices and debit notes), never more than is outstanding on
 * each, and never more than the payment itself; the rest stays on account as an advance.
 * Large cash amounts return warnings, not errors.
 */
export async function recordPayment(db: Transactor, rawInput: RecordPaymentInput) {
  const input = RecordPaymentInput.parse(rawInput);
  financialYearOf(input.paymentDate);
  const amountPaise = toPaise(input.amount);
  if (amountPaise <= 0) throw new DomainError("INVALID_AMOUNT", "The amount must be more than zero");

  return db.transaction(async (tx) => {
    const actor = await requireMember(tx, input.companyId, input.actorUserId);
    assertCanWrite(actor);
    if (input.direction === "paid" && !canCommit(actor, amountPaise)) {
      throw new DomainError(
        "INSUFFICIENT_AUTHORITY",
        `You can record payments up to ${formatINR(actor.limitPaise)}; this one is ${formatINR(amountPaise)}`,
      );
    }
    const party = (
      await tx.select().from(parties).where(and(eq(parties.companyId, input.companyId), eq(parties.id, input.partyId)))
    )[0];
    if (!party) throw new DomainError("UNKNOWN_PARTY", "That party does not exist in this company");
    const wrongKind = input.direction === "paid" ? party.kind === "customer" : party.kind === "supplier";
    if (wrongKind) {
      throw new DomainError("WRONG_PARTY_KIND", `${party.name} is a ${party.kind}; ${input.direction === "paid" ? "payments go to suppliers" : "receipts come from customers"}`);
    }

    const sameDayCash = Number(
      (
        (
          await tx.execute(sql`
            SELECT coalesce(sum(amount_paise), 0)::text AS total FROM payments
            WHERE company_id = ${input.companyId} AND party_id = ${party.id} AND direction = ${input.direction}
              AND payment_date = ${input.paymentDate} AND mode = 'cash' AND state = 'posted'`)
        ).rows as { total: string }[]
      )[0]?.total ?? 0,
    );

    const number = await allocateDocNumber(tx, {
      companyId: input.companyId,
      docType: input.direction === "paid" ? "payment" : "receipt",
      date: input.paymentDate,
    });
    const payment = one(
      await tx
        .insert(payments)
        .values({
          companyId: input.companyId,
          direction: input.direction,
          number,
          partyId: party.id,
          paymentDate: input.paymentDate,
          amountPaise,
          mode: input.mode,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          createdBy: input.actorUserId,
        })
        .returning(),
      "payment",
    );
    await allocate(tx, {
      companyId: input.companyId,
      payment,
      allocations: input.allocations.map((a) => ({ docId: a.docId, amountPaise: toPaise(a.amount) })),
      alreadyAllocatedPaise: 0,
    });
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: input.direction === "paid" ? "payment.recorded" : "receipt.recorded",
      entityType: "payment",
      entityId: payment.id,
      after: { number, party: party.name, amountPaise, mode: input.mode, allocated: input.allocations.length },
    });
    const warnings = cashWarnings({ direction: input.direction, mode: input.mode, sameDayCashPaise: sameDayCash, amountPaise });
    return { ...(await getPayment(tx, { companyId: input.companyId, paymentId: payment.id })), warnings };
  });
}

/** Apply the unallocated part of an earlier payment (an advance) to documents that are now open. */
export async function allocatePayment(
  db: Transactor,
  args: { companyId: string; paymentId: string; actorUserId: string; allocations: { docId: string; amount: string | number }[] },
) {
  return db.transaction(async (tx) => {
    assertCanWrite(await requireMember(tx, args.companyId, args.actorUserId));
    await tx.execute(sql`SELECT 1 FROM payments WHERE company_id = ${args.companyId} AND id = ${args.paymentId} FOR UPDATE`);
    const payment = (
      await tx.select().from(payments).where(and(eq(payments.companyId, args.companyId), eq(payments.id, args.paymentId)))
    )[0];
    if (!payment) throw new DomainError("UNKNOWN_PAYMENT", "That payment does not exist");
    if (payment.state !== "posted") throw new DomainError("PAYMENT_REVERSED", "A reversed payment cannot be allocated");
    await allocate(tx, {
      companyId: args.companyId,
      payment,
      allocations: args.allocations.map((a) => ({ docId: a.docId, amountPaise: toPaise(a.amount) })),
      alreadyAllocatedPaise: await allocatedSoFar(tx, args.companyId, payment.id),
    });
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "payment.allocated",
      entityType: "payment",
      entityId: payment.id,
      after: { documents: args.allocations.length },
    });
    return getPayment(tx, { companyId: args.companyId, paymentId: payment.id });
  });
}

/**
 * Undo a payment, for example a cheque that bounced. It stays on record, marked reversed with a
 * reason, and the bills or invoices it settled become outstanding again.
 */
export async function reversePayment(
  db: Transactor,
  args: { companyId: string; paymentId: string; actorUserId: string; reason: string },
) {
  return db.transaction(async (tx) => {
    const actor = await requireMember(tx, args.companyId, args.actorUserId);
    assertCanWrite(actor);
    await tx.execute(sql`SELECT 1 FROM payments WHERE company_id = ${args.companyId} AND id = ${args.paymentId} FOR UPDATE`);
    const payment = (
      await tx.select().from(payments).where(and(eq(payments.companyId, args.companyId), eq(payments.id, args.paymentId)))
    )[0];
    if (!payment) throw new DomainError("UNKNOWN_PAYMENT", "That payment does not exist");
    if (payment.state === "reversed") throw new DomainError("ALREADY_REVERSED", "This payment has already been reversed");
    const reason = args.reason.trim();
    if (!reason) throw new DomainError("REASON_REQUIRED", "Say why the payment is being reversed");
    if (!canCommit(actor, payment.amountPaise)) {
      throw new DomainError(
        "INSUFFICIENT_AUTHORITY",
        `This payment is ${formatINR(payment.amountPaise)}; your approval limit is ${formatINR(actor.limitPaise)}`,
      );
    }
    await tx
      .update(payments)
      .set({ state: "reversed", reversedAt: new Date(), reversedBy: actor.userId, reverseReason: reason })
      .where(eq(payments.id, payment.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: actor.userId,
      action: "payment.reversed",
      entityType: "payment",
      entityId: payment.id,
      before: { state: "posted" },
      after: { state: "reversed", reason },
    });
    return getPayment(tx, { companyId: args.companyId, paymentId: payment.id });
  });
}

/** A payment with what it settled and how much is still on account. */
export async function getPayment(db: Executor, args: { companyId: string; paymentId: string }) {
  const payment = (
    await db.select().from(payments).where(and(eq(payments.companyId, args.companyId), eq(payments.id, args.paymentId)))
  )[0];
  if (!payment) throw new DomainError("UNKNOWN_PAYMENT", "That payment does not exist");
  const allocations = await db
    .select()
    .from(paymentAllocations)
    .where(and(eq(paymentAllocations.companyId, args.companyId), eq(paymentAllocations.paymentId, payment.id)))
    .orderBy(asc(paymentAllocations.createdAt), asc(paymentAllocations.id));
  const allocated = allocations.reduce((s, a) => s + a.amountPaise, 0);
  // Say which bill or invoice each part went to, so a person does not have to read ids.
  const labels = new Map<string, string>();
  if (allocations.length > 0) {
    const ids = sql.join(allocations.map((a) => sql`${a.docId}`), sql`, `);
    const { rows } = await db.execute(
      payment.direction === "paid"
        ? sql`SELECT id, coalesce(number, supplier_bill_no) AS label FROM purchase_bills WHERE company_id = ${args.companyId} AND id IN (${ids})`
        : sql`SELECT id, number AS label FROM sales_invoices WHERE company_id = ${args.companyId} AND id IN (${ids})`,
    );
    for (const r of rows as { id: string; label: string | null }[]) labels.set(r.id, r.label ?? "");
  }
  return {
    ...payment,
    allocations: allocations.map((a) => ({ ...a, docNumber: labels.get(a.docId) ?? null })),
    allocatedPaise: allocated,
    unallocatedPaise: payment.state === "posted" ? payment.amountPaise - allocated : 0,
  };
}
