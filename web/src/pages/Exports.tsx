import { useState } from "react";
import { ApiError, download, get, messageOf } from "../api";
import { useAuth } from "../auth";
import { date, today } from "../format";
import { Alert, Card, Page } from "../ui";

const SHEETS: [key: string, label: string, note: string][] = [
  ["parties", "Customers and suppliers", "GSTIN, state, credit days, MSME flag"],
  ["items", "Items", "HSN or SAC, GST rate, unit, prices"],
  ["stock", "Stock on hand", "By item and location"],
  ["valuation", "Stock value", "Moving-average cost"],
  ["sales_orders", "Sales orders", "One row per order line"],
  ["sales_invoices", "Sales invoices", "Tax invoices, with credit notes shown as negatives"],
  ["purchase_orders", "Purchase orders", "One row per order line"],
  ["bills", "Supplier bills", "With the match result"],
  ["payments", "Payments and receipts", "With what each was applied to"],
  ["receivables", "Customers owe us", "Ageing by customer"],
  ["payables", "We owe suppliers", "Ageing by supplier"],
];

interface Preview {
  from: string;
  to: string;
  voucherCount: number;
  counts: Record<string, number>;
  warnings: string[];
}

const countText = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const words = k.replace(/([A-Z])/g, " $1").toLowerCase();
      return `${n} ${n === 1 ? words.replace(/s$/, "") : words}`;
    })
    .join(", ");

/** Financial year to date in India: 1 April to today. */
function yearStart(): string {
  const t = today();
  const year = Number(t.slice(0, 4));
  return `${Number(t.slice(5, 7)) >= 4 ? year : year - 1}-04-01`;
}

export function Exports() {
  const { can } = useAuth();
  return (
    <Page title="Exports" subtitle="Take your data to Excel or to Tally.">
      {can("export.excel") ? <ExcelExport /> : null}
      {can("export.tally") ? <TallyExport /> : null}
      {!can("export.excel") && !can("export.tally") ? <Alert kind="warn">Your role cannot export data.</Alert> : null}
    </Page>
  );
}

function ExcelExport() {
  const [chosen, setChosen] = useState<Set<string>>(new Set(SHEETS.map(([k]) => k)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (key: string) => {
    const next = new Set(chosen);
    if (!next.delete(key)) next.add(key);
    setChosen(next);
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await download("GET", `/api/exports/excel?sheets=${[...chosen].join(",")}`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Excel" note="One workbook, one sheet for each thing you tick. Money is in rupees and dates are real dates, so you can filter and total them.">
      {error ? <Alert>{error}</Alert> : null}
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        <legend className="sr-only">Sheets to include</legend>
        {SHEETS.map(([key, label, note]) => (
          <label key={key} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={chosen.has(key)} onChange={() => toggle(key)} style={{ marginTop: 4 }} />
            <span>{label}<span className="sub-line" style={{ display: "block" }}>{note}</span></span>
          </label>
        ))}
      </fieldset>
      <p className="actions" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={run} disabled={busy || chosen.size === 0}>{busy ? "Preparing…" : "Download Excel"}</button>
        <button className="btn ghost" onClick={() => setChosen(new Set(chosen.size === SHEETS.length ? [] : SHEETS.map(([k]) => k)))}>{chosen.size === SHEETS.length ? "Clear all" : "Tick all"}</button>
      </p>
    </Card>
  );
}

function TallyExport() {
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = `from=${from}&to=${to}`;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Tally" note="Two XML files: first the ledgers and stock items, then the vouchers. Import them into TallyPrime in that order. Documents that were already exported are skipped, so a second export never doubles anything.">
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="filters">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="from">From</label>
          <input id="from" className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="to">To</label>
          <input id="to" className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} />
        </div>
      </div>
      <p className="actions">
        <button className="btn" disabled={busy || !valid} onClick={() => guard(async () => setPreview(await get<Preview>(`/api/exports/tally/preview?${query}`)))}>See what will go</button>
        <button className="btn" disabled={busy || !valid} onClick={() => guard(async () => { await download("GET", `/api/exports/tally/masters?${query}`); setNotice("Masters file downloaded. Import it into Tally first."); })}>1. Download masters</button>
        <button className="btn primary" disabled={busy || !valid} onClick={() => guard(async () => {
          const headers = await download("POST", "/api/exports/tally/vouchers", { from, to });
          setNotice(`Vouchers file downloaded: ${headers.get("x-voucher-count") ?? "0"} vouchers. They are now marked as exported.`);
          setPreview(null);
        })}>2. Download vouchers</button>
      </p>
      {preview ? (
        <div className="alert ok" role="status">
          <b>{preview.voucherCount} voucher{preview.voucherCount === 1 ? "" : "s"}</b> from {date(preview.from)} to {date(preview.to)}
          {countText(preview.counts) ? <> ({countText(preview.counts)})</> : null}.
          {preview.warnings.length ? <ul className="reasons">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
        </div>
      ) : null}
      <p className="muted">The XML follows Tally's import format but has not yet been checked against a live TallyPrime. Import into a test company first.</p>
    </Card>
  );
}
