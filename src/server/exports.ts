import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { and, asc, between, eq, inArray, sql } from "drizzle-orm";
import type { Executor, Transactor } from "../db/client";
import {
  companies,
  exportBatches,
  exportedDocuments,
  parties,
  paymentAllocations,
  payments,
  purchaseBills,
  salesInvoices,
} from "../db/schema";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import type { Finding } from "../domain/matching";
import type { SheetName } from "../domain/permissions";
import {
  type LedgerMaster,
  type Voucher,
  paymentVoucher,
  purchaseVoucher,
  renderMastersXml,
  renderVouchersXml,
  salesVoucher,
  standardLedgers,
} from "../domain/tally";
import { recordAudit } from "./audit";
import { getPayablesAgeing, getReceivablesAgeing } from "./ledger-queries";
import { listItems, listParties, listPayments, listPurchaseOrders, listSalesOrders } from "./lists";
import { getStockBalances, getStockValuation } from "./stock-queries";
import { one } from "./util";

/* ------------------------------------------------------------------------------------ Tally */

export interface TallyDoc {
  docType: "sales_invoice" | "purchase_bill" | "payment";
  docId: string;
  voucherNumber: string;
}

export interface TallyBuild {
  mastersXml: string;
  vouchersXml: string;
  voucherCount: number;
  counts: { invoices: number; creditNotes: number; debitNotes: number; bills: number; payments: number; receipts: number };
  docs: TallyDoc[];
  warnings: string[];
  from: string;
  to: string;
}

const REGISTRATION: Record<string, string> = {
  regular: "Regular",
  composition: "Composition",
  unregistered: "Unregistered",
  consumer: "Unregistered",
};

/**
 * Build the Tally files for the posted documents dated between `from` and `to` that have not been
 * exported yet. Nothing is recorded: this is also what the preview shows. Reversed payments are
 * left out, and a warning is raised for any that were already exported before being reversed.
 */
export async function buildTally(
  db: Executor,
  args: { companyId: string; from: string; to: string; includeExported?: boolean },
): Promise<TallyBuild> {
  financialYearOf(args.from);
  financialYearOf(args.to);
  if (args.to < args.from) throw new DomainError("INVALID_RANGE", "The end date is before the start date");
  const company = one(await db.select().from(companies).where(eq(companies.id, args.companyId)), "company");
  const people = new Map((await db.select().from(parties).where(eq(parties.companyId, args.companyId))).map((p) => [p.id, p]));
  const ledgerOf = (partyId: string) => {
    const p = people.get(partyId);
    return (p?.tallyLedgerName ?? p?.name ?? "").trim();
  };
  const already = new Set(
    (await db.select().from(exportedDocuments).where(eq(exportedDocuments.companyId, args.companyId))).map((d) => `${d.docType}:${d.docId}`),
  );
  const fresh = (docType: TallyDoc["docType"], id: string) => args.includeExported === true || !already.has(`${docType}:${id}`);

  const warnings: string[] = [];
  const docs: TallyDoc[] = [];
  const vouchers: (Voucher & { sortKey: string })[] = [];
  const add = (docType: TallyDoc["docType"], docId: string, v: Voucher) => {
    docs.push({ docType, docId, voucherNumber: v.number });
    warnings.push(...v.warnings);
    vouchers.push({ ...v, sortKey: `${v.date}|${v.type}|${v.number}` });
  };
  const counts = { invoices: 0, creditNotes: 0, debitNotes: 0, bills: 0, payments: 0, receipts: 0 };

  const invoices = await db
    .select()
    .from(salesInvoices)
    .where(and(eq(salesInvoices.companyId, args.companyId), eq(salesInvoices.state, "posted"), between(salesInvoices.invoiceDate, args.from, args.to)));
  const numberOf = new Map(invoices.map((i) => [i.id, i.number as string]));
  for (const i of invoices.filter((x) => fresh("sales_invoice", x.id))) {
    const against = i.originalInvoiceId ? (numberOf.get(i.originalInvoiceId) ?? (await db.select({ n: salesInvoices.number }).from(salesInvoices).where(eq(salesInvoices.id, i.originalInvoiceId)))[0]?.n ?? undefined) : undefined;
    add(
      "sales_invoice",
      i.id,
      salesVoucher({
        kind: i.kind,
        number: i.number as string,
        date: i.invoiceDate,
        partyLedger: ledgerOf(i.customerId),
        creditDays: Math.max(0, Math.round((Date.parse(i.dueDate) - Date.parse(i.invoiceDate)) / 86_400_000)),
        taxable: i.taxableValuePaise,
        cgst: i.cgstPaise,
        sgst: i.sgstPaise,
        utgst: i.utgstPaise,
        igst: i.igstPaise,
        cess: i.cessPaise,
        roundOff: i.roundOffPaise,
        total: i.totalPaise,
        againstNumber: against ?? undefined,
        reason: i.reason ?? undefined,
      }),
    );
    if (i.kind === "tax_invoice") counts.invoices += 1;
    else if (i.kind === "credit_note") counts.creditNotes += 1;
    else counts.debitNotes += 1;
  }

  const bills = await db
    .select()
    .from(purchaseBills)
    .where(and(eq(purchaseBills.companyId, args.companyId), eq(purchaseBills.state, "posted"), between(purchaseBills.billDate, args.from, args.to)));
  for (const b of bills.filter((x) => fresh("purchase_bill", x.id))) {
    add(
      "purchase_bill",
      b.id,
      purchaseVoucher({
        number: b.number as string,
        date: b.billDate,
        supplierBillNo: b.supplierBillNo,
        partyLedger: ledgerOf(b.supplierId),
        creditDays: Math.max(0, Math.round((Date.parse(b.dueDate) - Date.parse(b.billDate)) / 86_400_000)),
        taxable: b.statedTaxablePaise,
        cgst: b.statedCgstPaise,
        sgst: b.statedSgstPaise,
        utgst: b.statedUtgstPaise,
        igst: b.statedIgstPaise,
        cess: b.statedCessPaise,
        roundOff: b.statedRoundOffPaise,
        total: b.statedTotalPaise,
      }),
    );
    counts.bills += 1;
  }

  const pays = await db
    .select()
    .from(payments)
    .where(and(eq(payments.companyId, args.companyId), between(payments.paymentDate, args.from, args.to)));
  const live = pays.filter((p) => p.state === "posted" && fresh("payment", p.id));
  const allocs = live.length
    ? await db.select().from(paymentAllocations).where(and(eq(paymentAllocations.companyId, args.companyId), inArray(paymentAllocations.paymentId, live.map((p) => p.id))))
    : [];
  const billNames = new Map((await db.select({ id: purchaseBills.id, n: purchaseBills.supplierBillNo }).from(purchaseBills).where(eq(purchaseBills.companyId, args.companyId))).map((b) => [b.id, b.n]));
  const invoiceNames = new Map(
    (await db.select({ id: salesInvoices.id, n: salesInvoices.number }).from(salesInvoices).where(eq(salesInvoices.companyId, args.companyId))).map((i) => [i.id, i.n as string]),
  );
  for (const p of live) {
    add(
      "payment",
      p.id,
      paymentVoucher({
        direction: p.direction,
        number: p.number,
        date: p.paymentDate,
        mode: p.mode,
        partyLedger: ledgerOf(p.partyId),
        amountPaise: p.amountPaise,
        reference: p.reference,
        settles: allocs
          .filter((a) => a.paymentId === p.id)
          .map((a) => ({ name: (a.docType === "purchase_bill" ? billNames.get(a.docId) : invoiceNames.get(a.docId)) ?? a.docId, amountPaise: a.amountPaise })),
      }),
    );
    if (p.direction === "paid") counts.payments += 1;
    else counts.receipts += 1;
  }
  for (const p of pays.filter((x) => x.state === "reversed" && already.has(`payment:${x.id}`))) {
    warnings.push(`Payment ${p.number} was exported to Tally and has since been reversed; reverse it in Tally by hand.`);
  }

  const emptyLedger = vouchers.find((v) => !v.party);
  if (emptyLedger) warnings.push(`Voucher ${emptyLedger.number} has no party ledger name; set the party's Tally ledger name.`);
  const seen = new Map<string, string>();
  for (const p of people.values()) {
    const key = ledgerOf(p.id).toLowerCase();
    const earlier = seen.get(key);
    if (earlier && earlier !== p.id) warnings.push(`Two parties share the Tally ledger name "${ledgerOf(p.id)}"; give one a different ledger name.`);
    seen.set(key, p.id);
  }

  vouchers.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const company_ = company.tallyCompanyName ?? company.legalName;
  const partyLedgers: LedgerMaster[] = [...people.values()].map((p) => ({
    name: ledgerOf(p.id),
    parent: p.kind === "supplier" ? "Sundry Creditors" : "Sundry Debtors",
    billwise: true,
    gstin: p.gstin,
    registrationType: REGISTRATION[p.registrationType],
  }));
  return {
    mastersXml: renderMastersXml({ company: company_, ledgers: [...standardLedgers(), ...partyLedgers] }),
    vouchersXml: renderVouchersXml({ company: company_, vouchers }),
    voucherCount: vouchers.length,
    counts,
    docs,
    warnings: [...new Set(warnings)],
    from: args.from,
    to: args.to,
  };
}

/**
 * Build the vouchers file for a date range and record which documents are in it, so the same
 * document is never exported twice. Exporting runs one at a time per company.
 */
export async function exportTally(
  db: Transactor,
  args: { companyId: string; actorUserId: string; from: string; to: string },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM companies WHERE id = ${args.companyId} FOR UPDATE`);
    const build = await buildTally(tx, args);
    if (build.voucherCount === 0) throw new DomainError("NOTHING_TO_EXPORT", "Every posted document in that period has already been exported");
    const batch = one(
      await tx
        .insert(exportBatches)
        .values({
          companyId: args.companyId,
          kind: "tally",
          dateFrom: args.from,
          dateTo: args.to,
          voucherCount: build.voucherCount,
          fileSha256: createHash("sha256").update(build.vouchersXml).digest("hex"),
          createdBy: args.actorUserId,
        })
        .returning(),
      "export batch",
    );
    await tx.insert(exportedDocuments).values(build.docs.map((d) => ({ companyId: args.companyId, batchId: batch.id, ...d })));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "export.tally",
      entityType: "export_batch",
      entityId: batch.id,
      after: { from: args.from, to: args.to, vouchers: build.voucherCount, counts: build.counts },
    });
    return { batchId: batch.id, ...build };
  });
}

/* ----------------------------------------------------------------------------------- Excel */

type Kind = "text" | "money" | "qty" | "date" | "int" | "percent";
interface Col {
  header: string;
  key: string;
  width: number;
  kind?: Kind;
}
interface Sheet {
  name: string;
  columns: Col[];
  rows: Record<string, unknown>[];
  /** A bold row of totals at the bottom for these money columns. */
  totals?: string[];
}

const FORMATS: Record<Kind, string | undefined> = {
  text: undefined,
  money: "#,##0.00",
  qty: "#,##0.000",
  date: "dd-mmm-yyyy",
  int: "0",
  percent: '0.##"%"',
};

/** Every row of a paged list, up to a safe ceiling. */
async function allRows<T>(fetch: (page: { limit: number; offset: number }) => Promise<{ rows: T[]; total: number }>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 20_000; offset += 200) {
    const page = await fetch({ limit: 200, offset });
    out.push(...page.rows);
    if (out.length >= page.total || page.rows.length === 0) break;
  }
  return out;
}

const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? null : paise / 100);

async function sheetData(db: Executor, companyId: string, name: SheetName, asOf: string): Promise<Sheet> {
  switch (name) {
    case "parties": {
      const rows = await allRows((p) => listParties(db, { companyId, ...p }));
      return {
        name: "Parties",
        columns: [
          { header: "Name", key: "name", width: 32 },
          { header: "Type", key: "kind", width: 11 },
          { header: "GSTIN", key: "gstin", width: 18 },
          { header: "PAN", key: "pan", width: 13 },
          { header: "Registration", key: "registration", width: 14 },
          { header: "State code", key: "state", width: 10 },
          { header: "City", key: "city", width: 16 },
          { header: "Credit days", key: "credit", width: 11, kind: "int" },
          { header: "MSME", key: "msme", width: 7 },
          { header: "Tally ledger", key: "ledger", width: 30 },
          { header: "Active", key: "active", width: 8 },
        ],
        rows: rows.map((p) => ({ name: p.name, kind: p.kind, gstin: p.gstin, pan: p.pan, registration: p.registrationType, state: p.stateCode, city: p.city, credit: p.creditDays, msme: p.isMsme ? "Yes" : "", ledger: p.tallyLedgerName, active: p.isActive ? "Yes" : "No" })),
      };
    }
    case "items": {
      const rows = await allRows((p) => listItems(db, { companyId, ...p }));
      return {
        name: "Items",
        columns: [
          { header: "SKU", key: "sku", width: 16 },
          { header: "Name", key: "name", width: 32 },
          { header: "Kind", key: "kind", width: 14 },
          { header: "HSN / SAC", key: "hsn", width: 11 },
          { header: "GST %", key: "gst", width: 8, kind: "percent" },
          { header: "Unit", key: "uom", width: 7 },
          { header: "Sales price", key: "sales", width: 13, kind: "money" },
          { header: "Purchase price", key: "purchase", width: 14, kind: "money" },
          { header: "Reorder level", key: "level", width: 13, kind: "qty" },
          { header: "Reorder qty", key: "rqty", width: 12, kind: "qty" },
          { header: "Active", key: "active", width: 8 },
        ],
        rows: rows.map((i) => ({ sku: i.sku, name: i.name, kind: i.kind, hsn: i.hsnSac, gst: Number(i.gstRate), uom: i.uom, sales: i.salesPrice === null ? null : Number(i.salesPrice) * 100, purchase: i.purchasePrice === null ? null : Number(i.purchasePrice) * 100, level: Number(i.reorderLevel), rqty: Number(i.reorderQty), active: i.isActive ? "Yes" : "No" })),
      };
    }
    case "stock": {
      const rows = await getStockBalances(db, { companyId });
      return {
        name: "Stock",
        columns: [
          { header: "SKU", key: "sku", width: 16 },
          { header: "Name", key: "name", width: 32 },
          { header: "Unit", key: "uom", width: 7 },
          { header: "Location", key: "location", width: 24 },
          { header: "Quantity", key: "qty", width: 14, kind: "qty" },
        ],
        rows: rows.map((r) => ({ ...r, qty: Number(r.qty) })),
      };
    }
    case "valuation": {
      const v = await getStockValuation(db, { companyId });
      return {
        name: "Stock value",
        columns: [
          { header: "SKU", key: "sku", width: 16 },
          { header: "Name", key: "name", width: 32 },
          { header: "Unit", key: "uom", width: 7 },
          { header: "Quantity", key: "qty", width: 14, kind: "qty" },
          { header: "Average cost", key: "avg", width: 14, kind: "money" },
          { header: "Value", key: "value", width: 16, kind: "money" },
        ],
        rows: v.rows.map((r) => ({ sku: r.sku, name: r.name, uom: r.uom, qty: Number(r.qty), avg: r.avgCost === null ? null : Number(r.avgCost) * 100, value: r.valuePaise })),
        totals: ["value"],
      };
    }
    case "sales_orders": {
      const rows = await allRows((p) => listSalesOrders(db, { companyId, ...p }));
      return {
        name: "Sales orders",
        columns: [
          { header: "Number", key: "number", width: 18 },
          { header: "Status", key: "state", width: 11 },
          { header: "Customer", key: "customer", width: 30 },
          { header: "Order date", key: "orderDate", width: 12, kind: "date" },
          { header: "Promised", key: "promised", width: 12, kind: "date" },
          { header: "Customer PO", key: "po", width: 16 },
          { header: "Lines", key: "lines", width: 7, kind: "int" },
          { header: "Taxable value", key: "taxable", width: 16, kind: "money" },
        ],
        rows: rows.map((o) => ({ number: o.number, state: o.state, customer: o.customerName, orderDate: o.orderDate, promised: o.promisedDate, po: o.customerPoRef, lines: o.lineCount, taxable: o.taxableValuePaise })),
        totals: ["taxable"],
      };
    }
    case "sales_invoices": {
      const rows = await db.select().from(salesInvoices).where(eq(salesInvoices.companyId, companyId)).orderBy(asc(salesInvoices.invoiceDate), asc(salesInvoices.number));
      return {
        name: "Sales invoices",
        columns: [
          { header: "Type", key: "kind", width: 12 },
          { header: "Number", key: "number", width: 18 },
          { header: "Status", key: "state", width: 10 },
          { header: "Date", key: "date", width: 12, kind: "date" },
          { header: "Due", key: "due", width: 12, kind: "date" },
          { header: "Customer", key: "customer", width: 28 },
          { header: "GSTIN", key: "gstin", width: 18 },
          { header: "Place of supply", key: "pos", width: 14 },
          { header: "Taxable", key: "taxable", width: 15, kind: "money" },
          { header: "CGST", key: "cgst", width: 13, kind: "money" },
          { header: "SGST / UTGST", key: "sgst", width: 14, kind: "money" },
          { header: "IGST", key: "igst", width: 13, kind: "money" },
          { header: "Cess", key: "cess", width: 11, kind: "money" },
          { header: "Round off", key: "round", width: 11, kind: "money" },
          { header: "Total", key: "total", width: 15, kind: "money" },
        ],
        // Credit notes are negative, so the totals row nets them off against sales.
        rows: rows.map((i) => {
          const sign = i.kind === "credit_note" ? -1 : 1;
          return { kind: i.kind.replace("_", " "), number: i.number, state: i.state, date: i.invoiceDate, due: i.dueDate, customer: i.customerName, gstin: i.customerGstin, pos: i.placeOfSupplyStateCode, taxable: sign * i.taxableValuePaise, cgst: sign * i.cgstPaise, sgst: sign * (i.sgstPaise + i.utgstPaise), igst: sign * i.igstPaise, cess: sign * i.cessPaise, round: sign * i.roundOffPaise, total: sign * i.totalPaise };
        }),
        totals: ["taxable", "cgst", "sgst", "igst", "cess", "total"],
      };
    }
    case "purchase_orders": {
      const rows = await allRows((p) => listPurchaseOrders(db, { companyId, ...p }));
      return {
        name: "Purchase orders",
        columns: [
          { header: "Number", key: "number", width: 18 },
          { header: "Status", key: "state", width: 16 },
          { header: "Supplier", key: "supplier", width: 30 },
          { header: "Order date", key: "orderDate", width: 12, kind: "date" },
          { header: "Expected", key: "expected", width: 12, kind: "date" },
          { header: "Taxable value", key: "taxable", width: 16, kind: "money" },
          { header: "Total", key: "total", width: 16, kind: "money" },
          { header: "Received %", key: "received", width: 11, kind: "int" },
        ],
        rows: rows.map((o) => ({ number: o.number, state: o.state, supplier: o.supplierName, orderDate: o.orderDate, expected: o.expectedDate, taxable: o.taxableValuePaise, total: o.totalPaise, received: o.receivedPercent })),
        totals: ["taxable", "total"],
      };
    }
    case "bills": {
      const rows = await db.select().from(purchaseBills).where(eq(purchaseBills.companyId, companyId)).orderBy(asc(purchaseBills.billDate), asc(purchaseBills.supplierBillNo));
      const names = new Map((await db.select({ id: parties.id, n: parties.name }).from(parties).where(eq(parties.companyId, companyId))).map((p) => [p.id, p.n]));
      return {
        name: "Supplier bills",
        columns: [
          { header: "Our number", key: "number", width: 18 },
          { header: "Supplier's bill no.", key: "billNo", width: 20 },
          { header: "Supplier", key: "supplier", width: 28 },
          { header: "Status", key: "state", width: 10 },
          { header: "Bill date", key: "date", width: 12, kind: "date" },
          { header: "Due", key: "due", width: 12, kind: "date" },
          { header: "Taxable", key: "taxable", width: 15, kind: "money" },
          { header: "CGST", key: "cgst", width: 13, kind: "money" },
          { header: "SGST / UTGST", key: "sgst", width: 14, kind: "money" },
          { header: "IGST", key: "igst", width: 13, kind: "money" },
          { header: "Cess", key: "cess", width: 11, kind: "money" },
          { header: "Total", key: "total", width: 15, kind: "money" },
          { header: "Held for", key: "findings", width: 60 },
        ],
        rows: rows.map((b) => ({ number: b.number, billNo: b.supplierBillNo, supplier: names.get(b.supplierId), state: b.state, date: b.billDate, due: b.dueDate, taxable: b.statedTaxablePaise, cgst: b.statedCgstPaise, sgst: b.statedSgstPaise + b.statedUtgstPaise, igst: b.statedIgstPaise, cess: b.statedCessPaise, total: b.statedTotalPaise, findings: (b.matchFindings as Finding[]).map((f) => f.message).join("; ") })),
        totals: ["taxable", "cgst", "sgst", "igst", "cess", "total"],
      };
    }
    case "payments": {
      const rows = await allRows((p) => listPayments(db, { companyId, ...p }));
      return {
        name: "Payments and receipts",
        columns: [
          { header: "Number", key: "number", width: 18 },
          { header: "Direction", key: "direction", width: 10 },
          { header: "Party", key: "party", width: 30 },
          { header: "Date", key: "date", width: 12, kind: "date" },
          { header: "Mode", key: "mode", width: 9 },
          { header: "Reference", key: "reference", width: 20 },
          { header: "Amount", key: "amount", width: 15, kind: "money" },
          { header: "Allocated", key: "allocated", width: 15, kind: "money" },
          { header: "Status", key: "state", width: 10 },
        ],
        rows: rows.map((p) => ({ number: p.number, direction: p.direction, party: p.partyName, date: p.paymentDate, mode: p.mode, reference: p.reference, amount: p.amountPaise, allocated: p.allocatedPaise, state: p.state })),
      };
    }
    case "payables":
    case "receivables": {
      const ageing = name === "payables" ? await getPayablesAgeing(db, { companyId, asOf }) : await getReceivablesAgeing(db, { companyId, asOf });
      const label = { not_due: "Not due", "1_30": "1-30 days", "31_60": "31-60 days", "61_90": "61-90 days", over_90: "Over 90 days" } as const;
      return {
        name: name === "payables" ? "Payables" : "Receivables",
        columns: [
          { header: name === "payables" ? "Supplier" : "Customer", key: "party", width: 30 },
          { header: "Document", key: "doc", width: 20 },
          { header: "Date", key: "date", width: 12, kind: "date" },
          { header: "Due", key: "due", width: 12, kind: "date" },
          { header: "Total", key: "total", width: 15, kind: "money" },
          { header: "Outstanding", key: "outstanding", width: 15, kind: "money" },
          { header: "Days overdue", key: "days", width: 13, kind: "int" },
          { header: "Age", key: "bucket", width: 14 },
          { header: "MSME limit passed", key: "msme", width: 18 },
        ],
        rows: ageing.parties.flatMap((p) => p.docs.map((d) => ({ party: p.name, doc: d.number, date: d.docDate, due: d.dueDate, total: d.totalPaise, outstanding: d.outstandingPaise, days: d.daysOverdue, bucket: label[d.bucket], msme: d.msmeBreached ? "Yes" : "" }))),
        totals: ["outstanding"],
      };
    }
  }
}

/**
 * Build an Excel workbook of the chosen lists, as at `asOf`. Money is in rupees; dates are real
 * dates; each sheet has a frozen, filterable header. A first sheet says what the file is.
 */
export async function buildExcel(db: Executor, args: { companyId: string; sheets: readonly SheetName[]; asOf: string }): Promise<Buffer> {
  const company = one(await db.select().from(companies).where(eq(companies.id, args.companyId)), "company");
  const wb = new ExcelJS.Workbook();
  wb.creator = "ERP";
  wb.created = new Date();

  const about = wb.addWorksheet("About");
  about.columns = [{ width: 22 }, { width: 70 }];
  about.addRows([
    ["Company", company.legalName],
    ["GSTIN", company.gstin ?? ""],
    ["As at", args.asOf],
    ["Amounts", "In rupees. Credit notes are shown as negative amounts. Dates are real Excel dates, so you can sort and filter by them."],
    ["Sheets", args.sheets.join(", ")],
  ]);
  about.getColumn(1).font = { bold: true };

  for (const name of args.sheets) {
    const data = await sheetData(db, args.companyId, name, args.asOf);
    const ws = wb.addWorksheet(data.name);
    ws.columns = data.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of data.rows) {
      const values: Record<string, unknown> = {};
      for (const col of data.columns) {
        const v = row[col.key];
        values[col.key] =
          v === null || v === undefined || v === ""
            ? null
            : col.kind === "money"
              ? rupees(Number(v))
              : col.kind === "date"
                ? new Date(`${v as string}T00:00:00Z`)
                : v;
      }
      ws.addRow(values);
    }
    data.columns.forEach((col, i) => {
      const format = FORMATS[col.kind ?? "text"];
      if (format) ws.getColumn(i + 1).numFmt = format;
    });
    if (data.totals && data.rows.length > 0) {
      const total: Record<string, unknown> = { [data.columns[0]?.key as string]: "Total" };
      for (const key of data.totals) total[key] = rupees(data.rows.reduce((s, r) => s + Number(r[key] ?? 0), 0));
      const added = ws.addRow(total);
      added.font = { bold: true };
      added.border = { top: { style: "thin" } };
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: data.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
