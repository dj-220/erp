import { useState } from "react";
import { GST_RATES_CURRENT, GST_RATES_LEGACY } from "../../../src/domain/gst";
import { STATES } from "../../../src/domain/states";
import { get, post } from "../api";
import { CheckField, FormShell, Grid, LineGrid, SelectField, TextField, WithLookups, clean, go, newLine, useSubmit, type ItemRef, type Line, type LineColumn } from "../forms";
import { Card, DataTable, Loading, Page, useLoad } from "../ui";
import { qty } from "../format";

const REGISTRATIONS: [string, string][] = [
  ["regular", "Regular GST"],
  ["composition", "Composition scheme"],
  ["unregistered", "Not registered"],
  ["consumer", "Consumer"],
  ["sez", "SEZ"],
  ["overseas", "Overseas"],
];
const stateOptions = STATES.filter((s) => !s.legacy && s.code !== "97" && s.code !== "99").map((s) => [s.code, s.name] as [string, string]);

export function NewParty() {
  const [f, setF] = useState({ kind: "customer", name: "", gstin: "", registrationType: "", stateCode: "", addressLine: "", city: "", pincode: "", email: "", phone: "", creditDays: "30", udyamNo: "", isMsme: false });
  const { busy, error, run } = useSubmit();
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const hasGstin = f.gstin.trim() !== "";

  const save = () =>
    run(async () => {
      const body: Record<string, unknown> = {
        kind: f.kind,
        name: f.name.trim(),
        creditDays: Number(f.creditDays || 0),
        isMsme: f.isMsme,
        ...(hasGstin ? { gstin: f.gstin.trim().toUpperCase() } : { stateCode: f.stateCode }),
      };
      for (const k of ["registrationType", "addressLine", "city", "pincode", "email", "phone", "udyamNo"] as const) if (f[k].trim()) body[k] = f[k].trim();
      await post("/api/parties", body);
      go("/parties");
    });

  return (
    <Page title="New customer or supplier" subtitle="Anyone you sell to or buy from.">
      <Card>
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save" onCancel={() => go("/parties")}>
          <Grid>
            <SelectField id="p-kind" label="Type" value={f.kind} onChange={set("kind")} options={[["customer", "Customer"], ["supplier", "Supplier"], ["both", "Both"]]} />
            <TextField id="p-name" label="Name" value={f.name} onChange={set("name")} required />
            <TextField id="p-gstin" label="GSTIN" value={f.gstin} onChange={set("gstin")} hint="Checked for format and check digit. Leave empty for someone without one." />
            {hasGstin ? null : <SelectField id="p-state" label="State" value={f.stateCode} onChange={set("stateCode")} options={stateOptions} blank="Choose a state" required hint="Needed when there is no GSTIN." />}
            <SelectField id="p-reg" label="GST registration" value={f.registrationType} onChange={set("registrationType")} options={REGISTRATIONS} blank="Work it out" />
            <TextField id="p-credit" label="Credit days" value={f.creditDays} onChange={set("creditDays")} inputMode="numeric" hint="Days allowed to pay. Sets the due date." />
            <TextField id="p-addr" label="Address" value={f.addressLine} onChange={set("addressLine")} />
            <TextField id="p-city" label="City" value={f.city} onChange={set("city")} />
            <TextField id="p-pin" label="Pincode" value={f.pincode} onChange={set("pincode")} inputMode="numeric" />
            <TextField id="p-email" label="Email" type="email" value={f.email} onChange={set("email")} />
            <TextField id="p-phone" label="Phone" value={f.phone} onChange={set("phone")} />
            <CheckField id="p-msme" label="Micro or small enterprise (MSME)" checked={f.isMsme} onChange={(v) => setF({ ...f, isMsme: v })} />
            {f.isMsme ? <TextField id="p-udyam" label="Udyam number" value={f.udyamNo} onChange={set("udyamNo")} hint="MSME suppliers must be paid within 45 days." /> : null}
          </Grid>
        </FormShell>
      </Card>
    </Page>
  );
}

const KINDS: [string, string][] = [
  ["raw_material", "Raw material"],
  ["semi_finished", "Semi-finished"],
  ["finished", "Finished goods"],
  ["trading", "Trading goods"],
  ["consumable", "Consumable"],
  ["service", "Service"],
];

export function NewItem() {
  return (
    <WithLookups>
      {({ uoms }) => <ItemForm uoms={uoms.map((u) => [u.code, `${u.code} · ${u.name}`] as [string, string])} />}
    </WithLookups>
  );
}

function ItemForm({ uoms }: { uoms: [string, string][] }) {
  const [f, setF] = useState({ sku: "", name: "", kind: "finished", uomCode: uoms[0]?.[0] ?? "", hsnSac: "", gstRate: "5", salesPrice: "", purchasePrice: "", reorderLevel: "", reorderQty: "" });
  const { busy, error, run } = useSubmit();
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const legacy = (GST_RATES_LEGACY as readonly string[]).includes(f.gstRate);

  const save = () =>
    run(async () => {
      const body: Record<string, unknown> = { sku: f.sku.trim(), name: f.name.trim(), kind: f.kind, uomCode: f.uomCode, gstRate: f.gstRate, allowLegacyRate: legacy };
      for (const k of ["hsnSac", "salesPrice", "purchasePrice", "reorderLevel", "reorderQty"] as const) if (f[k].trim()) body[k] = f[k].trim();
      await post("/api/items", body);
      go("/items");
    });

  return (
    <Page title="New item" subtitle="Something you buy, make or sell.">
      <Card>
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save" onCancel={() => go("/items")}>
          <Grid>
            <TextField id="i-sku" label="Item code (SKU)" value={f.sku} onChange={set("sku")} required hint="Short and unique, for example SHIRT-OXFORD." />
            <TextField id="i-name" label="Name" value={f.name} onChange={set("name")} required />
            <SelectField id="i-kind" label="Kind" value={f.kind} onChange={set("kind")} options={KINDS} />
            <SelectField id="i-uom" label="Unit" value={f.uomCode} onChange={set("uomCode")} options={uoms} required />
            <TextField id="i-hsn" label="HSN or SAC" value={f.hsnSac} onChange={set("hsnSac")} inputMode="numeric" hint="4, 6 or 8 digits. Needed before you can invoice it." />
            <SelectField
              id="i-gst"
              label="GST rate (%)"
              value={f.gstRate}
              onChange={set("gstRate")}
              options={[...GST_RATES_CURRENT, ...GST_RATES_LEGACY].map((r) => [r, (GST_RATES_LEGACY as readonly string[]).includes(r) ? `${r} (old slab)` : r] as [string, string])}
              hint="Have your chartered accountant confirm the rate for each item."
            />
            <TextField id="i-sp" label="Selling price (₹ per unit)" value={f.salesPrice} onChange={set("salesPrice")} inputMode="decimal" />
            <TextField id="i-pp" label="Buying price (₹ per unit)" value={f.purchasePrice} onChange={set("purchasePrice")} inputMode="decimal" />
            <TextField id="i-rl" label="Reorder level" value={f.reorderLevel} onChange={set("reorderLevel")} inputMode="decimal" hint="Warn when stock falls to this." />
            <TextField id="i-rq" label="Usual order quantity" value={f.reorderQty} onChange={set("reorderQty")} inputMode="decimal" />
          </Grid>
        </FormShell>
      </Card>
    </Page>
  );
}

interface Bom {
  sku: string;
  name: string;
  version: number;
  outputQty: string;
  components: { sku: string; name: string; qty: string; scrapPct: string }[];
}

export function Boms() {
  const state = useLoad(() => get<Bom[]>("/api/boms"), []);
  return (
    <Page title="Bills of materials" subtitle="What goes into each finished item. Used to work out material shortages." actions={<a className="btn primary" href="#/boms/new">New BOM</a>}>
      <Loading state={state}>
        {(state.data ?? []).length === 0 ? <Card><p className="empty">No BOMs yet.</p></Card> : (
          <div className="grid">
            {state.data?.map((b) => (
              <Card key={`${b.sku}/${b.version}`} title={`${b.sku} · ${b.name}`} note={`Version ${b.version}. One run makes ${qty(b.outputQty)}.`}>
                <DataTable
                  rows={b.components}
                  rowKey={(c) => c.sku}
                  columns={[
                    { header: "Component", render: (c) => <><b>{c.sku}</b><div className="sub-line">{c.name}</div></> },
                    { header: "Per run", align: "num", render: (c) => qty(c.qty) },
                    { header: "Scrap", align: "num", render: (c) => `${Number(c.scrapPct)}%` },
                  ]}
                />
              </Card>
            ))}
          </div>
        )}
      </Loading>
    </Page>
  );
}

const BOM_COLS: LineColumn[] = [
  { key: "componentSku", label: "Component", kind: "sku", width: 220 },
  { key: "qty", label: "Quantity per run", kind: "num" },
  { key: "scrapPct", label: "Scrap %", kind: "num", placeholder: "0" },
];

export function NewBom() {
  return <WithLookups>{({ items }) => <BomForm items={items} />}</WithLookups>;
}

function BomForm({ items }: { items: ItemRef[] }) {
  const finished = items.filter((i) => i.kind === "finished" || i.kind === "semi_finished");
  const [out, setOut] = useState("");
  const [outQty, setOutQty] = useState("1");
  const [lines, setLines] = useState<Line[]>([newLine(BOM_COLS)]);
  const { busy, error, run } = useSubmit();
  const save = () =>
    run(async () => {
      await post("/api/boms", { outputSku: out, outputQty: outQty || "1", lines: lines.filter((l) => l.componentSku).map(clean) });
      go("/boms");
    });
  return (
    <Page title="New bill of materials" subtitle="Saving creates the next version and makes it the one in use.">
      <Card>
        <FormShell onSubmit={save} busy={busy} error={error} submitLabel="Save BOM" onCancel={() => go("/boms")}>
          <Grid>
            <SelectField id="b-out" label="Makes" value={out} onChange={setOut} options={finished.map((i) => [i.sku, `${i.sku} · ${i.name}`] as [string, string])} blank="Choose finished item" required />
            <TextField id="b-qty" label="Units made per run" value={outQty} onChange={setOutQty} inputMode="decimal" />
          </Grid>
          <LineGrid columns={BOM_COLS} lines={lines} onChange={setLines} items={items.filter((i) => i.kind !== "service" && i.kind !== "finished")} addLabel="Add component" />
        </FormShell>
      </Card>
    </Page>
  );
}
