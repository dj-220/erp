import { useState } from "react";
import { get, post } from "../api";
import { useAuth } from "../auth";
import { Facts, FormShell, Grid, LineGrid, Modal, SelectField, TextArea, TextField, WithLookups, clean, go, newLine, useDocActions, useSubmit, type ItemRef, type Line, type LineColumn, type PartyRef, type WarehouseRef } from "../forms";
import { date, dateTime, inr, qty, rupees, today, trimDecimal } from "../format";
import { Alert, Card, DataTable, Loading, Page, Status, useLoad } from "../ui";

const hashQuery = (name: string): string | null => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get(name);

/* ---------------------------------------------------------------- Requests */

const REQUEST_COLS: LineColumn[] = [
  { key: "sku", label: "Item", kind: "sku", width: 240 },
  { key: "qty", label: "Quantity", kind: "num" },
  { key: "note", label: "Note", kind: "text" },
];

export function NewRequest() {
  return <WithLookups>{({ items }) => <RequestForm items={items} />}</WithLookups>;
}

function RequestForm({ items }: { items: ItemRef[] }) {
  const [requestDate, setRequestDate] = useState(today());
  const [neededBy, setNeededBy] = useState(today(14));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine(REQUEST_COLS)]);
  const { busy, error, run } = useSubmit();
  const save = () =>
    run(async () => {
      const made = await post<{ id: string }>("/api/purchasing/requests", { requestDate, neededBy, ...(notes.trim() ? { notes: notes.trim() } : {}), lines: lines.filter((l) => l.sku).map(clean) });
      go(`/purchasing/requests/${made.id}`);
    });
  return (
    <Page title="New purchase request" subtitle="Ask for something to be bought. A buyer turns it into an order.">
      <Card>
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save draft" onCancel={() => go("/purchasing/requests")}>
          <Grid>
            <TextField id="pr-date" label="Date" type="date" value={requestDate} onChange={setRequestDate} required />
            <TextField id="pr-need" label="Needed by" type="date" value={neededBy} onChange={setNeededBy} required />
          </Grid>
          <LineGrid columns={REQUEST_COLS} lines={lines} onChange={setLines} items={items.filter((i) => i.kind !== "service")} />
          <TextArea id="pr-notes" label="Notes" value={notes} onChange={setNotes} />
        </FormShell>
      </Card>
    </Page>
  );
}

interface RLine { id: string; sku: string; name: string; uom: string; qty: string; ordered: string; stillToOrder: string; note: string | null }
interface Request { id: string; number: string | null; state: string; requestDate: string; neededBy: string; notes: string | null; lines: RLine[] }

export function RequestDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const state = useLoad(() => get<Request>(`/api/purchasing/requests/${id}`), [id]);
  const { notice, busy, error, act } = useDocActions(state.reload);
  const r = state.data;
  const write = can("purchase.write");
  const openLines = r?.lines.some((l) => Number(l.stillToOrder) > 0) ?? false;
  return (
    <Page
      title={r ? `Purchase request ${r.number ?? "(draft)"}` : "Purchase request"}
      actions={
        r && write ? (
          <>
            {r.state === "draft" ? (
              <>
                <button className="btn primary" disabled={busy} onClick={() => act("Submitted. A buyer can now order it.", () => post(`/api/purchasing/requests/${id}/submit`))}>Submit</button>
                <button className="btn" disabled={busy} onClick={() => act("Cancelled.", () => post(`/api/purchasing/requests/${id}/cancel`))}>Cancel</button>
              </>
            ) : null}
            {r.state === "submitted" ? (
              <>
                {openLines ? <a className="btn primary" href={`#/purchasing/orders/new?request=${id}`}>Create purchase order</a> : null}
                <button className="btn" disabled={busy} onClick={() => act("Closed.", () => post(`/api/purchasing/requests/${id}/close`))}>Close</button>
              </>
            ) : null}
          </>
        ) : null
      }
    >
      <p><a href="#/purchasing/requests">← All requests</a></p>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <Loading state={state}>
        {r ? (
          <div className="grid">
            <Card><Facts items={[["Status", <Status value={r.state} />], ["Date", date(r.requestDate)], ["Needed by", date(r.neededBy)], ["Notes", r.notes]]} /></Card>
            <Card title="Lines">
              <DataTable
                rows={r.lines}
                rowKey={(l) => l.id}
                columns={[
                  { header: "Item", render: (l) => <><b>{l.sku}</b><div className="sub-line">{l.name}{l.note ? ` · ${l.note}` : ""}</div></> },
                  { header: "Asked", align: "num", render: (l) => `${qty(l.qty)} ${l.uom}` },
                  { header: "Ordered", align: "num", render: (l) => qty(l.ordered) },
                  { header: "Still to order", align: "num", render: (l) => qty(l.stillToOrder) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </Loading>
    </Page>
  );
}

/* ---------------------------------------------------------------- New purchase order */

const PO_COLS: LineColumn[] = [
  { key: "sku", label: "Item", kind: "sku", width: 230 },
  { key: "qty", label: "Quantity", kind: "num" },
  { key: "unitPrice", label: "Price (₹)", kind: "num", placeholder: "item price" },
  { key: "discountPct", label: "Discount %", kind: "num", placeholder: "0" },
  { key: "gstRate", label: "GST %", kind: "num", placeholder: "item rate" },
];

export function NewPurchaseOrder() {
  return <WithLookups>{({ parties, items, warehouses }) => <PoForm suppliers={parties.filter((p) => p.kind !== "customer")} items={items} warehouses={warehouses} />}</WithLookups>;
}

function PoForm({ suppliers, items, warehouses }: { suppliers: PartyRef[]; items: ItemRef[]; warehouses: WarehouseRef[] }) {
  const requestId = hashQuery("request");
  const request = useLoad(() => (requestId ? get<Request>(`/api/purchasing/requests/${requestId}`) : Promise.resolve(null)), [requestId]);
  return (
    <Loading state={request}>
      <PoFormBody
        suppliers={suppliers}
        items={items}
        warehouses={warehouses}
        fromRequest={request.data ?? null}
      />
    </Loading>
  );
}

function PoFormBody({ suppliers, items, warehouses, fromRequest }: { suppliers: PartyRef[]; items: ItemRef[]; warehouses: WarehouseRef[]; fromRequest: Request | null }) {
  const [supplierId, setSupplierId] = useState("");
  const [orderDate, setOrderDate] = useState(today());
  const [expectedDate, setExpectedDate] = useState(today(14));
  const [warehouse, setWarehouse] = useState(warehouses[0]?.code ?? "MAIN");
  const [supplierRef, setSupplierRef] = useState("");
  const [notes, setNotes] = useState("");
  const open = fromRequest?.lines.filter((l) => Number(l.stillToOrder) > 0) ?? [];
  const [lines, setLines] = useState<Line[]>(
    open.length ? open.map((l) => ({ sku: l.sku, qty: trimDecimal(l.stillToOrder), unitPrice: "", discountPct: "", gstRate: "", requestLineId: l.id })) : [newLine(PO_COLS)],
  );
  const { busy, error, run } = useSubmit();
  const supplier = suppliers.find((s) => s.id === supplierId);

  const save = () =>
    run(async () => {
      const made = await post<{ id: string }>("/api/purchasing/orders", {
        supplierId,
        orderDate,
        expectedDate,
        warehouseCode: warehouse,
        ...(supplierRef.trim() ? { supplierRef: supplierRef.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines.filter((l) => l.sku).map(clean),
      });
      go(`/purchasing/orders/${made.id}`);
    });

  return (
    <Page title="New purchase order" subtitle={fromRequest ? `From request ${fromRequest.number ?? ""}. Leave price and GST empty to use the item's.` : "It stays a draft until you submit it. Large orders then wait for approval."}>
      <Card>
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save draft" onCancel={() => go("/purchasing/orders")}>
          <Grid>
            <SelectField id="po-sup" label="Supplier" value={supplierId} onChange={setSupplierId} options={suppliers.map((s) => [s.id, s.name] as [string, string])} blank="Choose supplier" required hint={supplier ? `State ${supplier.stateCode}${supplier.gstin ? `, GSTIN ${supplier.gstin}` : ", no GSTIN"}` : undefined} />
            <TextField id="po-date" label="Order date" type="date" value={orderDate} onChange={setOrderDate} required />
            <TextField id="po-exp" label="Expected delivery" type="date" value={expectedDate} onChange={setExpectedDate} required />
            <SelectField id="po-wh" label="Deliver to" value={warehouse} onChange={setWarehouse} options={warehouses.map((w) => [w.code, w.name] as [string, string])} hint="Its state decides CGST and SGST, or IGST." />
            <TextField id="po-ref" label="Supplier's reference" value={supplierRef} onChange={setSupplierRef} />
          </Grid>
          <LineGrid
            columns={PO_COLS}
            lines={lines}
            onChange={setLines}
            items={items}
            defaults={(i) => ({ unitPrice: i.purchasePrice ? trimDecimal(i.purchasePrice) : "", gstRate: trimDecimal(i.gstRate) })}
          />
          <TextArea id="po-notes" label="Notes" value={notes} onChange={setNotes} />
        </FormShell>
      </Card>
    </Page>
  );
}

/* ---------------------------------------------------------------- Purchase order detail */

interface PLine { lineNo: number; sku: string; name: string; uom: string; qty: string; unitPrice: string; discountPct: string; gstRate: string; received: string; open: string; taxableValuePaise: number; totalPaise: number }
interface PO {
  id: string; number: string | null; state: string; orderDate: string; expectedDate: string; supplierName: string; supplierGstin: string | null; supplierRef: string | null;
  placeOfSupplyStateCode: string; supplyKind: string; taxableValuePaise: number; cgstPaise: number; sgstPaise: number; utgstPaise: number; igstPaise: number; cessPaise: number; roundOffPaise: number; totalPaise: number;
  approval: { state: string; assignedTo: string | null; decidedAt: string | null; comment: string | null; isAuto: boolean } | null;
  lines: PLine[];
}

export function PurchaseOrderDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const state = useLoad(() => get<PO>(`/api/purchasing/orders/${id}`), [id]);
  const { notice, busy, error, act } = useDocActions(state.reload);
  const [receive, setReceive] = useState(false);
  const o = state.data;
  const write = can("purchase.write");
  const toReceive = o?.lines.some((l) => Number(l.open) > 0) ?? false;
  const tax: [string, number][] = o ? ([["CGST", o.cgstPaise], ["SGST", o.sgstPaise], ["UTGST", o.utgstPaise], ["IGST", o.igstPaise], ["Cess", o.cessPaise], ["Round off", o.roundOffPaise]] as [string, number][]).filter(([, v]) => v !== 0) : [];

  return (
    <Page
      title={o ? `Purchase order ${o.number ?? "(draft)"}` : "Purchase order"}
      subtitle={o?.supplierName}
      actions={
        o ? (
          <>
            {o.state === "draft" && write ? (
              <>
                <button className="btn primary" disabled={busy} onClick={() => act("Submitted. It is approved at once if it is within your limit, otherwise it waits for someone with a higher one.", () => post(`/api/purchasing/orders/${id}/submit`))}>Submit for approval</button>
                <button className="btn" disabled={busy} onClick={() => act("Cancelled.", () => post(`/api/purchasing/orders/${id}/cancel`))}>Cancel</button>
              </>
            ) : null}
            {o.state === "approved" && write ? <button className="btn primary" disabled={busy} onClick={() => act("Marked as sent to the supplier.", () => post(`/api/purchasing/orders/${id}/send`))}>Mark as sent</button> : null}
            {(o.state === "approved" || o.state === "sent") && can("purchase.receive") && toReceive ? <button className="btn primary" onClick={() => setReceive(true)}>Receive goods</button> : null}
            {(o.state === "approved" || o.state === "sent" || o.state === "closed") && can("bill.write") ? <a className="btn" href={`#/bills/new?po=${id}`}>Enter supplier bill</a> : null}
            {(o.state === "approved" || o.state === "sent") && write ? <button className="btn" disabled={busy} onClick={() => act("Closed. Nothing more is expected.", () => post(`/api/purchasing/orders/${id}/close`))}>Close order</button> : null}
            {o.state === "pending_approval" && can("approval.view") ? <a className="btn" href="#/approvals">Go to approvals</a> : null}
          </>
        ) : null
      }
    >
      <p><a href="#/purchasing/orders">← All purchase orders</a></p>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <Loading state={state}>
        {o ? (
          <div className="grid">
            <Card>
              <Facts items={[["Status", <Status value={o.state} />], ["Ordered", date(o.orderDate)], ["Expected", date(o.expectedDate)], ["Supplier GSTIN", o.supplierGstin], ["Supply", o.supplyKind === "inter" ? "Between states (IGST)" : "Within the state (CGST + SGST)"], ["Supplier's ref", o.supplierRef], ["Approval", o.approval ? `${o.approval.isAuto ? "Within own limit" : o.approval.state}${o.approval.decidedAt ? `, ${dateTime(o.approval.decidedAt)}` : ""}` : null]]} />
            </Card>
            <Card title="Lines">
              <DataTable
                rows={o.lines}
                rowKey={(l) => String(l.lineNo)}
                columns={[
                  { header: "#", render: (l) => l.lineNo },
                  { header: "Item", render: (l) => <><b>{l.sku}</b><div className="sub-line">{l.name}</div></> },
                  { header: "Ordered", align: "num", render: (l) => `${qty(l.qty)} ${l.uom}` },
                  { header: "Price", align: "num", render: (l) => rupees(l.unitPrice) },
                  { header: "GST", align: "num", render: (l) => `${Number(l.gstRate)}%` },
                  { header: "Received", align: "num", render: (l) => qty(l.received) },
                  { header: "Taxable", align: "num", render: (l) => inr(l.taxableValuePaise) },
                  { header: "Total", align: "num", render: (l) => inr(l.totalPaise) },
                ]}
              />
              <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 24px", margin: "16px 0 0", maxWidth: 320, marginLeft: "auto" }}>
                <dt className="muted">Taxable value</dt><dd style={{ margin: 0, textAlign: "right" }}>{inr(o.taxableValuePaise)}</dd>
                {tax.map(([k, v]) => (<><dt key={`${k}-k`} className="muted">{k}</dt><dd key={`${k}-v`} style={{ margin: 0, textAlign: "right" }}>{inr(v)}</dd></>))}
                <dt><b>Total</b></dt><dd style={{ margin: 0, textAlign: "right" }}><b>{inr(o.totalPaise)}</b></dd>
              </dl>
            </Card>
          </div>
        ) : null}
      </Loading>
      {receive && o ? <ReceiveDialog order={o} onClose={() => setReceive(false)} onDone={() => { setReceive(false); act("Goods received. Stock has gone up.", async () => undefined); }} /> : null}
    </Page>
  );
}

function ReceiveDialog({ order, onClose, onDone }: { order: PO; onClose: () => void; onDone: () => void }) {
  const open = order.lines.filter((l) => Number(l.open) > 0);
  const [docDate, setDocDate] = useState(today());
  const [challan, setChallan] = useState("");
  const [amounts, setAmounts] = useState<Record<number, string>>(Object.fromEntries(open.map((l) => [l.lineNo, trimDecimal(l.open)])));
  const { busy, error, run } = useSubmit();
  const save = () =>
    run(async () => {
      const lines = open.filter((l) => Number(amounts[l.lineNo] ?? 0) > 0).map((l) => ({ lineNo: l.lineNo, qty: (amounts[l.lineNo] as string).trim() }));
      if (lines.length === 0) throw new Error("Enter a quantity for at least one line");
      await post(`/api/purchasing/orders/${order.id}/receive`, { docDate, ...(challan.trim() ? { supplierChallanRef: challan.trim() } : {}), lines });
      onDone();
    });
  return (
    <Modal title="Receive goods" onClose={onClose}>
      <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Receive" onCancel={onClose}>
        <p className="muted" style={{ margin: 0 }}>Record what actually arrived. Stock goes up now, valued at the order price.</p>
        <Grid>
          <TextField id="r-date" label="Received on" type="date" value={docDate} onChange={setDocDate} required />
          <TextField id="r-ch" label="Supplier's challan number" value={challan} onChange={setChallan} />
        </Grid>
        <DataTable
          rows={open}
          rowKey={(l) => String(l.lineNo)}
          columns={[
            { header: "Item", render: (l) => <b>{l.sku}</b> },
            { header: "Still expected", align: "num", render: (l) => `${qty(l.open)} ${l.uom}` },
            { header: "Received now", render: (l) => <input className="input" style={{ textAlign: "right", maxWidth: 120 }} aria-label={`Received now, ${l.sku}`} inputMode="decimal" value={amounts[l.lineNo] ?? ""} onChange={(e) => setAmounts({ ...amounts, [l.lineNo]: e.target.value })} /> },
          ]}
        />
      </FormShell>
    </Modal>
  );
}
