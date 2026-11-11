import Big from "big.js";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import type { Paise } from "../domain/money";

type Row = Record<string, unknown>;

function inList(ids: readonly string[]) {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

/**
 * Quantity already billed per purchase order line, on bills that are held, matched or posted
 * (rejected and cancelled bills do not count). `excludeBillId` leaves one bill out, so a bill can
 * be re-checked against everything else.
 */
export async function billedByPoLine(
  db: Executor,
  companyId: string,
  poLineIds: readonly string[],
  options: { excludeBillId?: string } = {},
): Promise<Map<string, Big>> {
  const out = new Map<string, Big>();
  if (poLineIds.length === 0) return out;
  const exclude = options.excludeBillId ? sql`AND b.id <> ${options.excludeBillId}` : sql``;
  const { rows } = await db.execute(sql`
    SELECT l.purchase_order_line_id AS line_id, sum(l.qty)::text AS qty
    FROM purchase_bill_lines l
    JOIN purchase_bills b ON b.company_id = l.company_id AND b.id = l.bill_id
    WHERE l.company_id = ${companyId} AND b.state IN ('held', 'matched', 'posted') ${exclude}
      AND l.purchase_order_line_id IN (${inList(poLineIds)})
    GROUP BY l.purchase_order_line_id`);
  for (const r of rows as Row[]) out.set(String(r.line_id), new Big(String(r.qty)));
  return out;
}

/** Money allocated so far to each bill or invoice, by payments that have not been reversed. */
export async function allocatedByDoc(
  db: Executor,
  companyId: string,
  docType: "purchase_bill" | "sales_invoice",
  docIds: readonly string[],
): Promise<Map<string, Paise>> {
  const out = new Map<string, Paise>();
  if (docIds.length === 0) return out;
  const { rows } = await db.execute(sql`
    SELECT a.doc_id AS doc_id, sum(a.amount_paise)::text AS total
    FROM payment_allocations a
    JOIN payments p ON p.company_id = a.company_id AND p.id = a.payment_id
    WHERE a.company_id = ${companyId} AND a.doc_type = ${docType} AND p.state = 'posted'
      AND a.doc_id IN (${inList(docIds)})
    GROUP BY a.doc_id`);
  for (const r of rows as Row[]) out.set(String(r.doc_id), Number(r.total));
  return out;
}

/** Total of credit notes posted against each tax invoice. */
export async function creditedByInvoice(db: Executor, companyId: string, invoiceIds: readonly string[]): Promise<Map<string, Paise>> {
  const out = new Map<string, Paise>();
  if (invoiceIds.length === 0) return out;
  const { rows } = await db.execute(sql`
    SELECT original_invoice_id AS invoice_id, sum(total_paise)::text AS total
    FROM sales_invoices
    WHERE company_id = ${companyId} AND kind = 'credit_note' AND state = 'posted'
      AND original_invoice_id IN (${inList(invoiceIds)})
    GROUP BY original_invoice_id`);
  for (const r of rows as Row[]) out.set(String(r.invoice_id), Number(r.total));
  return out;
}
