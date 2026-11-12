import { useEffect, useState, type ReactNode } from "react";
import { get } from "../api";
import { useAuth } from "../auth";
import { date, dateTime, humanise, inr, rupees } from "../format";
import { Card, DataTable, Loading, Page, Status, useLoad, type Column } from "../ui";

interface Paged<T> {
  rows: T[];
  total: number;
}

interface Filter {
  param: string;
  label: string;
  options: [value: string, label: string][];
}

const PAGE = 25;

/** A searchable, filterable, paged list of one kind of record. */
export function ListPage<T>({
  title,
  subtitle,
  path,
  columns,
  rowKey,
  filters = [],
  searchable = true,
  empty,
  actions,
}: {
  title: string;
  subtitle?: string;
  path: string;
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  filters?: Filter[];
  searchable?: boolean;
  empty?: string;
  actions?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setApplied(q.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const state = useLoad(() => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (applied) params.set("q", applied);
    for (const [k, v] of Object.entries(chosen)) if (v) params.set(k, v);
    return get<Paged<T>>(`${path}?${params}`);
  }, [path, applied, offset, JSON.stringify(chosen)]);

  const total = state.data?.total ?? 0;
  return (
    <Page title={title} subtitle={subtitle} actions={actions}>
      <div className="filters" role="search">
        {searchable ? <input className="input" type="search" placeholder="Search" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} /> : null}
        {filters.map((f) => (
          <select key={f.param} className="input" aria-label={f.label} value={chosen[f.param] ?? ""} onChange={(e) => { setChosen({ ...chosen, [f.param]: e.target.value }); setOffset(0); }}>
            <option value="">{f.label}: all</option>
            {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ))}
      </div>
      <Card>
        <Loading state={state}>
          <DataTable rows={state.data?.rows ?? []} columns={columns} rowKey={rowKey} empty={empty ?? "Nothing matches."} />
          <div className="pager">
            <span>{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : "No results"}</span>
            <span className="actions">
              <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
              <button className="btn small" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </span>
          </div>
        </Loading>
      </Card>
    </Page>
  );
}

/** A "New ..." button, shown only to people whose role may create the thing. */
function NewButton({ href, needs, children }: { href: string; needs: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(needs) ? <a className="btn primary" href={href}>{children}</a> : null;
}

const link = (href: string, text: ReactNode) => <a href={href}>{text}</a>;

const states = (...v: string[]): [string, string][] => v.map((s) => [s, s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())]);

interface SalesOrder { id: string; number: string | null; state: string; customerName: string; orderDate: string; promisedDate: string; lineCount: number; taxableValuePaise: number; customerPoRef: string | null }
export const SalesOrders = () => (
  <ListPage<SalesOrder>
    title="Sales orders"
    subtitle="Customer orders, from draft to delivered."
    path="/api/sales/orders"
    actions={<NewButton href="#/sales/orders/new" needs="sales.write">New sales order</NewButton>}
    rowKey={(r) => r.id}
    filters={[{ param: "state", label: "Status", options: states("draft", "confirmed", "closed", "cancelled") }]}
    columns={[
      { header: "Order", render: (r) => link(`#/sales/orders/${r.id}`, <b>{r.number ?? "Draft"}</b>) },
      { header: "Customer", render: (r) => <>{r.customerName}{r.customerPoRef ? <div className="sub-line">PO {r.customerPoRef}</div> : null}</> },
      { header: "Ordered", nowrap: true, render: (r) => date(r.orderDate) },
      { header: "Promised", nowrap: true, render: (r) => date(r.promisedDate) },
      { header: "Lines", align: "num", render: (r) => r.lineCount },
      { header: "Taxable value", align: "num", render: (r) => inr(r.taxableValuePaise) },
      { header: "Status", render: (r) => <Status value={r.state} /> },
    ]}
  />
);

interface Invoice { id: string; kind: string; number: string | null; state: string; invoiceDate: string; dueDate: string; customerName: string; totalPaise: number; outstandingPaise: number | null }
export const SalesInvoices = () => (
  <ListPage<Invoice>
    title="Invoices"
    subtitle="GST tax invoices, credit notes and debit notes."
    path="/api/sales/invoices"
    rowKey={(r) => r.id}
    filters={[
      { param: "kind", label: "Type", options: [["tax_invoice", "Tax invoice"], ["credit_note", "Credit note"], ["debit_note", "Debit note"]] },
      { param: "state", label: "Status", options: states("draft", "posted", "cancelled") },
    ]}
    columns={[
      { header: "Number", render: (r) => <>{link(`#/sales/invoices/${r.id}`, <b>{r.number ?? "Draft"}</b>)}<div className="sub-line">{r.kind.replace("_", " ")}</div></> },
      { header: "Customer", render: (r) => r.customerName },
      { header: "Date", nowrap: true, render: (r) => date(r.invoiceDate) },
      { header: "Due", nowrap: true, render: (r) => (r.kind === "credit_note" ? "" : date(r.dueDate)) },
      { header: "Total", align: "num", render: (r) => (r.kind === "credit_note" ? `−${inr(r.totalPaise)}` : inr(r.totalPaise)) },
      { header: "Still owed", align: "num", render: (r) => (r.outstandingPaise === null ? "" : inr(Math.max(r.outstandingPaise, 0))) },
      { header: "Status", render: (r) => <Status value={r.state} /> },
    ]}
  />
);

interface PurchaseOrder { id: string; number: string | null; state: string; supplierName: string; orderDate: string; expectedDate: string; totalPaise: number; receivedPercent: number }
export const PurchaseOrders = () => (
  <ListPage<PurchaseOrder>
    title="Purchase orders"
    subtitle="Orders to suppliers, with approval and how much has arrived."
    path="/api/purchasing/orders"
    actions={<NewButton href="#/purchasing/orders/new" needs="purchase.write">New purchase order</NewButton>}
    rowKey={(r) => r.id}
    filters={[{ param: "state", label: "Status", options: states("draft", "pending_approval", "approved", "sent", "rejected", "closed", "cancelled") }]}
    columns={[
      { header: "Order", render: (r) => link(`#/purchasing/orders/${r.id}`, <b>{r.number ?? "Draft"}</b>) },
      { header: "Supplier", render: (r) => r.supplierName },
      { header: "Ordered", nowrap: true, render: (r) => date(r.orderDate) },
      { header: "Expected", nowrap: true, render: (r) => date(r.expectedDate) },
      { header: "Total", align: "num", render: (r) => inr(r.totalPaise) },
      { header: "Received", align: "num", render: (r) => `${r.receivedPercent}%` },
      { header: "Status", render: (r) => <Status value={r.state} /> },
    ]}
  />
);

interface Request { id: string; number: string | null; state: string; requestDate: string; neededBy: string; requestedByName: string; lineCount: number }
export const PurchaseRequests = () => (
  <ListPage<Request>
    title="Purchase requests"
    subtitle="Internal requests to buy, often raised from shortages or reorder levels."
    path="/api/purchasing/requests"
    actions={<NewButton href="#/purchasing/requests/new" needs="purchase.write">New request</NewButton>}
    searchable={false}
    rowKey={(r) => r.id}
    filters={[{ param: "state", label: "Status", options: states("draft", "submitted", "closed", "cancelled") }]}
    columns={[
      { header: "Request", render: (r) => link(`#/purchasing/requests/${r.id}`, <b>{r.number ?? "Draft"}</b>) },
      { header: "Asked by", render: (r) => r.requestedByName },
      { header: "Date", nowrap: true, render: (r) => date(r.requestDate) },
      { header: "Needed by", nowrap: true, render: (r) => date(r.neededBy) },
      { header: "Lines", align: "num", render: (r) => r.lineCount },
      { header: "Status", render: (r) => <Status value={r.state} /> },
    ]}
  />
);

interface StockDoc { id: string; number: string | null; docType: string; state: string; docDate: string; partyName: string | null; reference: string | null; lineCount: number; valuePaise: number | null }
export const StockDocuments = () => (
  <ListPage<StockDoc>
    title="Stock movements"
    subtitle="Goods receipts, deliveries, transfers and adjustments."
    path="/api/stock/documents"
    actions={<NewButton href="#/stock/movements/new" needs="stock.write">New stock movement</NewButton>}
    searchable={false}
    rowKey={(r) => r.id}
    filters={[
      { param: "docType", label: "Type", options: [["goods_receipt", "Goods receipt"], ["delivery", "Delivery"], ["transfer", "Transfer"], ["adjustment", "Adjustment"]] },
      { param: "state", label: "Status", options: states("draft", "done", "cancelled") },
    ]}
    columns={[
      { header: "Document", render: (r) => <>{link(`#/stock/documents/${r.id}`, <b>{r.number ?? "Draft"}</b>)}<div className="sub-line">{r.docType.replace("_", " ")}</div></> },
      { header: "Date", nowrap: true, render: (r) => date(r.docDate) },
      { header: "Party", render: (r) => <>{r.partyName ?? ""}{r.reference ? <div className="sub-line">{r.reference}</div> : null}</> },
      { header: "Lines", align: "num", render: (r) => r.lineCount },
      { header: "Value", align: "num", render: (r) => (r.valuePaise === null ? "" : inr(r.valuePaise)) },
      { header: "Status", render: (r) => <Status value={r.state} /> },
    ]}
  />
);

interface Payment { id: string; number: string; direction: string; partyName: string; paymentDate: string; amountPaise: number; mode: string; reference: string | null; state: string; allocatedPaise: number }
export const Payments = () => (
  <ListPage<Payment>
    title="Payments and receipts"
    subtitle="Money paid to suppliers and received from customers."
    path="/api/payments"
    actions={<NewButton href="#/payments/new" needs="payment.write">Record payment or receipt</NewButton>}
    searchable={false}
    rowKey={(r) => r.id}
    filters={[{ param: "direction", label: "Direction", options: [["paid", "Paid out"], ["received", "Received"]] }]}
    columns={[
      { header: "Number", render: (r) => link(`#/payments/${r.id}`, <b>{r.number}</b>) },
      { header: "Party", render: (r) => <>{r.partyName}<div className="sub-line">{r.direction === "paid" ? "Paid out" : "Received"} · {r.mode}{r.reference ? ` · ${r.reference}` : ""}</div></> },
      { header: "Date", nowrap: true, render: (r) => date(r.paymentDate) },
      { header: "Amount", align: "num", render: (r) => inr(r.amountPaise) },
      { header: "On account", align: "num", render: (r) => (r.state === "posted" && r.amountPaise > r.allocatedPaise ? inr(r.amountPaise - r.allocatedPaise) : "") },
      { header: "Status", render: (r) => <Status value={r.state === "posted" ? (r.direction === "paid" ? "paid" : "received") : r.state} /> },
    ]}
  />
);

interface Party { id: string; name: string; kind: string; gstin: string | null; stateCode: string; registrationType: string; creditDays: number; isMsme: boolean; isActive: boolean }
export const Parties = () => (
  <ListPage<Party>
    title="Customers and suppliers"
    path="/api/parties"
    actions={<NewButton href="#/parties/new" needs="party.write">New customer or supplier</NewButton>}
    rowKey={(r) => r.id}
    filters={[{ param: "kind", label: "Type", options: [["customer", "Customers"], ["supplier", "Suppliers"]] }]}
    columns={[
      { header: "Name", render: (r) => <b>{r.name}</b> },
      { header: "Type", render: (r) => r.kind },
      { header: "GSTIN", render: (r) => r.gstin ?? <span className="muted">{r.registrationType}</span> },
      { header: "State", render: (r) => r.stateCode },
      { header: "Credit days", align: "num", render: (r) => r.creditDays },
      { header: "", render: (r) => (r.isMsme ? <span className="chip neutral">MSME</span> : null) },
    ]}
  />
);

interface Item { id: string; sku: string; name: string; kind: string; hsnSac: string | null; gstRate: string; uom: string; salesPrice: string | null; purchasePrice: string | null; isActive: boolean }
export const Items = () => (
  <ListPage<Item>
    title="Items"
    path="/api/items"
    actions={<NewButton href="#/items/new" needs="item.write">New item</NewButton>}
    rowKey={(r) => r.id}
    columns={[
      { header: "SKU", render: (r) => <b>{r.sku}</b> },
      { header: "Name", render: (r) => r.name },
      { header: "Kind", render: (r) => r.kind.replace("_", " ") },
      { header: "HSN / SAC", render: (r) => r.hsnSac ?? "" },
      { header: "GST", align: "num", render: (r) => `${Number(r.gstRate)}%` },
      { header: "Unit", render: (r) => r.uom },
      { header: "Sales price", align: "num", render: (r) => rupees(r.salesPrice) },
      { header: "Purchase price", align: "num", render: (r) => rupees(r.purchasePrice) },
    ]}
  />
);

interface AuditRow { id: string; at: string; actorName: string | null; action: string; entityType: string; entityId: string }
export const AuditLog = () => (
  <ListPage<AuditRow>
    title="Audit trail"
    subtitle="Every change, who made it and when. Entries cannot be edited or removed."
    path="/api/audit"
    searchable={false}
    rowKey={(r) => r.id}
    columns={[
      { header: "When", nowrap: true, render: (r) => dateTime(r.at) },
      { header: "Who", render: (r) => r.actorName ?? <span className="muted">system</span> },
      { header: "What", render: (r) => humanise(r.action) },
      { header: "Record", render: (r) => <>{humanise(r.entityType)}<div className="sub-line">{r.entityId.slice(0, 8)}</div></> },
    ]}
  />
);
