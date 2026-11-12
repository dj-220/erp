import { useState } from "react";
import { get, messageOf, post } from "../api";
import { useAuth } from "../auth";
import { Meter } from "../charts";
import { inr, qty, rupees, today } from "../format";
import { Alert, Card, DataTable, Loading, Page, useLoad } from "../ui";

interface Balance { sku: string; name: string; uom: string; location: string; qty: string }
interface Reorder { sku: string; name: string; uom: string; onHand: string; reorderLevel: string; suggestedQty: string }
interface Valuation { rows: { sku: string; name: string; uom: string; qty: string; valuePaise: number; avgCost: string | null }[]; totalValuePaise: number }

type Tab = "balances" | "reorder" | "valuation";

export function Stock() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("balances");
  const tabs: [Tab, string][] = [["balances", "On hand"], ["reorder", "To reorder"], ...(can("stock.valuation") ? [["valuation", "Value"] as [Tab, string]] : [])];
  return (
    <Page title="Stock" subtitle="Worked out from posted stock movements, never typed in." actions={can("stock.write") ? <><a className="btn" href="#/stock/count">Stock count</a><a className="btn primary" href="#/stock/movements/new">New stock movement</a></> : null}>
      <div className="filters">
        <div className="seg" role="group" aria-label="Stock view">
          {tabs.map(([value, label]) => (
            <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>
          ))}
        </div>
      </div>
      {tab === "balances" ? <Balances /> : tab === "reorder" ? <ReorderList /> : <ValuationList />}
    </Page>
  );
}

function Balances() {
  const state = useLoad(() => get<Balance[]>("/api/stock/balances"), []);
  return (
    <Card>
      <Loading state={state}>
        <DataTable
          rows={state.data ?? []}
          rowKey={(r) => `${r.sku}/${r.location}`}
          empty="No stock on hand."
          columns={[
            { header: "Item", render: (r) => <><b>{r.sku}</b><div className="sub-line">{r.name}</div></> },
            { header: "Location", render: (r) => r.location },
            { header: "On hand", align: "num", render: (r) => `${qty(r.qty)} ${r.uom}` },
          ]}
        />
      </Loading>
    </Card>
  );
}

function ReorderList() {
  const { can } = useAuth();
  const state = useLoad(() => get<Reorder[]>("/api/stock/reorder"), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const raise = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await post<{ number?: string | null }>("/api/purchasing/requests/from-reorder", { requestDate: today(), neededBy: today(14) });
      setNotice(`Purchase request ${made.number ?? "(draft)"} created. Review and submit it under Purchase requests.`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <Card
        title="At or below the reorder level"
        note="The suggested quantity brings each item back up to its usual order size."
        actions={can("purchase.write") && (state.data?.length ?? 0) > 0 ? <button className="btn primary small" onClick={raise} disabled={busy}>Create purchase request</button> : null}
      >
        <Loading state={state}>
          <DataTable
            rows={state.data ?? []}
            rowKey={(r) => r.sku}
            empty="Every item is above its reorder level."
            columns={[
              { header: "Item", render: (r) => <><b>{r.sku}</b><div className="sub-line">{r.name}</div></> },
              { header: "On hand", render: (r) => <><Meter value={Number(r.onHand)} max={Number(r.reorderLevel)} label={`${qty(r.onHand)} on hand, reorder level ${qty(r.reorderLevel)}`} /><div className="sub-line">{qty(r.onHand)} of {qty(r.reorderLevel)} {r.uom}</div></> },
              { header: "Suggested order", align: "num", render: (r) => `${qty(r.suggestedQty)} ${r.uom}` },
            ]}
          />
        </Loading>
      </Card>
    </>
  );
}

function ValuationList() {
  const state = useLoad(() => get<Valuation>("/api/stock/valuation"), []);
  return (
    <Card title="Stock value" note={state.data ? `${inr(state.data.totalValuePaise)} in total, at moving-average cost.` : undefined}>
      <Loading state={state}>
        <DataTable
          rows={state.data?.rows ?? []}
          rowKey={(r) => r.sku}
          empty="No stock."
          columns={[
            { header: "Item", render: (r) => <><b>{r.sku}</b><div className="sub-line">{r.name}</div></> },
            { header: "Quantity", align: "num", render: (r) => `${qty(r.qty)} ${r.uom}` },
            { header: "Average cost", align: "num", render: (r) => rupees(r.avgCost) },
            { header: "Value", align: "num", render: (r) => inr(r.valuePaise) },
          ]}
        />
      </Loading>
    </Card>
  );
}
