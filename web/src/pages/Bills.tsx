import { useState, type ReactNode } from "react";
import { get, messageOf, post } from "../api";
import { useAuth } from "../auth";
import { date, inr } from "../format";
import { Alert, Card, DataTable, Loading, Page, ReasonDialog, Status, useLoad } from "../ui";

interface Bill {
  billId: string;
  state: string;
  number: string | null;
  supplierBillNo: string;
  supplierName: string;
  orderNumber: string | null;
  billDate: string;
  dueDate: string;
  totalPaise: number;
  findings: { code: string; message: string }[];
}

const FILTERS: [value: string, label: string][] = [
  ["", "All"],
  ["held", "On hold"],
  ["draft", "Draft"],
  ["matched", "Ready to post"],
  ["posted", "Posted"],
  ["rejected", "Rejected"],
];

export function Bills() {
  const { can } = useAuth();
  const [filter, setFilter] = useState("");
  const state = useLoad(() => get<Bill[]>(`/api/bills${filter ? `?states=${filter}` : ""}`), [filter]);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = can("bill.write");
  const mayPost = can("bill.post");

  const done = (message: string) => {
    setDialog(null);
    setNotice(message);
    state.reload();
  };

  const run = async (path: string, message: string) => {
    setError(null);
    try {
      await post(path);
      done(message);
    } catch (e) {
      setNotice(null);
      setError(messageOf(e));
    }
  };

  const confirm = (title: string, detail: ReactNode, label: string, path: string, message: string) =>
    setDialog(
      <ReasonDialog
        title={title}
        detail={detail}
        confirmLabel={label}
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          await post(path);
          done(message);
        }}
      />,
    );

  const withReason = (bill: Bill, verb: "release" | "reject") =>
    setDialog(
      <ReasonDialog
        title={verb === "release" ? `Release ${bill.supplierBillNo} for payment` : `Reject ${bill.supplierBillNo}`}
        detail={
          <>
            <p style={{ margin: "0 0 8px" }}>{bill.supplierName} · {inr(bill.totalPaise)}</p>
            <ul className="reasons">{bill.findings.map((f) => <li key={f.code}>{f.message}</li>)}</ul>
            {verb === "release" ? <p className="muted">Releasing pays a bill that does not match. Your reason is kept with it.</p> : null}
          </>
        }
        confirmLabel={verb === "release" ? "Release" : "Reject"}
        reasonLabel={verb === "release" ? "Why is it fine to pay?" : "Why is it rejected?"}
        onCancel={() => setDialog(null)}
        onConfirm={async (reason) => {
          await post(`/api/bills/${bill.billId}/${verb}`, { reason });
          done(verb === "release" ? `${bill.supplierBillNo} released.` : `${bill.supplierBillNo} rejected.`);
        }}
      />,
    );

  return (
    <Page title="Supplier bills" subtitle="Each bill is matched to its order and to what was received. Bills that do not match are held." actions={write ? <a className="btn primary" href="#/bills/new">Enter supplier bill</a> : null}>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="filters">
        <div className="seg" role="group" aria-label="Show bills">
          {FILTERS.map(([value, label]) => (
            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
      </div>
      <Card>
        <Loading state={state}>
          <DataTable
            rows={state.data ?? []}
            rowKey={(r) => r.billId}
            empty="No bills here."
            columns={[
              { header: "Bill", render: (r) => <><b>{r.supplierBillNo}</b><div className="sub-line">{r.supplierName}{r.orderNumber ? ` · ${r.orderNumber}` : ""}</div></> },
              { header: "Dated", nowrap: true, render: (r) => <>{date(r.billDate)}<div className="sub-line">due {date(r.dueDate)}</div></> },
              { header: "Amount", align: "num", render: (r) => inr(r.totalPaise) },
              {
                header: "Status",
                render: (r) => (
                  <>
                    <Status value={r.state} />
                    {r.number ? <div className="sub-line">{r.number}</div> : null}
                    {r.state === "held" ? <ul className="reasons">{r.findings.map((f) => <li key={f.code}>{f.message}</li>)}</ul> : null}
                  </>
                ),
              },
              {
                header: "",
                render: (r) => (
                  <span className="actions">
                    {r.state === "draft" && write ? (
                      <>
                        <button className="btn small primary" onClick={() => run(`/api/bills/${r.billId}/submit`, `${r.supplierBillNo} submitted.`)}>Check match</button>
                        <button className="btn small ghost" onClick={() => confirm(`Cancel ${r.supplierBillNo}?`, "The draft is discarded.", "Cancel bill", `/api/bills/${r.billId}/cancel`, `${r.supplierBillNo} cancelled.`)}>Cancel</button>
                      </>
                    ) : null}
                    {r.state === "held" && write ? (
                      <>
                        <button className="btn small" onClick={() => withReason(r, "release")}>Release</button>
                        <button className="btn small ghost" onClick={() => withReason(r, "reject")}>Reject</button>
                      </>
                    ) : null}
                    {r.state === "matched" && mayPost ? (
                      <button className="btn small primary" onClick={() => confirm(`Post ${r.supplierBillNo}?`, `${r.supplierName} · ${inr(r.totalPaise)}. It gets its number and becomes payable. A posted bill cannot be edited.`, "Post bill", `/api/bills/${r.billId}/post`, `${r.supplierBillNo} posted.`)}>Post</button>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        </Loading>
      </Card>
      {dialog}
    </Page>
  );
}
