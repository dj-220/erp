import { useState, type ReactNode } from "react";
import { STATES } from "../../../src/domain/states";
import { get, post } from "../api";
import { useAuth } from "../auth";
import { Facts, FormShell, Grid, LineGrid, Modal, SelectField, TextArea, TextField, WithLookups, clean, go, newLine, useDocActions, useSubmit, type ItemRef, type Line, type LineColumn, type PartyRef } from "../forms";
import { date, inr, qty, rupees, today, trimDecimal } from "../format";
import { Alert, Card, DataTable, Loading, Page, Status, useLoad } from "../ui";
import type { BoardArea } from "./Plant";

const stateOptions = STATES.filter((s) => !s.legacy && s.code !== "97" && s.code !== "99").map((s) => [s.code, s.name] as [string, string]);

/* ---------------------------------------------------------------- New order */

const ORDER_COLS: LineColumn[] = [
  { key: "sku", label: "Item", kind: "sku", width: 230 },
  { key: "qty", label: "Quantity", kind: "num" },
  { key: "unitPrice", label: "Price (₹)", kind: "num", placeholder: "item price" },
  { key: "discountPct", label: "Discount %", kind: "num", placeholder: "0" },
  { key: "gstRate", label: "GST %", kind: "num", placeholder: "item rate" },
];

export function NewSalesOrder() {
  return <WithLookups>{({ parties, items }) => <OrderForm customers={parties.filter((p) => p.kind !== "supplier")} items={items.filter((i) => i.kind !== "raw_material" && i.kind !== "consumable")} />}</WithLookups>;
}

function OrderForm({ customers, items }: { customers: PartyRef[]; items: ItemRef[] }) {
  const [customerId, setCustomerId] = useState("");
  const [orderDate, setOrderDate] = useState(today());
  const [promisedDate, setPromisedDate] = useState(today(7));
  const [poRef, setPoRef] = useState("");
  const [shipTo, setShipTo] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine(ORDER_COLS)]);
  const { busy, error, run } = useSubmit();
  const customer = customers.find((c) => c.id === customerId);

  const save = () =>
    run(async () => {
      const made = await post<{ id: string }>("/api/sales/orders", {
        customerId,
        orderDate,
        promisedDate,
        ...(poRef.trim() ? { customerPoRef: poRef.trim() } : {}),
        ...(shipTo ? { shipToStateCode: shipTo } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines.filter((l) => l.sku).map(clean),
      });
      go(`/sales/orders/${made.id}`);
    });

  return (
    <Page title="New sales order" subtitle="It stays a draft until you confirm it. Confirming gives it a number and locks it.">
      <Card>
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save draft" onCancel={() => go("/sales/orders")}>
          <Grid>
            <SelectField id="so-cust" label="Customer" value={customerId} onChange={setCustomerId} options={customers.map((c) => [c.id, c.name] as [string, string])} blank="Choose customer" required />
            <TextField id="so-date" label="Order date" type="date" value={orderDate} onChange={setOrderDate} required />
            <TextField id="so-prom" label="Promised delivery" type="date" value={promisedDate} onChange={setPromisedDate} required hint="The dashboard flags the order as late after this date." />
            <TextField id="so-po" label="Customer's PO number" value={poRef} onChange={setPoRef} />
            <SelectField id="so-ship" label="Ship to state" value={shipTo} onChange={setShipTo} options={stateOptions} blank={customer ? `Same as customer (${customer.stateCode})` : "Same as customer"} hint="Decides CGST and SGST, or IGST." />
          </Grid>
          <LineGrid
            columns={ORDER_COLS}
            lines={lines}
            onChange={setLines}
            items={items}
            defaults={(i) => ({ unitPrice: i.salesPrice ? trimDecimal(i.salesPrice) : "", gstRate: trimDecimal(i.gstRate) })}
          />
          <TextArea id="so-notes" label="Notes" value={notes} onChange={setNotes} />
        </FormShell>
      </Card>
    </Page>
  );
}

/* ---------------------------------------------------------------- Order detail */

interface OLine { lineNo: number; sku: string; name: string; uom: string; isGoods: boolean; qty: string; unitPrice: string; discountPct: string; gstRate: string; delivered: string; invoiced: string; toDeliver: string; invoiceable: string; taxableValuePaise: number }
interface Order { id: string; number: string | null; state: string; orderDate: string; promisedDate: string; customerName: string; customerPoRef: string | null; shipToStateCode: string; notes: string | null; lines: OLine[]; taxableValuePaise: number }

export function SalesOrderDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const state = useLoad(() => get<Order>(`/api/sales/orders/${id}`), [id]);
  const { notice, busy, error, act } = useDocActions(state.reload);
  const [dialog, setDialog] = useState<"deliver" | "invoice" | null>(null);
  const o = state.data;
  const toDeliver = o?.lines.some((l) => Number(l.toDeliver) > 0) ?? false;
  const toInvoice = o?.lines.some((l) => Number(l.invoiceable) > 0) ?? false;
  const stateName = STATES.find((s) => s.code === o?.shipToStateCode)?.name;

  return (
    <Page
      title={o ? `Sales order ${o.number ?? "(draft)"}` : "Sales order"}
      subtitle={o?.customerName}
      actions={
        o ? (
          <>
            {o.state === "draft" && can("sales.write") ? (
              <>
                <button className="btn primary" disabled={busy} onClick={() => act("Order confirmed.", () => post(`/api/sales/orders/${id}/confirm`))}>Confirm order</button>
                <button className="btn" disabled={busy} onClick={() => act("Order cancelled.", () => post(`/api/sales/orders/${id}/cancel`))}>Cancel</button>
              </>
            ) : null}
            {o.state === "confirmed" ? (
              <>
                {can("sales.deliver") && toDeliver ? <button className="btn primary" onClick={() => setDialog("deliver")}>Deliver</button> : null}
                {can("sales.invoice") && toInvoice ? <button className="btn primary" onClick={() => setDialog("invoice")}>Create invoice</button> : null}
                {can("sales.write") ? <button className="btn" disabled={busy} onClick={() => act("Order closed.", () => post(`/api/sales/orders/${id}/close`))}>Close order</button> : null}
              </>
            ) : null}
          </>
        ) : null
      }
    >
      <p><a href="#/sales/orders">← All sales orders</a></p>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <Loading state={state}>
        {o ? (
          <div className="grid">
            <Card>
              <Facts items={[["Status", <Status value={o.state} />], ["Ordered", date(o.orderDate)], ["Promised", date(o.promisedDate)], ["Customer's PO", o.customerPoRef], ["Ship to", stateName ? `${stateName} (${o.shipToStateCode})` : o.shipToStateCode], ["Taxable value", inr(o.taxableValuePaise)], ["Notes", o.notes]]} />
            </Card>
            <Card title="Lines" note={o.state === "draft" ? "Prices and tax rates were fixed when you saved the draft." : undefined}>
              <DataTable
                rows={o.lines}
                rowKey={(l) => String(l.lineNo)}
                columns={[
                  { header: "#", render: (l) => l.lineNo },
                  { header: "Item", render: (l) => <><b>{l.sku}</b><div className="sub-line">{l.name}</div></> },
                  { header: "Ordered", align: "num", render: (l) => `${qty(l.qty)} ${l.uom}` },
                  { header: "Price", align: "num", render: (l) => rupees(l.unitPrice) },
                  { header: "Disc.", align: "num", render: (l) => (Number(l.discountPct) ? `${Number(l.discountPct)}%` : "") },
                  { header: "GST", align: "num", render: (l) => `${Number(l.gstRate)}%` },
                  { header: "Delivered", align: "num", render: (l) => (l.isGoods ? qty(l.delivered) : "–") },
                  { header: "Invoiced", align: "num", render: (l) => qty(l.invoiced) },
                  { header: "Value", align: "num", render: (l) => inr(l.taxableValuePaise) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </Loading>
      {dialog === "deliver" && o ? <DeliverDialog order={o} onClose={() => setDialog(null)} onDone={(m) => { setDialog(null); act(m, async () => undefined); }} /> : null}
      {dialog === "invoice" && o ? <InvoiceDialog order={o} onClose={() => setDialog(null)} /> : null}
    </Page>
  );
}

function DeliverDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (message: string) => void }) {
  const open = order.lines.filter((l) => Number(l.toDeliver) > 0);
  const [docDate, setDocDate] = useState(today());
  const [amounts, setAmounts] = useState<Record<number, string>>(Object.fromEntries(open.map((l) => [l.lineNo, trimDecimal(l.toDeliver)])));
  const { busy, error, run } = useSubmit();
  // Where the goods leave from: any area holding one of these items. Dispatch first, then finished goods.
  const board = useLoad(() => get<{ areas: BoardArea[] }>("/api/plant/board"), []);
  const skus = new Set(open.map((l) => l.sku));
  const holding = (board.data?.areas ?? []).filter((a) => a.items.some((i) => skus.has(i.sku) && Number(i.onHand) > 0));
  const preferred = holding.find((a) => a.kind === "dispatch") ?? holding.find((a) => a.kind === "finished") ?? holding[0];
  const [chosen, setChosen] = useState<string | null>(null);
  const fromArea = holding.find((a) => a.id === (chosen ?? preferred?.id));
  const save = () =>
    run(async () => {
      const lines = open.filter((l) => (amounts[l.lineNo] ?? "").trim() && Number(amounts[l.lineNo]) > 0).map((l) => ({ lineNo: l.lineNo, qty: (amounts[l.lineNo] as string).trim() }));
      if (lines.length === 0) throw new Error("Enter a quantity for at least one line");
      await post(`/api/sales/orders/${order.id}/deliver`, { docDate, lines, ...(fromArea ? { fromLocation: fromArea.locationName } : {}) });
      onDone("Delivered. Stock has been reduced.");
    });
  return (
    <Modal title="Deliver goods" onClose={onClose}>
      <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Deliver" onCancel={onClose}>
        <p className="muted" style={{ margin: 0 }}>This takes the goods out of stock now. If any line is short of stock, nothing is delivered.</p>
        <Grid>
          <TextField id="d-date" label="Delivery date" type="date" value={docDate} onChange={setDocDate} required />
          <SelectField
            id="d-from"
            label="Ship from"
            value={fromArea?.id ?? ""}
            onChange={setChosen}
            options={holding.map((a) => [a.id, a.name] as [string, string])}
            blank={holding.length ? undefined : "No area holds these items"}
            hint={fromArea ? fromArea.items.filter((i) => skus.has(i.sku)).map((i) => `${i.sku}: ${qty(i.onHand)} there`).join(", ") : undefined}
          />
        </Grid>
        <DataTable
          rows={open}
          rowKey={(l) => String(l.lineNo)}
          columns={[
            { header: "Item", render: (l) => <b>{l.sku}</b> },
            { header: "Still to deliver", align: "num", render: (l) => `${qty(l.toDeliver)} ${l.uom}` },
            { header: "Deliver now", render: (l) => <input className="input" style={{ textAlign: "right", maxWidth: 120 }} aria-label={`Deliver now, ${l.sku}`} inputMode="decimal" value={amounts[l.lineNo] ?? ""} onChange={(e) => setAmounts({ ...amounts, [l.lineNo]: e.target.value })} /> },
          ]}
        />
      </FormShell>
    </Modal>
  );
}

function InvoiceDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const open = order.lines.filter((l) => Number(l.invoiceable) > 0);
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [amounts, setAmounts] = useState<Record<number, string>>(Object.fromEntries(open.map((l) => [l.lineNo, trimDecimal(l.invoiceable)])));
  const { busy, error, run } = useSubmit();
  const save = () =>
    run(async () => {
      const lines = open.filter((l) => Number(amounts[l.lineNo] ?? 0) > 0).map((l) => ({ lineNo: l.lineNo, qty: (amounts[l.lineNo] as string).trim() }));
      if (lines.length === 0) throw new Error("Enter a quantity for at least one line");
      const made = await post<{ id: string }>(`/api/sales/orders/${order.id}/invoice`, { invoiceDate, lines });
      go(`/sales/invoices/${made.id}`);
    });
  return (
    <Modal title="Create invoice" onClose={onClose}>
      <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Create draft invoice" onCancel={onClose}>
        <p className="muted" style={{ margin: 0 }}>You can bill what has been delivered (and services). The invoice is a draft until you post it.</p>
        <TextField id="inv-date" label="Invoice date" type="date" value={invoiceDate} onChange={setInvoiceDate} required />
        <DataTable
          rows={open}
          rowKey={(l) => String(l.lineNo)}
          columns={[
            { header: "Item", render: (l) => <b>{l.sku}</b> },
            { header: "Can be billed", align: "num", render: (l) => `${qty(l.invoiceable)} ${l.uom}` },
            { header: "Bill now", render: (l) => <input className="input" style={{ textAlign: "right", maxWidth: 120 }} aria-label={`Bill now, ${l.sku}`} inputMode="decimal" value={amounts[l.lineNo] ?? ""} onChange={(e) => setAmounts({ ...amounts, [l.lineNo]: e.target.value })} /> },
          ]}
        />
      </FormShell>
    </Modal>
  );
}

/* ---------------------------------------------------------------- Invoice detail */

interface ILine { lineNo: number; sku: string; description: string | null; hsnSac: string; qty: string; unitPrice: string; discountPct: string; gstRate: string; taxableValuePaise: number; totalPaise: number }
interface Invoice {
  id: string; kind: string; number: string | null; state: string; invoiceDate: string; dueDate: string; customerName: string; customerGstin: string | null;
  supplyKind: string; reason: string | null; taxableValuePaise: number; cgstPaise: number; sgstPaise: number; utgstPaise: number; igstPaise: number; cessPaise: number; roundOffPaise: number; totalPaise: number; lines: ILine[];
}

const KIND_NAME: Record<string, string> = { tax_invoice: "Tax invoice", credit_note: "Credit note", debit_note: "Debit note" };

export function InvoiceDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const state = useLoad(() => get<Invoice>(`/api/sales/invoices/${id}`), [id]);
  const { notice, busy, error, act } = useDocActions(state.reload);
  const [note, setNote] = useState(false);
  const inv = state.data;
  const taxRows: [string, number][] = inv ? ([["CGST", inv.cgstPaise], ["SGST", inv.sgstPaise], ["UTGST", inv.utgstPaise], ["IGST", inv.igstPaise], ["Cess", inv.cessPaise], ["Round off", inv.roundOffPaise]] as [string, number][]).filter(([, v]) => v !== 0) : [];

  return (
    <Page
      title={inv ? `${KIND_NAME[inv.kind] ?? "Invoice"} ${inv.number ?? "(draft)"}` : "Invoice"}
      subtitle={inv?.customerName}
      actions={
        inv && can("sales.invoice") ? (
          <>
            {inv.state === "draft" ? (
              <>
                <button className="btn primary" disabled={busy} onClick={() => act("Posted. The invoice now has its number and cannot be edited.", () => post(`/api/sales/invoices/${id}/post`))}>Post invoice</button>
                <button className="btn" disabled={busy} onClick={() => act("Draft cancelled.", () => post(`/api/sales/invoices/${id}/cancel`))}>Cancel draft</button>
              </>
            ) : null}
            {inv.state === "posted" && inv.kind === "tax_invoice" ? <button className="btn" onClick={() => setNote(true)}>Credit or debit note</button> : null}
            {inv.state === "posted" && inv.kind !== "credit_note" && can("payment.write") ? <a className="btn" href="#/payments/new">Record receipt</a> : null}
          </>
        ) : null
      }
    >
      <p><a href="#/sales/invoices">← All invoices</a></p>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <Loading state={state}>
        {inv ? (
          <div className="grid">
            <Card>
              <Facts items={[["Status", <Status value={inv.state} />], ["Date", date(inv.invoiceDate)], ["Due", inv.kind === "credit_note" ? "" : date(inv.dueDate)], ["Customer GSTIN", inv.customerGstin], ["Supply", inv.supplyKind === "inter" ? "Between states (IGST)" : "Within the state (CGST + SGST)"], ["Reason", inv.reason]]} />
            </Card>
            <Card title="Lines">
              <DataTable
                rows={inv.lines}
                rowKey={(l) => String(l.lineNo)}
                columns={[
                  { header: "#", render: (l) => l.lineNo },
                  { header: "Item", render: (l) => <><b>{l.sku}</b><div className="sub-line">HSN/SAC {l.hsnSac}</div></> },
                  { header: "Quantity", align: "num", render: (l) => qty(l.qty) },
                  { header: "Price", align: "num", render: (l) => rupees(l.unitPrice) },
                  { header: "GST", align: "num", render: (l) => `${Number(l.gstRate)}%` },
                  { header: "Taxable", align: "num", render: (l) => inr(l.taxableValuePaise) },
                  { header: "Total", align: "num", render: (l) => inr(l.totalPaise) },
                ]}
              />
              <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 24px", margin: "16px 0 0", maxWidth: 320, marginLeft: "auto" }}>
                <dt className="muted">Taxable value</dt><dd style={{ margin: 0, textAlign: "right" }}>{inr(inv.taxableValuePaise)}</dd>
                {taxRows.map(([k, v]) => <Row key={k} k={k} v={inr(v)} />)}
                <dt><b>Total</b></dt><dd style={{ margin: 0, textAlign: "right" }}><b>{inr(inv.totalPaise)}</b></dd>
              </dl>
            </Card>
          </div>
        ) : null}
      </Loading>
      {note && inv ? <NoteDialog invoice={inv} onClose={() => setNote(false)} /> : null}
    </Page>
  );
}

const Row = ({ k, v }: { k: string; v: ReactNode }) => (
  <>
    <dt className="muted">{k}</dt>
    <dd style={{ margin: 0, textAlign: "right" }}>{v}</dd>
  </>
);

function NoteDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const [kind, setKind] = useState("credit_note");
  const [noteDate, setNoteDate] = useState(today());
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<Record<number, { qty: string; unitPrice: string }>>(Object.fromEntries(invoice.lines.map((l) => [l.lineNo, { qty: "", unitPrice: trimDecimal(l.unitPrice) }])));
  const { busy, error, run } = useSubmit();
  const save = () =>
    run(async () => {
      const lines = invoice.lines
        .filter((l) => (rows[l.lineNo]?.qty ?? "").trim() !== "")
        .map((l) => ({ invoiceLineNo: l.lineNo, qty: (rows[l.lineNo] as { qty: string }).qty.trim(), unitPrice: (rows[l.lineNo] as { unitPrice: string }).unitPrice.trim() }));
      if (lines.length === 0) throw new Error("Enter a quantity on at least one line");
      const made = await post<{ id: string }>(`/api/sales/invoices/${invoice.id}/notes`, { kind, noteDate, reason: reason.trim(), lines });
      go(`/sales/invoices/${made.id}`);
    });
  return (
    <Modal title="Credit or debit note" onClose={onClose} width={640}>
      <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Create draft note" onCancel={onClose}>
        <p className="muted" style={{ margin: 0 }}>A credit note reduces what the customer owes (goods returned, a price cut). A debit note increases it. Goods coming back into stock are recorded separately as a stock adjustment.</p>
        <Grid>
          <SelectField id="n-kind" label="Type" value={kind} onChange={setKind} options={[["credit_note", "Credit note"], ["debit_note", "Debit note"]]} />
          <TextField id="n-date" label="Date" type="date" value={noteDate} onChange={setNoteDate} required />
          <TextField id="n-reason" label="Reason" value={reason} onChange={setReason} required wide />
        </Grid>
        <DataTable
          rows={invoice.lines}
          rowKey={(l) => String(l.lineNo)}
          columns={[
            { header: "Item", render: (l) => <><b>{l.sku}</b><div className="sub-line">invoiced {qty(l.qty)}</div></> },
            { header: "Quantity", render: (l) => <input className="input" style={{ textAlign: "right", maxWidth: 110 }} aria-label={`Note quantity, ${l.sku}`} inputMode="decimal" value={rows[l.lineNo]?.qty ?? ""} onChange={(e) => setRows({ ...rows, [l.lineNo]: { qty: e.target.value, unitPrice: rows[l.lineNo]?.unitPrice ?? "" } })} /> },
            { header: "₹ per unit", render: (l) => <input className="input" style={{ textAlign: "right", maxWidth: 120 }} aria-label={`Note price, ${l.sku}`} inputMode="decimal" value={rows[l.lineNo]?.unitPrice ?? ""} onChange={(e) => setRows({ ...rows, [l.lineNo]: { qty: rows[l.lineNo]?.qty ?? "", unitPrice: e.target.value } })} /> },
          ]}
        />
      </FormShell>
    </Modal>
  );
}
