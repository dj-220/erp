import { Fragment, useState } from "react";
import { get } from "../api";
import { AgeingBars } from "../charts";
import { date, inr } from "../format";
import { Card, Chip, Loading, Page, useLoad } from "../ui";

interface Doc {
  docId: string;
  number: string;
  docDate: string;
  dueDate: string;
  outstandingPaise: number;
  daysOverdue: number;
  bucket: string;
  msmeDeadline?: string;
  msmeBreached?: boolean;
}
interface Party {
  partyId: string;
  name: string;
  isMsme: boolean;
  docs: Doc[];
  buckets: Record<string, number>;
  outstandingPaise: number;
  unappliedPaise: number;
  creditBalancePaise: number;
}
interface Report {
  asOf: string;
  parties: Party[];
  buckets: Record<string, number>;
  totalOutstandingPaise: number;
  totalUnappliedPaise: number;
  totalCreditBalancePaise: number;
}

const COLUMNS: [key: string, label: string][] = [
  ["not_due", "Not due"],
  ["1_30", "1–30"],
  ["31_60", "31–60"],
  ["61_90", "61–90"],
  ["over_90", "90+"],
];

export function Ageing() {
  const [side, setSide] = useState<"receivables" | "payables">("receivables");
  const state = useLoad(() => get<Report>(`/api/reports/${side}-ageing`), [side]);
  const [open, setOpen] = useState<string | null>(null);
  const customers = side === "receivables";

  return (
    <Page title="Who owes what" subtitle={state.data ? `As at ${date(state.data.asOf)}. Balances are worked out from invoices, bills, credit notes and payments.` : undefined}>
      <div className="filters">
        <div className="seg" role="group" aria-label="Report">
          <button aria-pressed={customers} onClick={() => setSide("receivables")}>Customers owe us</button>
          <button aria-pressed={!customers} onClick={() => setSide("payables")}>We owe suppliers</button>
        </div>
      </div>
      <Loading state={state}>
        {state.data ? (
          <div className="grid">
            <Card
              title={customers ? "Owed by customers" : "Owed to suppliers"}
              note={`${inr(state.data.totalOutstandingPaise)} in total${state.data.totalUnappliedPaise ? ` · ${inr(state.data.totalUnappliedPaise)} ${customers ? "received" : "paid"} on account` : ""}${state.data.totalCreditBalancePaise ? ` · ${inr(state.data.totalCreditBalancePaise)} in credits` : ""}`}
            >
              <AgeingBars buckets={state.data.buckets} color={customers ? "var(--series-1)" : "var(--series-2)"} noun={customers ? "owed by customers" : "owed to suppliers"} view="chart" />
            </Card>
            <Card title="By party" note="Select a name to see its documents.">
              {state.data.parties.length === 0 ? (
                <p className="empty">Nothing outstanding.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{customers ? "Customer" : "Supplier"}</th>
                        {COLUMNS.map(([k, label]) => <th key={k} className="num">{label}</th>)}
                        <th className="num">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.data.parties.map((p) => (
                        <Fragment key={p.partyId}>
                          <tr>
                            <td>
                              <button className="btn ghost small" aria-expanded={open === p.partyId} onClick={() => setOpen(open === p.partyId ? null : p.partyId)}>{p.name}</button>
                              {p.isMsme ? <span className="chip neutral" style={{ marginLeft: 6 }}>MSME</span> : null}
                              {p.unappliedPaise ? <div className="sub-line">{inr(p.unappliedPaise)} on account</div> : null}
                            </td>
                            {COLUMNS.map(([k]) => <td key={k} className="num">{p.buckets[k] ? inr(p.buckets[k] as number) : "–"}</td>)}
                            <td className="num"><b>{inr(p.outstandingPaise)}</b></td>
                          </tr>
                          {open === p.partyId
                            ? p.docs.map((d) => (
                                <tr key={d.docId}>
                                  <td colSpan={COLUMNS.length + 1}>
                                    <b>{d.number}</b> <span className="muted">dated {date(d.docDate)}, due {date(d.dueDate)}{d.daysOverdue > 0 ? `, ${d.daysOverdue} days late` : ""}</span>
                                    {d.msmeBreached ? <> <Chip tone="critical">Past the MSME limit ({date(d.msmeDeadline)})</Chip></> : d.msmeDeadline ? <span className="muted"> · MSME limit {date(d.msmeDeadline)}</span> : null}
                                  </td>
                                  <td className="num">{inr(d.outstandingPaise)}</td>
                                </tr>
                              ))
                            : null}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        ) : null}
      </Loading>
    </Page>
  );
}
