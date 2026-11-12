import { useState } from "react";
import { get } from "../api";
import { AgeingBars, Meter, TrendChart, ViewToggle, type TrendPoint } from "../charts";
import { date, dateTime, humanise, inr, inrShort, qty } from "../format";
import { Card, DataTable, Loading, Page, Status, useLoad } from "../ui";

interface Ageing {
  outstandingPaise: number;
  overduePaise: number;
  buckets: Record<string, number>;
  unappliedPaise: number;
  creditBalancePaise: number;
  topParties: { name: string; outstandingPaise: number }[];
}
interface BoardRow {
  orderId: string;
  number: string;
  customerName: string;
  promisedDate: string;
  status: string;
  reason: string;
  remainingValuePaise: number;
}
interface Approval {
  requestId: string;
  docNumber: string | null;
  supplierName: string;
  amountPaise: number;
  requestedByName: string;
  assignedToName: string | null;
  canDecide?: boolean;
}
interface HeldBill {
  billId: string;
  supplierBillNo: string;
  supplierName: string;
  totalPaise: number;
  findings: { code: string; message: string }[];
}
interface Dash {
  asOf: string;
  sections: string[];
  orders?: { openCount: number; lateCount: number; atRiskCount: number; onTimeCount: number; valueAtRiskPaise: number; shortItems: string[]; board: BoardRow[] };
  stock?: { lowStockCount: number; lowStock: { sku: string; name: string; uom: string; onHand: string; reorderLevel: string; suggestedQty: string }[]; valuePaise?: number };
  purchasing?: { pendingApprovals: { count: number; totalPaise: number; rows: Approval[] }; onOrder: { count: number; overdueCount: number; valuePaise: number } };
  bills?: { held: { count: number; totalPaise: number; rows: HeldBill[] }; awaitingPostingCount: number };
  money?: {
    receivables: Ageing;
    payables: Ageing & { msmeBreachedCount: number };
    thisMonth: { salesPaise: number; purchasesPaise: number; receivedPaise: number; paidPaise: number };
    financialYear: { label: string; salesPaise: number; purchasesPaise: number };
    trend: TrendPoint[];
  };
  activity?: { at: string; actorName: string | null; action: string }[];
}

function Tile({ label, value, note, href }: { label: string; value: string; note?: string; href: string }) {
  return (
    <a className="card tile" href={href}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </a>
  );
}

export function Dashboard() {
  const state = useLoad(() => get<Dash>("/api/dashboard"), []);
  const [trendView, setTrendView] = useState<"chart" | "table">("chart");
  const [recView, setRecView] = useState<"chart" | "table">("chart");
  const [payView, setPayView] = useState<"chart" | "table">("chart");

  return (
    <Page title="Dashboard" subtitle={state.data ? `As at ${date(state.data.asOf)}` : undefined} actions={<button className="btn" onClick={state.reload} disabled={state.loading}>Refresh</button>}>
      <Loading state={state}>
        {state.data ? <Body d={state.data} {...{ trendView, setTrendView, recView, setRecView, payView, setPayView }} /> : null}
      </Loading>
    </Page>
  );
}

type View = "chart" | "table";
function Body({ d, trendView, setTrendView, recView, setRecView, payView, setPayView }: { d: Dash; trendView: View; setTrendView: (v: View) => void; recView: View; setRecView: (v: View) => void; payView: View; setPayView: (v: View) => void }) {
  const { orders, stock, purchasing, bills, money, activity } = d;
  return (
    <>
      {orders ? (
        <section className="card hero" aria-label="Orders at risk">
          <div>
            <div className="label">Order value at risk</div>
            <div className="value">{inrShort(orders.valueAtRiskPaise)}</div>
            <div className="sub">
              {orders.lateCount} late · {orders.atRiskCount} at risk · {orders.onTimeCount} on time
              {orders.shortItems.length ? ` · short of ${orders.shortItems.join(", ")}` : ""}
            </div>
          </div>
          <a className="btn" href="#/sales/orders">All orders</a>
        </section>
      ) : null}

      <div className="tiles">
        {orders ? <Tile label="Late orders" value={String(orders.lateCount)} note={`${orders.atRiskCount} more at risk`} href="#/sales/orders" /> : null}
        {purchasing ? <Tile label="Waiting for approval" value={String(purchasing.pendingApprovals.count)} note={inrShort(purchasing.pendingApprovals.totalPaise)} href="#/approvals" /> : null}
        {bills ? <Tile label="Bills on hold" value={String(bills.held.count)} note={bills.held.count ? `${inrShort(bills.held.totalPaise)} not payable yet` : `${bills.awaitingPostingCount} ready to post`} href="#/bills" /> : null}
        {money ? <Tile label="Customers owe, overdue" value={inrShort(money.receivables.overduePaise)} note={`of ${inrShort(money.receivables.outstandingPaise)} owed`} href="#/ageing" /> : null}
        {money ? <Tile label="You owe, overdue" value={inrShort(money.payables.overduePaise)} note={money.payables.msmeBreachedCount ? `${money.payables.msmeBreachedCount} past the MSME limit` : `of ${inrShort(money.payables.outstandingPaise)} owed`} href="#/ageing" /> : null}
        {purchasing ? <Tile label="On order" value={String(purchasing.onOrder.count)} note={purchasing.onOrder.overdueCount ? `${purchasing.onOrder.overdueCount} overdue` : inrShort(purchasing.onOrder.valuePaise)} href="#/purchasing/orders" /> : null}
        {stock ? <Tile label="Low stock" value={String(stock.lowStockCount)} note={stock.valuePaise !== undefined ? `Stock worth ${inrShort(stock.valuePaise)}` : "At or below reorder level"} href="#/stock" /> : null}
      </div>

      <div className="grid dash">
        <div className="grid">
          {orders ? (
            <Card title="Orders board" note="Open orders, worst first. An order is at risk when the stock left after earlier promises cannot cover it.">
              <DataTable
                rows={orders.board}
                rowKey={(r) => r.orderId}
                empty="No open orders."
                columns={[
                  { header: "Order", render: (r) => <><b>{r.number}</b><div className="sub-line">{r.customerName}</div></> },
                  { header: "Promised", render: (r) => date(r.promisedDate) },
                  { header: "Still to ship", align: "num", render: (r) => inrShort(r.remainingValuePaise) },
                  { header: "Status", render: (r) => <><Status value={r.status} /><div className="sub-line">{r.reason}</div></> },
                ]}
              />
            </Card>
          ) : null}

          {purchasing && purchasing.pendingApprovals.rows.length ? (
            <Card title="Waiting for your OK" note="Purchase orders above the requester's own approval limit." actions={<a className="btn small" href="#/approvals">Review all</a>}>
              <DataTable
                rows={purchasing.pendingApprovals.rows}
                rowKey={(r) => r.requestId}
                columns={[
                  { header: "Order", render: (r) => <><b>{r.docNumber}</b><div className="sub-line">{r.supplierName}</div></> },
                  { header: "Asked by", render: (r) => r.requestedByName },
                  { header: "Waiting on", render: (r) => r.assignedToName ?? "" },
                  { header: "Amount", align: "num", render: (r) => inr(r.amountPaise) },
                  { header: "", render: (r) => (r.canDecide ? <a className="btn small primary" href="#/approvals">Decide</a> : <span className="muted">Not yours</span>) },
                ]}
              />
            </Card>
          ) : null}

          {bills && bills.held.rows.length ? (
            <Card title="Bills on hold" note="Supplier bills that do not match the order and what was received." actions={<a className="btn small" href="#/bills">All bills</a>}>
              <DataTable
                rows={bills.held.rows}
                rowKey={(r) => r.billId}
                columns={[
                  { header: "Bill", render: (r) => <><b>{r.supplierBillNo}</b><div className="sub-line">{r.supplierName}</div></> },
                  { header: "Amount", align: "num", render: (r) => inr(r.totalPaise) },
                  { header: "Why it is held", render: (r) => <ul className="reasons" style={{ marginTop: 0 }}>{r.findings.map((f) => <li key={f.code}>{f.message}</li>)}</ul> },
                ]}
              />
            </Card>
          ) : null}
        </div>

        <div className="grid">
          {money ? (
            <>
              <Card title="Sales and purchases" note={`${money.financialYear.label} so far: sales ${inrShort(money.financialYear.salesPaise)}, purchases ${inrShort(money.financialYear.purchasesPaise)}`} actions={<ViewToggle value={trendView} onChange={setTrendView} />}>
                <TrendChart data={money.trend} view={trendView} />
              </Card>
              <Card title="Customers owe" note={`${inr(money.receivables.outstandingPaise)} in total${money.receivables.unappliedPaise ? `, plus ${inrShort(money.receivables.unappliedPaise)} received on account` : ""}`} actions={<ViewToggle value={recView} onChange={setRecView} />}>
                <AgeingBars buckets={money.receivables.buckets} color="var(--series-1)" noun="owed by customers" view={recView} />
              </Card>
              <Card title="You owe suppliers" note={`${inr(money.payables.outstandingPaise)} in total${money.payables.unappliedPaise ? `, less ${inrShort(money.payables.unappliedPaise)} paid on account` : ""}`} actions={<ViewToggle value={payView} onChange={setPayView} />}>
                <AgeingBars buckets={money.payables.buckets} color="var(--series-2)" noun="owed to suppliers" view={payView} />
              </Card>
            </>
          ) : null}

          {stock && stock.lowStock.length ? (
            <Card title="Low stock" note="At or below the reorder level, counting what is already on order." actions={<a className="btn small" href="#/stock">Stock</a>}>
              <DataTable
                rows={stock.lowStock}
                rowKey={(r) => r.sku}
                columns={[
                  { header: "Item", render: (r) => <><b>{r.sku}</b><div className="sub-line">{r.name}</div></> },
                  { header: "On hand", render: (r) => <><Meter value={Number(r.onHand)} max={Number(r.reorderLevel)} label={`${qty(r.onHand)} on hand, reorder level ${qty(r.reorderLevel)}`} /><div className="sub-line">{qty(r.onHand)} of {qty(r.reorderLevel)} {r.uom}</div></> },
                  { header: "Suggested order", align: "num", render: (r) => `${qty(r.suggestedQty)} ${r.uom}` },
                ]}
              />
            </Card>
          ) : null}

          {activity ? (
            <Card title="Recent activity">
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                {activity.map((a, i) => (
                  <li key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <span>{humanise(a.action)}<span className="muted"> · {a.actorName ?? "system"}</span></span>
                    <span className="muted" style={{ whiteSpace: "nowrap" }}>{dateTime(a.at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
