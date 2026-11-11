import Big from "big.js";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { parties, salesOrderLines, salesOrders } from "../db/schema";
import { DomainError } from "../domain/errors";
import type { Paise } from "../domain/money";
import { planShortages } from "../domain/planning";
import { type OrderStatus, classifyOrder, invoiceableQty, lineTaxableValue } from "../domain/sales";
import { loadPlanningInputs } from "./stock-queries";

type Row = Record<string, unknown>;

function inList(ids: readonly string[]) {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

/** Quantity delivered so far per sales order line (posted stock moves only). */
export async function deliveredByLine(db: Executor, companyId: string, lineIds: readonly string[]): Promise<Map<string, Big>> {
  const out = new Map<string, Big>();
  if (lineIds.length === 0) return out;
  const { rows } = await db.execute(sql`
    SELECT sales_order_line_id AS line_id, sum(qty)::text AS qty
    FROM stock_moves
    WHERE company_id = ${companyId} AND state = 'done' AND sales_order_line_id IN (${inList(lineIds)})
    GROUP BY sales_order_line_id`);
  for (const r of rows as Row[]) out.set(String(r.line_id), new Big(String(r.qty)));
  return out;
}

/**
 * Quantity invoiced so far per sales order line, on tax invoices (credit and debit notes do not
 * count). `includeDrafts` also counts invoices not yet posted, so two drafts cannot claim the
 * same goods; `excludeInvoiceId` leaves one invoice out, for re-checking it at posting time.
 */
export async function invoicedByLine(
  db: Executor,
  companyId: string,
  lineIds: readonly string[],
  options: { includeDrafts: boolean; excludeInvoiceId?: string } = { includeDrafts: false },
): Promise<Map<string, Big>> {
  const out = new Map<string, Big>();
  if (lineIds.length === 0) return out;
  const states = options.includeDrafts ? sql`('posted', 'draft')` : sql`('posted')`;
  const exclude = options.excludeInvoiceId ? sql`AND i.id <> ${options.excludeInvoiceId}` : sql``;
  const { rows } = await db.execute(sql`
    SELECT l.sales_order_line_id AS line_id, sum(l.qty)::text AS qty
    FROM sales_invoice_lines l
    JOIN sales_invoices i ON i.company_id = l.company_id AND i.id = l.invoice_id
    WHERE l.company_id = ${companyId} AND i.kind = 'tax_invoice' AND i.state IN ${states} ${exclude}
      AND l.sales_order_line_id IN (${inList(lineIds)})
    GROUP BY l.sales_order_line_id`);
  for (const r of rows as Row[]) out.set(String(r.line_id), new Big(String(r.qty)));
  return out;
}

export interface OrderLineView {
  lineNo: number;
  lineId: string;
  itemId: string;
  sku: string;
  name: string;
  uom: string;
  isGoods: boolean;
  qty: string;
  unitPrice: string;
  discountPct: string;
  gstRate: string;
  hsnSac: string | null;
  delivered: string;
  invoiced: string;
  /** Goods still to be delivered (0 for services). */
  toDeliver: string;
  /** What could be put on an invoice right now. */
  invoiceable: string;
  taxableValuePaise: Paise;
}

/** An order with its lines and how far each has been delivered and invoiced. */
export async function getSalesOrder(db: Executor, args: { companyId: string; orderId: string }) {
  const order = (
    await db.select().from(salesOrders).where(and(eq(salesOrders.companyId, args.companyId), eq(salesOrders.id, args.orderId)))
  )[0];
  if (!order) throw new DomainError("UNKNOWN_ORDER", "That sales order does not exist");
  const lines = await db
    .select()
    .from(salesOrderLines)
    .where(and(eq(salesOrderLines.companyId, args.companyId), eq(salesOrderLines.orderId, order.id)))
    .orderBy(asc(salesOrderLines.lineNo));
  const customer = (await db.select().from(parties).where(eq(parties.id, order.customerId)))[0];
  const { byId } = await loadPlanningInputs(db, args.companyId);
  const ids = lines.map((l) => l.id);
  const delivered = await deliveredByLine(db, args.companyId, ids);
  const invoiced = await invoicedByLine(db, args.companyId, ids);

  const views: OrderLineView[] = lines.map((l) => {
    const item = byId.get(l.itemId);
    if (!item) throw new Error(`Item ${l.itemId} of order line ${l.id} is missing`);
    const isGoods = item.kind !== "service";
    const done = delivered.get(l.id) ?? new Big(0);
    const billed = invoiced.get(l.id) ?? new Big(0);
    const open = new Big(l.qty).minus(done);
    return {
      lineNo: l.lineNo,
      lineId: l.id,
      itemId: l.itemId,
      sku: item.sku,
      name: item.name,
      uom: item.uom,
      isGoods,
      qty: new Big(l.qty).toFixed(3),
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      gstRate: l.gstRate,
      hsnSac: l.hsnSac,
      delivered: done.toFixed(3),
      invoiced: billed.toFixed(3),
      toDeliver: (isGoods && open.gt(0) ? open : new Big(0)).toFixed(3),
      invoiceable: invoiceableQty({ ordered: l.qty, delivered: done, invoiced: billed, isGoods }).toFixed(3),
      taxableValuePaise: lineTaxableValue({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct }),
    };
  });
  return {
    ...order,
    customerName: customer?.name ?? "",
    lines: views,
    taxableValuePaise: views.reduce((sum, v) => sum + v.taxableValuePaise, 0),
  };
}

export interface OrderRisk {
  orderId: string;
  number: string;
  customerName: string;
  promisedDate: string;
  status: OrderStatus;
  reason: string;
  /** Taxable value of the goods still to be delivered. */
  remainingValuePaise: Paise;
  /** Items the order is short of, by SKU. */
  shortOf: string[];
}

const RANK: Record<OrderStatus, number> = { late: 0, at_risk: 1, on_time: 2, fulfilled: 3 };

/**
 * The orders board: every confirmed order with whether it will ship on time. Orders are served
 * from stock earliest-promise-first, so an order is "at risk" when the stock left after the
 * earlier-promised orders cannot cover what it still needs (finished goods first, then what the
 * BOM requires), plus approved purchase orders that arrive by the promised date.
 */
export async function getOrderRisks(db: Executor, args: { companyId: string; today: string }): Promise<OrderRisk[]> {
  const orders = await db
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.companyId, args.companyId), eq(salesOrders.state, "confirmed")));
  if (orders.length === 0) return [];
  const lines = await db.select().from(salesOrderLines).where(eq(salesOrderLines.companyId, args.companyId));
  const customers = new Map(
    (await db.select({ id: parties.id, name: parties.name }).from(parties).where(eq(parties.companyId, args.companyId))).map((p) => [p.id, p.name]),
  );
  const plan = await loadPlanningInputs(db, args.companyId);
  const delivered = await deliveredByLine(db, args.companyId, lines.map((l) => l.id));

  const demands: { id: string; itemId: string; qty: Big; needBy: string }[] = [];
  const remainingValue = new Map<string, Paise>();
  const hasRemaining = new Set<string>();
  for (const order of orders) {
    for (const line of lines.filter((l) => l.orderId === order.id)) {
      const item = plan.byId.get(line.itemId);
      if (!item || item.kind === "service") continue;
      const open = new Big(line.qty).minus(delivered.get(line.id) ?? 0);
      if (open.lte(0)) continue;
      hasRemaining.add(order.id);
      demands.push({ id: order.id, itemId: line.itemId, qty: open, needBy: order.promisedDate });
      remainingValue.set(
        order.id,
        (remainingValue.get(order.id) ?? 0) + lineTaxableValue({ qty: open, unitPrice: line.unitPrice, discountPct: line.discountPct }),
      );
    }
  }

  const shortages = planShortages({
    demands,
    boms: plan.planBoms,
    available: plan.onHand,
    incoming: plan.incoming,
    decimalsOf: (itemId) => plan.byId.get(itemId)?.decimals ?? 3,
  });
  const shortOf = new Map<string, string[]>();
  for (const s of shortages) {
    const sku = plan.byId.get(s.itemId)?.sku ?? s.itemId;
    for (const orderId of s.demandIds ?? []) shortOf.set(orderId, [...(shortOf.get(orderId) ?? []), sku]);
  }

  return orders
    .map((order): OrderRisk => {
      const names = (shortOf.get(order.id) ?? []).sort();
      const { status, reason } = classifyOrder({
        today: args.today,
        promisedDate: order.promisedDate,
        hasRemainingGoods: hasRemaining.has(order.id),
        shortageNames: names,
      });
      return {
        orderId: order.id,
        number: order.number as string,
        customerName: customers.get(order.customerId) ?? "",
        promisedDate: order.promisedDate,
        status,
        reason,
        remainingValuePaise: remainingValue.get(order.id) ?? 0,
        shortOf: names,
      };
    })
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.promisedDate.localeCompare(b.promisedDate) || a.number.localeCompare(b.number));
}
