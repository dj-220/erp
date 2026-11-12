import { sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import type { Role } from "../domain/approval";
import { addDays } from "../domain/dates";
import { financialYearOf } from "../domain/fy";
import type { Paise } from "../domain/money";
import { type DashboardSection, dashboardSections } from "../domain/permissions";
import { type PendingApproval, listPendingApprovals } from "./approvals";
import { type BillRow, listBills } from "./bills";
import { type Ageing, getPayablesAgeing, getReceivablesAgeing } from "./ledger-queries";
import { listAudit, listPurchaseOrders } from "./lists";
import { type OrderRisk, getOrderRisks } from "./sales-queries";
import { type ReorderRow, getReorderSuggestions, getStockValuation } from "./stock-queries";

type Row = Record<string, unknown>;

export interface Dashboard {
  asOf: string;
  role: Role;
  /** The parts of the dashboard this role may see; the other keys are absent, not hidden. */
  sections: DashboardSection[];
  orders?: {
    openCount: number;
    lateCount: number;
    atRiskCount: number;
    onTimeCount: number;
    /** Taxable value still to ship on orders that are late or at risk. */
    valueAtRiskPaise: Paise;
    /** Items the open orders are short of, by SKU. */
    shortItems: string[];
    /** Late and at-risk orders first. Fulfilled orders are left out. */
    board: OrderRisk[];
  };
  stock?: {
    lowStockCount: number;
    lowStock: ReorderRow[];
    /** Weighted-average value of everything in stock; shown only to roles that may see money. */
    valuePaise?: Paise;
  };
  purchasing?: {
    pendingApprovals: { count: number; totalPaise: Paise; rows: PendingApproval[] };
    onOrder: { count: number; overdueCount: number; valuePaise: Paise };
  };
  bills?: {
    held: { count: number; totalPaise: Paise; rows: BillRow[] };
    awaitingPostingCount: number;
  };
  money?: {
    receivables: AgeingSummary;
    payables: AgeingSummary & { msmeBreachedCount: number };
    thisMonth: { from: string; to: string; salesPaise: Paise; purchasesPaise: Paise; receivedPaise: Paise; paidPaise: Paise };
    financialYear: { label: string; salesPaise: Paise; purchasesPaise: Paise };
    /** Last six months, oldest first: taxable sales and purchases. */
    trend: { month: string; salesPaise: Paise; purchasesPaise: Paise }[];
  };
  activity?: { at: Date; actorName: string | null; action: string; entityType: string }[];
}

export interface AgeingSummary {
  outstandingPaise: Paise;
  overduePaise: Paise;
  buckets: Ageing["buckets"];
  unappliedPaise: Paise;
  creditBalancePaise: Paise;
  topParties: { name: string; outstandingPaise: Paise }[];
}

const summarise = (a: Ageing): AgeingSummary => ({
  outstandingPaise: a.totalOutstandingPaise,
  overduePaise: a.totalOutstandingPaise - a.buckets.not_due,
  buckets: a.buckets,
  unappliedPaise: a.totalUnappliedPaise,
  creditBalancePaise: a.totalCreditBalancePaise,
  topParties: a.parties.filter((p) => p.outstandingPaise > 0).slice(0, 5).map((p) => ({ name: p.name, outstandingPaise: p.outstandingPaise })),
});

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
function monthEnd(date: string): string {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  return addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`, -1);
}

/** Posted taxable sales (invoices and debit notes less credit notes) and purchases between two dates. */
async function totals(db: Executor, companyId: string, from: string, to: string) {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT coalesce(sum(CASE WHEN kind = 'credit_note' THEN -taxable_value_paise ELSE taxable_value_paise END), 0)
         FROM sales_invoices WHERE company_id = ${companyId} AND state = 'posted' AND invoice_date BETWEEN ${from} AND ${to})::text AS sales,
      (SELECT coalesce(sum(stated_taxable_paise), 0)
         FROM purchase_bills WHERE company_id = ${companyId} AND state = 'posted' AND bill_date BETWEEN ${from} AND ${to})::text AS purchases,
      (SELECT coalesce(sum(amount_paise), 0)
         FROM payments WHERE company_id = ${companyId} AND state = 'posted' AND direction = 'received' AND payment_date BETWEEN ${from} AND ${to})::text AS received,
      (SELECT coalesce(sum(amount_paise), 0)
         FROM payments WHERE company_id = ${companyId} AND state = 'posted' AND direction = 'paid' AND payment_date BETWEEN ${from} AND ${to})::text AS paid`);
  const r = (rows as Row[])[0] ?? {};
  return { salesPaise: Number(r.sales ?? 0), purchasesPaise: Number(r.purchases ?? 0), receivedPaise: Number(r.received ?? 0), paidPaise: Number(r.paid ?? 0) };
}

async function monthlyTrend(db: Executor, companyId: string, today: string) {
  // The current month and the five before it, oldest first.
  const months: string[] = [];
  let cursor = monthStart(today);
  for (let i = 0; i < 6; i++) {
    months.unshift(cursor.slice(0, 7));
    cursor = monthStart(addDays(cursor, -1)); // first day of the previous month
  }
  const from = `${months[0]}-01`;
  const { rows } = await db.execute(sql`
    SELECT to_char(invoice_date, 'YYYY-MM') AS month,
           sum(CASE WHEN kind = 'credit_note' THEN -taxable_value_paise ELSE taxable_value_paise END)::text AS sales
    FROM sales_invoices
    WHERE company_id = ${companyId} AND state = 'posted' AND invoice_date >= ${from} AND invoice_date <= ${monthEnd(today)}
    GROUP BY 1`);
  const sales = new Map((rows as Row[]).map((r) => [String(r.month), Number(r.sales)]));
  const { rows: bought } = await db.execute(sql`
    SELECT to_char(bill_date, 'YYYY-MM') AS month, sum(stated_taxable_paise)::text AS purchases
    FROM purchase_bills
    WHERE company_id = ${companyId} AND state = 'posted' AND bill_date >= ${from} AND bill_date <= ${monthEnd(today)}
    GROUP BY 1`);
  const purchases = new Map((bought as Row[]).map((r) => [String(r.month), Number(r.purchases)]));
  return months.map((month) => ({ month, salesPaise: sales.get(month) ?? 0, purchasesPaise: purchases.get(month) ?? 0 }));
}

/**
 * Everything on the home screen in one call. Parts the role may not see are not computed or sent:
 * a salesperson's dashboard contains no payables, a viewer's no money.
 */
export async function getDashboard(
  db: Executor,
  args: { companyId: string; userId: string; role: Role; today: string },
): Promise<Dashboard> {
  const { companyId, userId, role, today } = args;
  const sections = dashboardSections(role);
  const has = (s: DashboardSection) => sections.includes(s);
  const out: Dashboard = { asOf: today, role, sections };

  if (has("orders") || has("stock")) {
    // The board feeds both the orders panel and the "short of" list.
    const risks = await getOrderRisks(db, { companyId, today });
    const open = risks.filter((r) => r.status !== "fulfilled");
    const shortItems = [...new Set(open.flatMap((r) => r.shortOf))].sort();
    if (has("orders")) {
      out.orders = {
        openCount: open.length,
        lateCount: open.filter((r) => r.status === "late").length,
        atRiskCount: open.filter((r) => r.status === "at_risk").length,
        onTimeCount: open.filter((r) => r.status === "on_time").length,
        valueAtRiskPaise: open.filter((r) => r.status === "late" || r.status === "at_risk").reduce((s, r) => s + r.remainingValuePaise, 0),
        shortItems,
        board: open.slice(0, 8),
      };
    }
  }

  if (has("stock")) {
    const low = await getReorderSuggestions(db, { companyId });
    out.stock = { lowStockCount: low.length, lowStock: low.slice(0, 8) };
    if (has("money")) out.stock.valuePaise = (await getStockValuation(db, { companyId })).totalValuePaise;
  }

  if (has("purchasing")) {
    const pending = await listPendingApprovals(db, { companyId, forUserId: userId });
    const orders = await listPurchaseOrders(db, { companyId, limit: 200 });
    const onOrder = orders.rows.filter((o) => (o.state === "approved" || o.state === "sent") && o.receivedPercent < 100);
    out.purchasing = {
      pendingApprovals: { count: pending.length, totalPaise: pending.reduce((s, p) => s + p.amountPaise, 0), rows: pending.slice(0, 5) },
      onOrder: {
        count: onOrder.length,
        overdueCount: onOrder.filter((o) => o.expectedDate < today).length,
        valuePaise: onOrder.reduce((s, o) => s + o.totalPaise, 0),
      },
    };
  }

  if (has("bills")) {
    const held = await listBills(db, { companyId, states: ["held"] });
    const matched = await listBills(db, { companyId, states: ["matched"] });
    out.bills = {
      held: { count: held.length, totalPaise: held.reduce((s, b) => s + b.totalPaise, 0), rows: held.slice(0, 5) },
      awaitingPostingCount: matched.length,
    };
  }

  if (has("money")) {
    const receivables = await getReceivablesAgeing(db, { companyId, asOf: today });
    const payables = await getPayablesAgeing(db, { companyId, asOf: today });
    const fy = financialYearOf(today);
    const month = await totals(db, companyId, monthStart(today), monthEnd(today));
    const year = await totals(db, companyId, fy.start, fy.end);
    out.money = {
      receivables: summarise(receivables),
      payables: { ...summarise(payables), msmeBreachedCount: payables.parties.flatMap((p) => p.docs).filter((d) => d.msmeBreached).length },
      thisMonth: { from: monthStart(today), to: monthEnd(today), ...month },
      financialYear: { label: fy.label, salesPaise: year.salesPaise, purchasesPaise: year.purchasesPaise },
      trend: await monthlyTrend(db, companyId, today),
    };
  }

  if (has("activity")) {
    const audit = await listAudit(db, { companyId, limit: 10 });
    out.activity = audit.rows.map((a) => ({ at: a.at, actorName: a.actorName, action: a.action, entityType: a.entityType }));
  }
  return out;
}
