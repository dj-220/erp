import Big from "big.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { purchaseOrderLines, purchaseOrders } from "../db/schema";
import type { PlanSupply } from "../domain/planning";
import { openQty } from "../domain/purchasing";

type Row = Record<string, unknown>;

/** Quantity received so far per purchase order line (posted stock moves only). */
export async function receivedByLine(db: Executor, companyId: string, lineIds: readonly string[]): Promise<Map<string, Big>> {
  const out = new Map<string, Big>();
  if (lineIds.length === 0) return out;
  const { rows } = await db.execute(sql`
    SELECT purchase_order_line_id AS line_id, sum(qty)::text AS qty
    FROM stock_moves
    WHERE company_id = ${companyId} AND state = 'done'
      AND purchase_order_line_id IN (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY purchase_order_line_id`);
  for (const r of rows as Row[]) out.set(String(r.line_id), new Big(String(r.qty)));
  return out;
}

/** Quantity ordered so far per purchase request line, on orders that are still alive. */
export async function orderedByRequestLine(
  db: Executor,
  companyId: string,
  requestLineIds: readonly string[],
  options: { excludeOrderId?: string } = {},
): Promise<Map<string, Big>> {
  const out = new Map<string, Big>();
  if (requestLineIds.length === 0) return out;
  const exclude = options.excludeOrderId ? sql`AND o.id <> ${options.excludeOrderId}` : sql``;
  const { rows } = await db.execute(sql`
    SELECT l.purchase_request_line_id AS line_id, sum(l.qty)::text AS qty
    FROM purchase_order_lines l
    JOIN purchase_orders o ON o.company_id = l.company_id AND o.id = l.order_id
    WHERE l.company_id = ${companyId} AND o.state NOT IN ('cancelled', 'rejected') ${exclude}
      AND l.purchase_request_line_id IN (${sql.join(requestLineIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY l.purchase_request_line_id`);
  for (const r of rows as Row[]) out.set(String(r.line_id), new Big(String(r.qty)));
  return out;
}

/**
 * Stock on order from suppliers: for every approved or sent purchase order, what has not yet
 * arrived, with the date it is expected. Orders still waiting for approval do not count: the
 * company has not committed to them.
 */
export async function openIncoming(db: Executor, companyId: string): Promise<PlanSupply[]> {
  const lines = await db
    .select({
      id: purchaseOrderLines.id,
      itemId: purchaseOrderLines.itemId,
      qty: purchaseOrderLines.qty,
      expectedDate: purchaseOrders.expectedDate,
    })
    .from(purchaseOrderLines)
    .innerJoin(
      purchaseOrders,
      and(eq(purchaseOrders.companyId, purchaseOrderLines.companyId), eq(purchaseOrders.id, purchaseOrderLines.orderId)),
    )
    .where(and(eq(purchaseOrderLines.companyId, companyId), inArray(purchaseOrders.state, ["approved", "sent"])));
  const received = await receivedByLine(db, companyId, lines.map((l) => l.id));
  const out: PlanSupply[] = [];
  for (const line of lines) {
    const open = openQty(line.qty, received.get(line.id) ?? 0);
    if (open.gt(0)) out.push({ itemId: line.itemId, qty: open, expectedBy: line.expectedDate });
  }
  return out;
}
