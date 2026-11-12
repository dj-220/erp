import { useState } from "react";
import { get, post } from "../api";
import { useAuth } from "../auth";
import { Facts, FormShell, Grid, LineGrid, SelectField, TextArea, TextField, WithLookups, go, useDocActions, useSubmit, type Line, type LineColumn, type PartyRef } from "../forms";
import { date, inr, paiseToText, today, trimDecimal } from "../format";
import { Alert, Card, DataTable, Loading, Page, ReasonDialog, Status, useLoad } from "../ui";

const hashQuery = (name: string): string | null => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get(name);

/* ---------------------------------------------------------------- New supplier bill */

interface PoRow { id: string; number: string | null; state: string; supplierName: string; totalPaise: number }
interface PoLine { lineNo: number; sku: string; qty: string; received: string; unitPrice: string; discountPct: string; gstRate: string }
interface PoDetail { id: string; number: string | null; supplierName: string; supplierGstin: string | null; lines: PoLine[] }

const BILL_COLS: LineColumn[] = [
  { key: "poLineNo", label: "Order line", kind: "text", width: 90 },
  { key: "sku", label: "Item", kind: "text", width: 160 },
  { key: "qty", label: "Quantity billed", kind: "num" },
  { key: "unitPrice", label: "Price (₹)", kind: "num" },
  { key: "discountPct", label: "Discount %", kind: "num", placeholder: "0" },
  { key: "gstRate", label: "GST %", kind: "num" },
];

export function NewBill() {
  const orders = useLoad(() => get<{ rows: PoRow[] }>("/api/purchasing/orders?limit=200"), []);
  return (
    <Page title="Enter supplier bill" subtitle="Type in a bill you received. It is matched to the order and to what arrived; anything that does not match is held for review.">
      <Loading state={orders}>
        <BillForm orders={(orders.data?.rows ?? []).filter((o) => ["approved", "sent", "closed"].includes(o.state))} />
      </Loading>
    </Page>
  );
}

function BillForm({ orders }: { orders: PoRow[] }) {
  const [poId, setPoId] = useState(hashQuery("po") ?? "");
  const po = useLoad(() => (poId ? get<PoDetail>(`/api/purchasing/orders/${poId}`) : Promise.resolve(null)), [poId]);
  return (
    <Card>
      <SelectField
        id="bill-po"
        label="Purchase order"
        value={poId}
        onChange={setPoId}
        options={orders.map((o) => [o.id, `${o.number} · ${o.supplierName}`] as [string, string])}
        blank="Choose the order this bill is for"
        hint="Bills are matched against an approved order. Only approved, sent or closed orders are listed."
      />
      <Loading state={po}>{po.data ? <BillBody key={po.data.id} po={po.data} /> : null}</Loading>
    </Card>
  );
}

function BillBody({ po }: { po: PoDetail }) {
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState(today());
  const [gstin, setGstin] = useState("");
  const [notes, setNotes] = useState("");
  const [stated, setStated] = useState({ taxable: "", cgst: "", sgst: "", igst: "", cess: "", roundOff: "", total: "" });
  const [lines, setLines] = useState<Line[]>(
    po.lines.map((l) => ({ poLineNo: String(l.lineNo), sku: l.sku, qty: trimDecimal(Number(l.received) > 0 ? l.received : l.qty), unitPrice: trimDecimal(l.unitPrice), discountPct: Number(l.discountPct) ? trimDecimal(l.discountPct) : "", gstRate: trimDecimal(l.gstRate) })),
  );
  const { busy, error, run } = useSubmit();
  const setS = (k: keyof typeof stated) => (v: string) => setStated({ ...stated, [k]: v });

  const save = () =>
    run(async () => {
      const filled = Object.fromEntries(Object.entries(stated).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
      await post("/api/bills", {
        purchaseOrderId: po.id,
        supplierBillNo: billNo.trim(),
        billDate,
        ...(gstin.trim() ? { supplierGstin: gstin.trim().toUpperCase() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(Object.keys(filled).length ? { stated: filled } : {}),
        lines: lines.filter((l) => (l.qty ?? "").trim()).map((l) => ({
          poLineNo: Number(l.poLineNo),
          qty: (l.qty ?? "").trim(),
          unitPrice: (l.unitPrice ?? "").trim(),
          gstRate: (l.gstRate ?? "").trim(),
          ...(l.discountPct?.trim() ? { discountPct: l.discountPct.trim() } : {}),
        })),
      });
      go("/bills");
    });

  return (
    <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save bill" onCancel={() => go("/bills")}>
      <Grid>
        <TextField id="bill-no" label="Supplier's bill number" value={billNo} onChange={setBillNo} required />
        <TextField id="bill-date" label="Bill date" type="date" value={billDate} onChange={setBillDate} required hint="The due date comes from the supplier's credit days." />
        <TextField id="bill-gstin" label="Supplier GSTIN on the bill" value={gstin} onChange={setGstin} hint={`Exactly as printed. Leave empty if the bill has none (the match will hold it). Order's supplier: ${po.supplierGstin ?? "no GSTIN"}.`} />
      </Grid>
      <LineGrid columns={BILL_COLS} lines={lines} onChange={setLines} items={[]} addLabel="Add line" />
      <p className="muted" style={{ margin: 0 }}>Order line numbers must be ones on the order. Quantity defaults to what was received; change it to what the bill says.</p>
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Totals printed on the bill (optional, recommended)</summary>
        <p className="muted">If you enter them, the match checks them against the lines, so a keying slip or a supplier arithmetic error is caught.</p>
        <Grid>
          <TextField id="st-taxable" label="Taxable value (₹)" value={stated.taxable} onChange={setS("taxable")} inputMode="decimal" />
          <TextField id="st-cgst" label="CGST (₹)" value={stated.cgst} onChange={setS("cgst")} inputMode="decimal" />
          <TextField id="st-sgst" label="SGST (₹)" value={stated.sgst} onChange={setS("sgst")} inputMode="decimal" />
          <TextField id="st-igst" label="IGST (₹)" value={stated.igst} onChange={setS("igst")} inputMode="decimal" />
          <TextField id="st-cess" label="Cess (₹)" value={stated.cess} onChange={setS("cess")} inputMode="decimal" />
          <TextField id="st-round" label="Round off (₹)" value={stated.roundOff} onChange={setS("roundOff")} inputMode="decimal" />
          <TextField id="st-total" label="Bill total (₹)" value={stated.total} onChange={setS("total")} inputMode="decimal" />
        </Grid>
      </details>
      <TextArea id="bill-notes" label="Notes" value={notes} onChange={setNotes} />
    </FormShell>
  );
}

/* ---------------------------------------------------------------- Record a payment or receipt */

interface AgeDoc { docId: string; number: string; docDate: string; dueDate: string; outstandingPaise: number }
interface AgeParty { partyId: string; name: string; docs: AgeDoc[] }

export function NewPayment() {
  return <WithLookups>{({ parties }) => <PaymentForm parties={parties} />}</WithLookups>;
}

function PaymentForm({ parties }: { parties: PartyRef[] }) {
  const [direction, setDirection] = useState(hashQuery("direction") === "paid" ? "paid" : "received");
  const [partyId, setPartyId] = useState("");
  const [paymentDate, setPaymentDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("bank");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [apply, setApply] = useState<Record<string, string>>({});
  const { busy, error, run } = useSubmit();
  const [warnings, setWarnings] = useState<string[]>([]);

  const report = useLoad(() => get<{ parties: AgeParty[] }>(`/api/reports/${direction === "paid" ? "payables" : "receivables"}-ageing`).catch(() => null), [direction]);
  const open = report.data?.parties.find((p) => p.partyId === partyId)?.docs.filter((d) => d.outstandingPaise > 0) ?? [];
  const choices = parties.filter((p) => (direction === "paid" ? p.kind !== "customer" : p.kind !== "supplier"));

  const save = () =>
    run(async () => {
      const allocations = Object.entries(apply).filter(([, v]) => v.trim() !== "").map(([docId, v]) => ({ docId, amount: v.trim() }));
      const made = await post<{ id: string; warnings?: string[] }>("/api/payments", {
        direction,
        partyId,
        paymentDate,
        amount: amount.trim(),
        mode,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        allocations,
      });
      if (made.warnings?.length) {
        setWarnings(made.warnings);
        setTimeout(() => go(`/payments/${made.id}`), 2500);
      } else go(`/payments/${made.id}`);
    });

  return (
    <Page title={direction === "paid" ? "Record a payment to a supplier" : "Record a receipt from a customer"} subtitle="Payments are facts: once saved they are never edited, only reversed.">
      <Card>
        {warnings.length ? <Alert kind="warn">{warnings.join(" ")}</Alert> : null}
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save" onCancel={() => go("/payments")}>
          <Grid>
            <SelectField id="pay-dir" label="Direction" value={direction} onChange={(v) => { setDirection(v); setPartyId(""); setApply({}); }} options={[["received", "Received from a customer"], ["paid", "Paid to a supplier"]]} />
            <SelectField id="pay-party" label={direction === "paid" ? "Supplier" : "Customer"} value={partyId} onChange={(v) => { setPartyId(v); setApply({}); }} options={choices.map((p) => [p.id, p.name] as [string, string])} blank="Choose" required />
            <TextField id="pay-date" label="Date" type="date" value={paymentDate} onChange={setPaymentDate} required />
            <TextField id="pay-amt" label="Amount (₹)" value={amount} onChange={setAmount} inputMode="decimal" required />
            <SelectField id="pay-mode" label="Mode" value={mode} onChange={setMode} options={[["bank", "Bank transfer"], ["upi", "UPI"], ["cheque", "Cheque"], ["cash", "Cash"], ["card", "Card"], ["other", "Other"]]} hint="Large cash amounts are flagged." />
            <TextField id="pay-ref" label="Reference" value={reference} onChange={setReference} hint="Cheque number, UTR or bank reference." />
          </Grid>
          {partyId ? (
            <div>
              <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>{direction === "paid" ? "Bills this settles" : "Invoices this settles"}</h3>
              <p className="muted" style={{ margin: "0 0 8px" }}>Optional. Whatever you do not apply stays "on account" and can be applied later.</p>
              {report.data === null && !report.loading ? (
                <p className="muted">Your role cannot see open balances; the payment will be saved on account.</p>
              ) : (
                <DataTable
                  rows={open}
                  rowKey={(d) => d.docId}
                  empty="Nothing is outstanding for this party."
                  columns={[
                    { header: "Document", render: (d) => <><b>{d.number}</b><div className="sub-line">due {date(d.dueDate)}</div></> },
                    { header: "Outstanding", align: "num", render: (d) => inr(d.outstandingPaise) },
                    {
                      header: "Apply (₹)",
                      render: (d) => (
                        <span className="actions">
                          <input className="input" style={{ textAlign: "right", maxWidth: 130 }} aria-label={`Apply to ${d.number}`} inputMode="decimal" value={apply[d.docId] ?? ""} onChange={(e) => setApply({ ...apply, [d.docId]: e.target.value })} />
                          <button type="button" className="btn small ghost" onClick={() => setApply({ ...apply, [d.docId]: paiseToText(d.outstandingPaise) })}>All</button>
                        </span>
                      ),
                    },
                  ]}
                />
              )}
            </div>
          ) : null}
          <TextArea id="pay-notes" label="Notes" value={notes} onChange={setNotes} />
        </FormShell>
      </Card>
    </Page>
  );
}

/* ---------------------------------------------------------------- Payment detail */

interface Allocation { id: string; docNumber: string | null; docType: string; amountPaise: number }
interface PaymentFull {
  id: string; number: string; direction: string; partyId: string; paymentDate: string; amountPaise: number; mode: string; reference: string | null; notes: string | null; state: string;
  reverseReason: string | null; allocations: Allocation[]; allocatedPaise: number; unallocatedPaise: number;
}

export function PaymentDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const state = useLoad(() => get<PaymentFull>(`/api/payments/${id}`), [id]);
  const { notice, setNotice } = useDocActions(state.reload);
  const [dialog, setDialog] = useState<"reverse" | null>(null);
  const p = state.data;
  return (
    <Page
      title={p ? `${p.direction === "paid" ? "Payment" : "Receipt"} ${p.number}` : "Payment"}
      actions={p && p.state === "posted" && can("payment.write") ? <button className="btn" onClick={() => setDialog("reverse")}>Reverse</button> : null}
    >
      <p><a href="#/payments">← All payments and receipts</a></p>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      <Loading state={state}>
        {p ? (
          <div className="grid">
            <Card>
              <Facts items={[["Status", <Status value={p.state === "posted" ? (p.direction === "paid" ? "paid" : "received") : p.state} />], ["Date", date(p.paymentDate)], ["Amount", inr(p.amountPaise)], ["Mode", p.mode], ["Reference", p.reference], ["Not yet applied", p.unallocatedPaise ? inr(p.unallocatedPaise) : ""], ["Reversed because", p.reverseReason], ["Notes", p.notes]]} />
            </Card>
            <Card title="Applied to">
              <DataTable
                rows={p.allocations}
                rowKey={(a) => a.id}
                empty="Not applied to any document: it is held on account."
                columns={[
                  { header: "Document", render: (a) => a.docNumber ?? "" },
                  { header: "Amount", align: "num", render: (a) => inr(a.amountPaise) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </Loading>
      {dialog === "reverse" && p ? (
        <ReasonDialog
          title={`Reverse ${p.number}`}
          detail="The money did not move after all, or it was entered wrongly. The entry stays on record, marked reversed, and the documents it settled become outstanding again."
          confirmLabel="Reverse"
          reasonLabel="Why is it being reversed?"
          onCancel={() => setDialog(null)}
          onConfirm={async (reason) => {
            await post(`/api/payments/${p.id}/reverse`, { reason });
            setDialog(null);
            setNotice("Reversed.");
            state.reload();
          }}
        />
      ) : null}
    </Page>
  );
}

