import { useState } from "react";
import { get, post } from "../api";
import { useAuth } from "../auth";
import { Facts, FormShell, Grid, LineGrid, SelectField, TextArea, TextField, WithLookups, clean, go, newLine, useDocActions, useSubmit, type ItemRef, type Line, type LineColumn, type Lookups } from "../forms";
import { date, inr, qty, rupees, today } from "../format";
import { Alert, Card, DataTable, Loading, Page, Status, useLoad } from "../ui";

const TYPES: [string, string, string][] = [
  ["goods_receipt", "Goods receipt", "Stock coming in from a supplier. Needs a cost per unit."],
  ["delivery", "Delivery", "Stock going out to a customer. Deliveries against a sales order are done from the order."],
  ["transfer", "Transfer", "Moving stock between two of your locations."],
  ["adjustment", "Adjustment", "Correcting stock: damage, found stock, opening balances."],
];

function columnsFor(type: string, locations: [string, string][]): LineColumn[] {
  const base: LineColumn[] = [{ key: "sku", label: "Item", kind: "sku", width: 230 }, { key: "qty", label: "Quantity", kind: "num" }];
  if (type === "goods_receipt") return [...base, { key: "unitCost", label: "Cost per unit (₹)", kind: "num" }];
  if (type === "transfer") return [...base, { key: "fromLocation", label: "From", kind: "select", options: locations, placeholder: "Choose" }, { key: "toLocation", label: "To", kind: "select", options: locations, placeholder: "Choose" }];
  if (type === "adjustment") return [...base, { key: "direction", label: "Direction", kind: "select", options: [["increase", "Add to stock"], ["decrease", "Remove from stock"]], placeholder: "Choose" }, { key: "unitCost", label: "Cost per unit (₹)", kind: "num", placeholder: "for additions" }];
  return base;
}

const internalLocations = (l: Lookups): [string, string][] => l.warehouses.flatMap((w) => w.locations.filter((x) => x.kind === "internal").map((x) => [x.name, x.name] as [string, string]));

export function NewStockDocument() {
  return <WithLookups>{(l) => <StockForm lookups={l} />}</WithLookups>;
}

function StockForm({ lookups }: { lookups: Lookups }) {
  const [docType, setDocType] = useState("goods_receipt");
  const [docDate, setDocDate] = useState(today());
  const [partyId, setPartyId] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [warehouse, setWarehouse] = useState(lookups.warehouses[0]?.code ?? "MAIN");
  const columns = columnsFor(docType, internalLocations(lookups));
  const [lines, setLines] = useState<Line[]>([newLine(columns)]);
  const { busy, error, run } = useSubmit();
  const stocked = lookups.items.filter((i) => i.kind !== "service");
  const partyKind = docType === "goods_receipt" ? "supplier" : docType === "delivery" ? "customer" : null;
  const parties = lookups.parties.filter((p) => (partyKind === "supplier" ? p.kind !== "customer" : p.kind !== "supplier"));

  const changeType = (v: string) => {
    setDocType(v);
    setPartyId("");
    setLines([newLine(columnsFor(v, internalLocations(lookups)))]);
  };

  const save = () =>
    run(async () => {
      const made = await post<{ id: string }>("/api/stock/documents", {
        docType,
        docDate,
        warehouseCode: warehouse,
        ...(partyId ? { partyId } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines.filter((l) => l.sku).map(clean),
      });
      go(`/stock/documents/${made.id}`);
    });

  return (
    <Page title="New stock movement" subtitle="It stays a draft until you post it. Posting changes stock and cannot be undone: fix mistakes with another movement.">
      <Card>
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save draft" onCancel={() => go("/stock/movements")}>
          <Grid>
            <SelectField id="sd-type" label="Type" value={docType} onChange={changeType} options={TYPES.map(([v, l]) => [v, l] as [string, string])} hint={TYPES.find(([v]) => v === docType)?.[2]} />
            <TextField id="sd-date" label="Date" type="date" value={docDate} onChange={setDocDate} required />
            {partyKind ? <SelectField id="sd-party" label={partyKind === "supplier" ? "Supplier" : "Customer"} value={partyId} onChange={setPartyId} options={parties.map((p) => [p.id, p.name] as [string, string])} blank="Not recorded" /> : null}
            <SelectField id="sd-wh" label="Warehouse" value={warehouse} onChange={setWarehouse} options={lookups.warehouses.map((w) => [w.code, w.name] as [string, string])} />
            <TextField id="sd-ref" label="Reference" value={reference} onChange={setReference} hint="Challan number, reason, anything useful." />
          </Grid>
          <LineGrid key={docType} columns={columns} lines={lines} onChange={setLines} items={stocked} />
          <TextArea id="sd-notes" label="Notes" value={notes} onChange={setNotes} />
        </FormShell>
      </Card>
    </Page>
  );
}

/* ---------------------------------------------------------------- Stock count */

const COUNT_COLS: LineColumn[] = [
  { key: "sku", label: "Item", kind: "sku", width: 240 },
  { key: "countedQty", label: "Counted quantity", kind: "num" },
  { key: "unitCost", label: "Cost per unit (₹)", kind: "num", placeholder: "if stock was missing" },
];

export function NewStockCount() {
  return <WithLookups>{(l) => <CountForm lookups={l} items={l.items.filter((i) => i.kind !== "service")} />}</WithLookups>;
}

function CountForm({ lookups, items }: { lookups: Lookups; items: ItemRef[] }) {
  const locations = internalLocations(lookups);
  const [docDate, setDocDate] = useState(today());
  const [location, setLocation] = useState("");
  const [reference, setReference] = useState("Physical count");
  const [lines, setLines] = useState<Line[]>([newLine(COUNT_COLS)]);
  const { busy, error, run } = useSubmit();
  const save = () =>
    run(async () => {
      const made = await post<{ id: string }>("/api/stock/counts", {
        docDate,
        ...(location ? { location } : {}),
        reference: reference.trim() || undefined,
        counts: lines.filter((l) => l.sku).map(clean),
      });
      go(`/stock/documents/${made.id}`);
    });
  return (
    <Page title="Stock count" subtitle="Enter what you counted. We work out the difference from the books and draft an adjustment for you to review.">
      <Card>
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Draft the adjustment" onCancel={() => go("/stock")}>
          <Grid>
            <TextField id="sc-date" label="Count date" type="date" value={docDate} onChange={setDocDate} required />
            <SelectField id="sc-loc" label="Location counted" value={location} onChange={setLocation} options={locations} blank="Main stock location" />
            <TextField id="sc-ref" label="Reference" value={reference} onChange={setReference} />
          </Grid>
          <LineGrid columns={COUNT_COLS} lines={lines} onChange={setLines} items={items} addLabel="Add item" />
        </FormShell>
      </Card>
    </Page>
  );
}

/* ---------------------------------------------------------------- Document detail */

interface SLine { lineNo: number; sku: string; from: string; to: string; qty: string; unitCost: string | null; valuePaise: number | null; state: string }
interface SDoc { id: string; docType: string; number: string | null; state: string; docDate: string; reference: string | null; notes: string | null; lines: SLine[] }

export function StockDocumentDetail({ id }: { id: string }) {
  const { can } = useAuth();
  const state = useLoad(() => get<SDoc>(`/api/stock/documents/${id}`), [id]);
  const { notice, busy, error, act } = useDocActions(state.reload);
  const d = state.data;
  const label = TYPES.find(([v]) => v === d?.docType)?.[1] ?? "Stock document";
  return (
    <Page
      title={d ? `${label} ${d.number ?? "(draft)"}` : "Stock document"}
      actions={
        d && d.state === "draft" && can("stock.write") ? (
          <>
            <button className="btn primary" disabled={busy} onClick={() => act("Posted. Stock has changed.", () => post(`/api/stock/documents/${id}/post`))}>Post</button>
            <button className="btn" disabled={busy} onClick={() => act("Draft cancelled.", () => post(`/api/stock/documents/${id}/cancel`))}>Cancel draft</button>
          </>
        ) : null
      }
    >
      <p><a href="#/stock/movements">← All stock movements</a></p>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <Loading state={state}>
        {d ? (
          <div className="grid">
            <Card><Facts items={[["Status", <Status value={d.state} />], ["Date", date(d.docDate)], ["Reference", d.reference], ["Notes", d.notes]]} /></Card>
            <Card title="Lines" note={d.docType === "adjustment" && d.state === "draft" ? "Check each line, then post." : undefined}>
              <DataTable
                rows={d.lines}
                rowKey={(l) => String(l.lineNo)}
                empty="No differences: the count matched the books, so there is nothing to adjust."
                columns={[
                  { header: "Item", render: (l) => <b>{l.sku}</b> },
                  { header: "From", render: (l) => l.from },
                  { header: "To", render: (l) => l.to },
                  { header: "Quantity", align: "num", render: (l) => qty(l.qty) },
                  { header: "Cost per unit", align: "num", render: (l) => rupees(l.unitCost) },
                  { header: "Value", align: "num", render: (l) => (l.valuePaise === null ? "" : inr(l.valuePaise)) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </Loading>
    </Page>
  );
}
