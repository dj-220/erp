import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { parties, purchaseBills, salesInvoices } from "../db/schema";
import { type AgeBucket, ageBucket, emptyBuckets, msmeDeadline } from "../domain/ageing";
import { daysBetween } from "../domain/dates";
import type { Paise } from "../domain/money";
import { allocatedByDoc, creditedByInvoice } from "./bill-queries";

type Row = Record<string, unknown>;

/** One bill, invoice or debit note and how much of it is still unpaid. */
export interface OpenDoc {
  docId: string;
  partyId: string;
  number: string;
  docDate: string;
  dueDate: string;
  totalPaise: Paise;
  /** Credit notes already applied against it (invoices only). */
  creditedPaise: Paise;
  paidPaise: Paise;
  /** Total less credits less payments. Negative when credits or payments exceed the invoice. */
  outstandingPaise: Paise;
}

/** Posted supplier bills with what has been paid against each. Pass `ids` to look at only some. */
export async function loadBillBalances(db: Executor, companyId: string, ids?: readonly string[]): Promise<OpenDoc[]> {
  if (ids && ids.length === 0) return [];
  const bills = await db
    .select()
    .from(purchaseBills)
    .where(
      and(
        eq(purchaseBills.companyId, companyId),
        eq(purchaseBills.state, "posted"),
        ...(ids ? [inArray(purchaseBills.id, [...ids])] : []),
      ),
    );
  const paid = await allocatedByDoc(db, companyId, "purchase_bill", bills.map((b) => b.id));
  return bills.map((b) => ({
    docId: b.id,
    partyId: b.supplierId,
    number: b.number as string,
    docDate: b.billDate,
    dueDate: b.dueDate,
    totalPaise: b.statedTotalPaise,
    creditedPaise: 0,
    paidPaise: paid.get(b.id) ?? 0,
    outstandingPaise: b.statedTotalPaise - (paid.get(b.id) ?? 0),
  }));
}

/** Posted tax invoices and debit notes with credits and receipts applied. Credit notes are not documents of their own here. */
export async function loadInvoiceBalances(db: Executor, companyId: string, ids?: readonly string[]): Promise<OpenDoc[]> {
  if (ids && ids.length === 0) return [];
  const invoices = await db
    .select()
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.companyId, companyId),
        eq(salesInvoices.state, "posted"),
        inArray(salesInvoices.kind, ["tax_invoice", "debit_note"]),
        ...(ids ? [inArray(salesInvoices.id, [...ids])] : []),
      ),
    );
  const received = await allocatedByDoc(db, companyId, "sales_invoice", invoices.map((i) => i.id));
  const credits = await creditedByInvoice(db, companyId, invoices.filter((i) => i.kind === "tax_invoice").map((i) => i.id));
  return invoices.map((i) => {
    const credited = credits.get(i.id) ?? 0;
    const paid = received.get(i.id) ?? 0;
    return {
      docId: i.id,
      partyId: i.customerId,
      number: i.number as string,
      docDate: i.invoiceDate,
      dueDate: i.dueDate,
      totalPaise: i.totalPaise,
      creditedPaise: credited,
      paidPaise: paid,
      outstandingPaise: i.totalPaise - credited - paid,
    };
  });
}

export interface AgeingDoc extends OpenDoc {
  daysOverdue: number;
  bucket: AgeBucket;
  /** Suppliers only: the 45-day limit for micro and small enterprises, and whether it has passed. */
  msmeDeadline?: string;
  msmeBreached?: boolean;
}

export interface AgeingParty {
  partyId: string;
  name: string;
  isMsme: boolean;
  docs: AgeingDoc[];
  buckets: Record<AgeBucket, Paise>;
  outstandingPaise: Paise;
  /** Money paid or received on account, not yet applied to any document. */
  unappliedPaise: Paise;
  /** Credit notes or overpayments beyond what the documents were worth. */
  creditBalancePaise: Paise;
}

export interface Ageing {
  asOf: string;
  parties: AgeingParty[];
  buckets: Record<AgeBucket, Paise>;
  totalOutstandingPaise: Paise;
  totalUnappliedPaise: Paise;
  totalCreditBalancePaise: Paise;
}

/** Payments (or receipts) not yet applied to any document, per party. */
async function unappliedByParty(db: Executor, companyId: string, direction: "paid" | "received"): Promise<Map<string, Paise>> {
  const out = new Map<string, Paise>();
  const { rows } = await db.execute(sql`
    SELECT p.party_id AS party_id, sum(p.amount_paise - coalesce(a.allocated, 0))::text AS unapplied
    FROM payments p
    LEFT JOIN (
      SELECT payment_id, sum(amount_paise) AS allocated FROM payment_allocations WHERE company_id = ${companyId} GROUP BY payment_id
    ) a ON a.payment_id = p.id
    WHERE p.company_id = ${companyId} AND p.direction = ${direction} AND p.state = 'posted'
    GROUP BY p.party_id`);
  for (const r of rows as Row[]) {
    const value = Number(r.unapplied);
    if (value > 0) out.set(String(r.party_id), value);
  }
  return out;
}

async function buildAgeing(
  db: Executor,
  args: { companyId: string; asOf: string; docs: OpenDoc[]; direction: "paid" | "received"; isSupplier: boolean },
): Promise<Ageing> {
  const people = new Map(
    (await db.select().from(parties).where(eq(parties.companyId, args.companyId))).map((p) => [p.id, p]),
  );
  const unapplied = await unappliedByParty(db, args.companyId, args.direction);
  const byParty = new Map<string, AgeingParty>();
  const partyOf = (partyId: string) => {
    let entry = byParty.get(partyId);
    if (!entry) {
      const party = people.get(partyId);
      entry = {
        partyId,
        name: party?.name ?? "",
        isMsme: party?.isMsme ?? false,
        docs: [],
        buckets: emptyBuckets(),
        outstandingPaise: 0,
        unappliedPaise: unapplied.get(partyId) ?? 0,
        creditBalancePaise: 0,
      };
      byParty.set(partyId, entry);
    }
    return entry;
  };

  for (const doc of args.docs) {
    const party = partyOf(doc.partyId);
    if (doc.outstandingPaise < 0) {
      party.creditBalancePaise += -doc.outstandingPaise;
      continue;
    }
    if (doc.outstandingPaise === 0) continue;
    const aged: AgeingDoc = {
      ...doc,
      daysOverdue: Math.max(0, daysBetween(doc.dueDate, args.asOf)),
      bucket: ageBucket(doc.dueDate, args.asOf),
    };
    if (args.isSupplier && party.isMsme) {
      aged.msmeDeadline = msmeDeadline(doc.docDate);
      aged.msmeBreached = args.asOf > aged.msmeDeadline;
    }
    party.docs.push(aged);
    party.buckets[aged.bucket] += doc.outstandingPaise;
    party.outstandingPaise += doc.outstandingPaise;
  }
  for (const partyId of unapplied.keys()) partyOf(partyId);

  const list = [...byParty.values()]
    .filter((p) => p.outstandingPaise > 0 || p.unappliedPaise > 0 || p.creditBalancePaise > 0)
    .map((p) => ({ ...p, docs: p.docs.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number)) }))
    .sort((a, b) => b.outstandingPaise - a.outstandingPaise || a.name.localeCompare(b.name));
  const totals = emptyBuckets();
  for (const p of list) for (const k of Object.keys(totals) as AgeBucket[]) totals[k] += p.buckets[k];
  return {
    asOf: args.asOf,
    parties: list,
    buckets: totals,
    totalOutstandingPaise: list.reduce((s, p) => s + p.outstandingPaise, 0),
    totalUnappliedPaise: list.reduce((s, p) => s + p.unappliedPaise, 0),
    totalCreditBalancePaise: list.reduce((s, p) => s + p.creditBalancePaise, 0),
  };
}

/**
 * What the company owes suppliers, by how overdue it is. Only posted bills count, so a bill on
 * hold is not yet a payable. Suppliers marked MSME also show the 45-day limit (informational).
 */
export async function getPayablesAgeing(db: Executor, args: { companyId: string; asOf: string }): Promise<Ageing> {
  return buildAgeing(db, {
    companyId: args.companyId,
    asOf: args.asOf,
    docs: await loadBillBalances(db, args.companyId),
    direction: "paid",
    isSupplier: true,
  });
}

/** What customers owe the company, by how overdue it is: invoices and debit notes, less credit notes and receipts. */
export async function getReceivablesAgeing(db: Executor, args: { companyId: string; asOf: string }): Promise<Ageing> {
  return buildAgeing(db, {
    companyId: args.companyId,
    asOf: args.asOf,
    docs: await loadInvoiceBalances(db, args.companyId),
    direction: "received",
    isSupplier: false,
  });
}
