import Big from "big.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Transactor, Tx } from "../db/client";
import {
  companies,
  items,
  parties,
  salesInvoiceLines,
  salesInvoices,
  salesOrderLines,
  salesOrders,
  uoms,
} from "../db/schema";
import { addDays } from "../domain/dates";
import { DomainError } from "../domain/errors";
import { financialYearOf } from "../domain/fy";
import { type TaxInput, computeInvoiceTax } from "../domain/gst";
import { assertInvoiceDateOrder, invoiceableQty, lineTaxableValue } from "../domain/sales";
import { assertQty, parseDecimal } from "../domain/stock";
import { recordAudit } from "./audit";
import { allocateDocNumber } from "./numbering";
import { deliveredByLine, invoicedByLine } from "./sales-queries";
import { one } from "./util";

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

type Row = Record<string, unknown>;
type Invoice = typeof salesInvoices.$inferSelect;
type InvoiceLine = typeof salesInvoiceLines.$inferSelect;

async function loadCompany(tx: Executor, companyId: string) {
  const company = (await tx.select().from(companies).where(eq(companies.id, companyId)))[0];
  if (!company) throw new DomainError("UNKNOWN_COMPANY", "That company does not exist");
  return company;
}

/** A business with no GSTIN cannot charge GST; it issues a bill of supply, which is not built yet. */
function assertCanIssueTaxInvoice(company: { gstin: string | null }) {
  if (!company.gstin) {
    throw new DomainError("COMPANY_NOT_REGISTERED", "This company has no GSTIN, so it cannot issue tax invoices");
  }
}

/** Pre-tax value already credited against each original invoice line, by credit notes. */
async function creditedByOriginalLine(
  db: Executor,
  companyId: string,
  lineIds: readonly string[],
  options: { includeDrafts: boolean; excludeInvoiceId?: string },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (lineIds.length === 0) return out;
  const states = options.includeDrafts ? sql`('posted', 'draft')` : sql`('posted')`;
  const exclude = options.excludeInvoiceId ? sql`AND i.id <> ${options.excludeInvoiceId}` : sql``;
  const { rows } = await db.execute(sql`
    SELECT l.original_line_id AS line_id, sum(l.taxable_value_paise)::text AS total
    FROM sales_invoice_lines l
    JOIN sales_invoices i ON i.company_id = l.company_id AND i.id = l.invoice_id
    WHERE l.company_id = ${companyId} AND i.kind = 'credit_note' AND i.state IN ${states} ${exclude}
      AND l.original_line_id IN (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY l.original_line_id`);
  for (const r of rows as Row[]) out.set(String(r.line_id), Number(r.total));
  return out;
}

function lineValues(
  companyId: string,
  invoiceId: string,
  prepared: {
    itemId: string;
    description: string | null;
    hsnSac: string;
    qty: string;
    unitPrice: string;
    discountPct: string;
    gstRate: string;
    taxable: number;
    salesOrderLineId: string | null;
    originalLineId: string | null;
  }[],
  tax: ReturnType<typeof computeInvoiceTax>,
) {
  return prepared.map((p, i) => {
    const t = tax.lines[i];
    if (!t) throw new Error("tax lines out of step with invoice lines");
    return {
      companyId,
      invoiceId,
      lineNo: i + 1,
      itemId: p.itemId,
      description: p.description,
      hsnSac: p.hsnSac,
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
      salesOrderLineId: p.salesOrderLineId,
      originalLineId: p.originalLineId,
    };
  });
}

function headerTotals(tax: ReturnType<typeof computeInvoiceTax>) {
  return {
    taxableValuePaise: tax.taxableValue,
    cgstPaise: tax.cgst,
    sgstPaise: tax.sgst,
    utgstPaise: tax.utgst,
    igstPaise: tax.igst,
    cessPaise: tax.cess,
    roundOffPaise: tax.roundOff,
    totalPaise: tax.total,
  };
}

export const CreateInvoiceFromOrderInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  orderId: z.uuid(),
  invoiceDate: dateString,
  /** Lines to bill. Omit to bill everything delivered and not yet invoiced. */
  lines: z.array(z.object({ lineNo: z.number().int().positive(), qty: decimal })).min(1).optional(),
});
export type CreateInvoiceFromOrderInput = z.input<typeof CreateInvoiceFromOrderInput>;

/**
 * Draft a tax invoice for goods delivered (and services ordered) on a sales order. Tax is worked
 * out line by line from the order's place of supply. Nothing is numbered until it is posted.
 */
export async function createInvoiceFromOrder(db: Transactor, rawInput: CreateInvoiceFromOrderInput) {
  const input = CreateInvoiceFromOrderInput.parse(rawInput);
  financialYearOf(input.invoiceDate);

  return db.transaction(async (tx) => {
    const company = await loadCompany(tx, input.companyId);
    assertCanIssueTaxInvoice(company);

    const order = (
      await tx.select().from(salesOrders).where(and(eq(salesOrders.companyId, input.companyId), eq(salesOrders.id, input.orderId)))
    )[0];
    if (!order) throw new DomainError("UNKNOWN_ORDER", "That sales order does not exist");
    if (order.state !== "confirmed" && order.state !== "closed") {
      throw new DomainError("ORDER_NOT_ACTIVE", `Only a confirmed order can be invoiced; this one is ${order.state}`);
    }
    if (input.invoiceDate < order.orderDate) {
      throw new DomainError("INVOICE_BEFORE_ORDER", "An invoice cannot be dated before its order");
    }
    const customer = one(await tx.select().from(parties).where(eq(parties.id, order.customerId)), "customer");

    const rows = await tx
      .select({ line: salesOrderLines, item: items, decimals: uoms.decimals })
      .from(salesOrderLines)
      .innerJoin(items, and(eq(items.companyId, salesOrderLines.companyId), eq(items.id, salesOrderLines.itemId)))
      .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
      .where(and(eq(salesOrderLines.companyId, input.companyId), eq(salesOrderLines.orderId, order.id)))
      .orderBy(asc(salesOrderLines.lineNo));
    const ids = rows.map((r) => r.line.id);
    const delivered = await deliveredByLine(tx, input.companyId, ids);
    const invoiced = await invoicedByLine(tx, input.companyId, ids, { includeDrafts: true });
    const room = (r: (typeof rows)[number]) =>
      invoiceableQty({
        ordered: r.line.qty,
        delivered: delivered.get(r.line.id) ?? 0,
        invoiced: invoiced.get(r.line.id) ?? 0,
        isGoods: r.item.kind !== "service",
      });

    const chosen: { row: (typeof rows)[number]; qty: Big }[] = [];
    if (input.lines) {
      for (const want of input.lines) {
        const row = rows.find((r) => r.line.lineNo === want.lineNo);
        if (!row) throw new DomainError("UNKNOWN_LINE", `The order has no line ${want.lineNo}`);
        const qty = assertQty(want.qty, row.decimals, `Quantity for line ${want.lineNo}`);
        if (qty.gt(room(row))) {
          throw new DomainError(
            "OVER_INVOICE",
            `Line ${want.lineNo}: only ${room(row).toFixed(3)} can be invoiced now (delivered and not yet invoiced), ${qty.toFixed(3)} requested`,
          );
        }
        chosen.push({ row, qty });
      }
    } else {
      for (const row of rows) if (room(row).gt(0)) chosen.push({ row, qty: room(row) });
    }
    if (chosen.length === 0) throw new DomainError("NOTHING_TO_INVOICE", "Nothing delivered is waiting to be invoiced");
    if (new Set(chosen.map((c) => c.row.line.id)).size !== chosen.length) {
      throw new DomainError("DUPLICATE_LINE", "A line appears more than once");
    }

    const prepared = chosen.map(({ row, qty }) => {
      if (!row.line.hsnSac) {
        throw new DomainError("HSN_REQUIRED", `${row.item.sku} has no HSN/SAC code; add it to the item before invoicing`);
      }
      return {
        itemId: row.item.id,
        description: row.line.description,
        hsnSac: row.line.hsnSac,
        qty: qty.toString(),
        unitPrice: row.line.unitPrice,
        discountPct: row.line.discountPct,
        gstRate: row.line.gstRate,
        taxable: lineTaxableValue({ qty, unitPrice: row.line.unitPrice, discountPct: row.line.discountPct }),
        salesOrderLineId: row.line.id,
        originalLineId: null,
      };
    });
    const taxInputs: TaxInput[] = prepared.map((p) => ({
      taxableValue: p.taxable,
      ratePercent: p.gstRate,
      supplierState: company.stateCode,
      placeOfSupply: order.shipToStateCode,
    }));
    const tax = computeInvoiceTax(taxInputs);

    const invoice = one(
      await tx
        .insert(salesInvoices)
        .values({
          companyId: input.companyId,
          kind: "tax_invoice",
          invoiceDate: input.invoiceDate,
          dueDate: addDays(input.invoiceDate, customer.creditDays),
          customerId: customer.id,
          salesOrderId: order.id,
          supplierGstin: company.gstin,
          supplierStateCode: company.stateCode,
          placeOfSupplyStateCode: order.shipToStateCode,
          customerName: customer.legalName ?? customer.name,
          customerGstin: customer.gstin,
          customerStateCode: customer.stateCode,
          supplyKind: tax.lines[0]?.kind ?? "intra",
          ...headerTotals(tax),
          createdBy: input.actorUserId ?? null,
        })
        .returning(),
      "invoice",
    );
    await tx.insert(salesInvoiceLines).values(lineValues(input.companyId, invoice.id, prepared, tax));
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "sales_invoice.created",
      entityType: "sales_invoice",
      entityId: invoice.id,
      after: { kind: "tax_invoice", order: order.number, lines: prepared.length, totalPaise: tax.total },
    });
    return getInvoice(tx, { companyId: input.companyId, invoiceId: invoice.id });
  });
}

export const CreateNoteInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  kind: z.enum(["credit_note", "debit_note"]),
  /** The posted tax invoice being corrected. */
  originalInvoiceId: z.uuid(),
  noteDate: dateString,
  /** Why the note is being issued (goods returned, price difference, ...). Required. */
  reason: z.string().trim().min(1, "A reason is required"),
  lines: z
    .array(
      z.object({
        /** Line number on the original invoice. */
        invoiceLineNo: z.number().int().positive(),
        qty: decimal,
        /** Rupees per unit to credit or debit (for a price difference, the difference). */
        unitPrice: decimal,
        description: z.string().trim().min(1).optional(),
      }),
    )
    .min(1, "A note needs at least one line"),
});
export type CreateNoteInput = z.input<typeof CreateNoteInput>;

/**
 * Draft a credit note (reduces what the customer owes) or debit note (increases it) against a
 * posted tax invoice. It keeps the original's place of supply and each line's HSN and GST rate,
 * and a credit note cannot give back more than the line's original value.
 *
 * Goods coming back into stock are not handled here: record them with a stock adjustment.
 */
export async function createNote(db: Transactor, rawInput: CreateNoteInput) {
  const input = CreateNoteInput.parse(rawInput);
  financialYearOf(input.noteDate);

  return db.transaction(async (tx) => {
    const company = await loadCompany(tx, input.companyId);
    assertCanIssueTaxInvoice(company);

    const original = (
      await tx
        .select()
        .from(salesInvoices)
        .where(and(eq(salesInvoices.companyId, input.companyId), eq(salesInvoices.id, input.originalInvoiceId)))
    )[0];
    if (!original) throw new DomainError("UNKNOWN_INVOICE", "That invoice does not exist");
    if (original.kind !== "tax_invoice" || original.state !== "posted") {
      throw new DomainError("ORIGINAL_NOT_POSTED", "A note can only be raised against a posted tax invoice");
    }
    if (input.noteDate < original.invoiceDate) {
      throw new DomainError("NOTE_BEFORE_INVOICE", "A note cannot be dated before the invoice it corrects");
    }

    const originalLines = await tx
      .select({ line: salesInvoiceLines, decimals: uoms.decimals })
      .from(salesInvoiceLines)
      .innerJoin(items, and(eq(items.companyId, salesInvoiceLines.companyId), eq(items.id, salesInvoiceLines.itemId)))
      .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
      .where(and(eq(salesInvoiceLines.companyId, input.companyId), eq(salesInvoiceLines.invoiceId, original.id)));
    const credited =
      input.kind === "credit_note"
        ? await creditedByOriginalLine(tx, input.companyId, originalLines.map((r) => r.line.id), { includeDrafts: true })
        : new Map<string, number>();

    const spent = new Map<string, number>(); // credit already planned within this note
    const prepared = input.lines.map((want) => {
      const row = originalLines.find((r) => r.line.lineNo === want.invoiceLineNo);
      if (!row) throw new DomainError("UNKNOWN_LINE", `The invoice has no line ${want.invoiceLineNo}`);
      const qty = assertQty(want.qty, row.decimals, `Quantity for line ${want.invoiceLineNo}`);
      if (parseDecimal(want.unitPrice, "Unit price").lt(0)) {
        throw new DomainError("INVALID_PRICE", `Line ${want.invoiceLineNo}: the price cannot be negative`);
      }
      const taxable = lineTaxableValue({ qty, unitPrice: want.unitPrice });
      if (input.kind === "credit_note") {
        const total = (credited.get(row.line.id) ?? 0) + (spent.get(row.line.id) ?? 0) + taxable;
        if (total > row.line.taxableValuePaise) {
          throw new DomainError(
            "CREDIT_EXCEEDS_INVOICE",
            `Line ${want.invoiceLineNo}: credits would total ${total} paise but the line was only invoiced for ${row.line.taxableValuePaise} paise`,
          );
        }
        spent.set(row.line.id, (spent.get(row.line.id) ?? 0) + taxable);
      }
      return {
        itemId: row.line.itemId,
        description: want.description ?? row.line.description,
        hsnSac: row.line.hsnSac,
        qty: qty.toString(),
        unitPrice: String(want.unitPrice),
        discountPct: "0",
        gstRate: row.line.gstRate,
        taxable,
        salesOrderLineId: null,
        originalLineId: row.line.id,
      };
    });

    const tax = computeInvoiceTax(
      prepared.map((p) => ({
        taxableValue: p.taxable,
        ratePercent: p.gstRate,
        supplierState: original.supplierStateCode,
        placeOfSupply: original.placeOfSupplyStateCode,
      })),
    );
    const note = one(
      await tx
        .insert(salesInvoices)
        .values({
          companyId: input.companyId,
          kind: input.kind,
          invoiceDate: input.noteDate,
          dueDate: input.noteDate,
          customerId: original.customerId,
          salesOrderId: original.salesOrderId,
          originalInvoiceId: original.id,
          reason: input.reason,
          supplierGstin: original.supplierGstin,
          supplierStateCode: original.supplierStateCode,
          placeOfSupplyStateCode: original.placeOfSupplyStateCode,
          customerName: original.customerName,
          customerGstin: original.customerGstin,
          customerStateCode: original.customerStateCode,
          supplyKind: original.supplyKind,
          ...headerTotals(tax),
          createdBy: input.actorUserId ?? null,
        })
        .returning(),
      "note",
    );
    await tx.insert(salesInvoiceLines).values(lineValues(input.companyId, note.id, prepared, tax));
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "sales_invoice.created",
      entityType: "sales_invoice",
      entityId: note.id,
      after: { kind: input.kind, against: original.number, reason: input.reason, totalPaise: tax.total },
    });
    return getInvoice(tx, { companyId: input.companyId, invoiceId: note.id });
  });
}

async function lockInvoice(tx: Tx, companyId: string, invoiceId: string): Promise<Invoice> {
  await tx.execute(sql`SELECT 1 FROM sales_invoices WHERE company_id = ${companyId} AND id = ${invoiceId} FOR UPDATE`);
  const invoice = (
    await tx.select().from(salesInvoices).where(and(eq(salesInvoices.companyId, companyId), eq(salesInvoices.id, invoiceId)))
  )[0];
  if (!invoice) throw new DomainError("UNKNOWN_INVOICE", "That invoice does not exist");
  return invoice;
}

const NUMBER_TYPE = { tax_invoice: "sales_invoice", credit_note: "credit_note", debit_note: "debit_note" } as const;

/**
 * Post a draft: re-check it against the latest facts, take the next legal number in the series
 * and freeze it. The number is consecutive with no gaps, and dates never run backwards within a
 * series. After this the invoice can never change; correct it with a credit or debit note.
 */
export async function postInvoice(
  db: Transactor,
  args: { companyId: string; invoiceId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, args.companyId, args.invoiceId);
    if (invoice.state !== "draft") throw new DomainError("NOT_DRAFT", `This invoice is already ${invoice.state}`);

    const lines = await tx
      .select({ line: salesInvoiceLines, decimals: uoms.decimals, isGoods: items.kind })
      .from(salesInvoiceLines)
      .innerJoin(items, and(eq(items.companyId, salesInvoiceLines.companyId), eq(items.id, salesInvoiceLines.itemId)))
      .innerJoin(uoms, and(eq(uoms.companyId, items.companyId), eq(uoms.id, items.uomId)))
      .where(and(eq(salesInvoiceLines.companyId, args.companyId), eq(salesInvoiceLines.invoiceId, invoice.id)));

    if (invoice.kind === "tax_invoice" && invoice.salesOrderId) {
      // Another draft may have been posted since this one was made: re-check against posted invoices only.
      await tx.execute(sql`SELECT 1 FROM sales_orders WHERE company_id = ${args.companyId} AND id = ${invoice.salesOrderId} FOR UPDATE`);
      const orderLineIds = lines.map((l) => l.line.salesOrderLineId).filter((id): id is string => id !== null);
      const orderLines = await tx.select().from(salesOrderLines).where(inArray(salesOrderLines.id, orderLineIds));
      const delivered = await deliveredByLine(tx, args.companyId, orderLineIds);
      const posted = await invoicedByLine(tx, args.companyId, orderLineIds, { includeDrafts: false, excludeInvoiceId: invoice.id });
      for (const { line, isGoods } of lines) {
        const orderLine = orderLines.find((o) => o.id === line.salesOrderLineId);
        if (!orderLine) continue;
        const room = invoiceableQty({
          ordered: orderLine.qty,
          delivered: delivered.get(orderLine.id) ?? 0,
          invoiced: posted.get(orderLine.id) ?? 0,
          isGoods: isGoods !== "service",
        });
        if (new Big(line.qty).gt(room)) {
          throw new DomainError("OVER_INVOICE", `Line ${line.lineNo}: only ${room.toFixed(3)} can be invoiced now; another invoice has used the rest`);
        }
      }
    }
    if (invoice.kind === "credit_note") {
      const originalIds = lines.map((l) => l.line.originalLineId).filter((id): id is string => id !== null);
      const already = await creditedByOriginalLine(tx, args.companyId, originalIds, { includeDrafts: false, excludeInvoiceId: invoice.id });
      const originals = await tx.select().from(salesInvoiceLines).where(inArray(salesInvoiceLines.id, originalIds));
      for (const { line } of lines) {
        const original = originals.find((o) => o.id === line.originalLineId);
        if (original && (already.get(original.id) ?? 0) + line.taxableValuePaise > original.taxableValuePaise) {
          throw new DomainError("CREDIT_EXCEEDS_INVOICE", `Line ${line.lineNo}: credit notes already issued leave too little to credit`);
        }
      }
    }

    const fy = financialYearOf(invoice.invoiceDate);
    const latest = (
      await tx.execute(sql`
        SELECT max(invoice_date)::text AS latest FROM sales_invoices
        WHERE company_id = ${args.companyId} AND kind = ${invoice.kind} AND state = 'posted'
          AND invoice_date BETWEEN ${fy.start} AND ${fy.end}`)
    ).rows as Row[];
    assertInvoiceDateOrder(invoice.invoiceDate, (latest[0]?.latest as string | null | undefined) ?? null);

    const number = await allocateDocNumber(tx, {
      companyId: args.companyId,
      docType: NUMBER_TYPE[invoice.kind],
      date: invoice.invoiceDate,
    });
    const posted = one(
      await tx
        .update(salesInvoices)
        .set({ state: "posted", number, postedAt: new Date() })
        .where(eq(salesInvoices.id, invoice.id))
        .returning(),
      "posted invoice",
    );
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "sales_invoice.posted",
      entityType: "sales_invoice",
      entityId: invoice.id,
      before: { state: "draft" },
      after: { state: "posted", number, kind: invoice.kind, totalPaise: invoice.totalPaise },
    });
    return getInvoice(tx, { companyId: args.companyId, invoiceId: posted.id });
  });
}

/** Discard a draft. A posted invoice cannot be cancelled here; issue a credit note. */
export async function cancelInvoice(
  db: Transactor,
  args: { companyId: string; invoiceId: string; actorUserId?: string },
) {
  return db.transaction(async (tx) => {
    const invoice = await lockInvoice(tx, args.companyId, args.invoiceId);
    if (invoice.state !== "draft") {
      throw new DomainError("NOT_DRAFT", `This invoice is already ${invoice.state}; issue a credit note to reverse it`);
    }
    await tx.update(salesInvoices).set({ state: "cancelled" }).where(eq(salesInvoices.id, invoice.id));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "sales_invoice.cancelled",
      entityType: "sales_invoice",
      entityId: invoice.id,
      before: { state: "draft" },
      after: { state: "cancelled" },
    });
    return getInvoice(tx, { companyId: args.companyId, invoiceId: invoice.id });
  });
}

/** An invoice or note with its lines (SKUs instead of ids). */
export async function getInvoice(db: Executor, args: { companyId: string; invoiceId: string }) {
  const invoice = (
    await db.select().from(salesInvoices).where(and(eq(salesInvoices.companyId, args.companyId), eq(salesInvoices.id, args.invoiceId)))
  )[0];
  if (!invoice) throw new DomainError("UNKNOWN_INVOICE", "That invoice does not exist");
  const lines = await db
    .select({ line: salesInvoiceLines, sku: items.sku })
    .from(salesInvoiceLines)
    .innerJoin(items, and(eq(items.companyId, salesInvoiceLines.companyId), eq(items.id, salesInvoiceLines.itemId)))
    .where(and(eq(salesInvoiceLines.companyId, args.companyId), eq(salesInvoiceLines.invoiceId, invoice.id)))
    .orderBy(asc(salesInvoiceLines.lineNo));
  return {
    ...invoice,
    lines: lines.map(({ line, sku }: { line: InvoiceLine; sku: string }) => ({
      ...line,
      sku,
      totalPaise:
        line.taxableValuePaise + line.cgstPaise + line.sgstPaise + line.utgstPaise + line.igstPaise + line.cessPaise,
    })),
  };
}
