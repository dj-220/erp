import { useState, type ReactNode } from "react";
import { announceChange, get, post } from "../api";
import { useAuth } from "../auth";
import { dateTime, inr } from "../format";
import { Alert, Card, DataTable, Loading, Page, ReasonDialog, useLoad } from "../ui";

interface Pending {
  requestId: string;
  docNumber: string | null;
  supplierName: string;
  amountPaise: number;
  requestedByName: string;
  assignedToName: string | null;
  escalationCount: number;
  createdAt: string;
  canDecide?: boolean;
}

export function Approvals() {
  const { can } = useAuth();
  const state = useLoad(() => get<Pending[]>("/api/approvals/pending"), []);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mayDecide = can("approval.decide");

  const decide = (row: Pending, decision: "approve" | "reject") =>
    setDialog(
      <ReasonDialog
        title={`${decision === "approve" ? "Approve" : "Reject"} ${row.docNumber ?? "purchase order"}`}
        detail={<>{row.supplierName} · {inr(row.amountPaise)} · asked by {row.requestedByName}</>}
        confirmLabel={decision === "approve" ? "Approve" : "Reject"}
        reasonLabel={decision === "approve" ? "Comment (optional)" : "Why is it rejected?"}
        reasonRequired={decision === "reject"}
        onCancel={() => setDialog(null)}
        onConfirm={async (comment) => {
          await post(`/api/approvals/${row.requestId}/decide`, { decision, ...(comment ? { comment } : {}) });
          setDialog(null);
          setNotice(`${row.docNumber ?? "The order"} ${decision === "approve" ? "approved" : "rejected"}.`);
          state.reload();
          announceChange();
        }}
      />,
    );

  const escalate = (row: Pending) =>
    setDialog(
      <ReasonDialog
        title={`Pass ${row.docNumber ?? "this order"} up`}
        detail="It goes to the next person with a higher approval limit. Use this when the amount is more than you should decide alone."
        confirmLabel="Pass it up"
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          await post(`/api/approvals/${row.requestId}/escalate`);
          setDialog(null);
          setNotice(`${row.docNumber ?? "The order"} passed up.`);
          state.reload();
          announceChange();
        }}
      />,
    );

  return (
    <Page title="Approvals" subtitle="Purchase orders above the requester's own limit wait here for someone with a higher one.">
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      <Card>
        <Loading state={state}>
          <DataTable
            rows={state.data ?? []}
            rowKey={(r) => r.requestId}
            empty="Nothing is waiting for approval."
            columns={[
              { header: "Order", render: (r) => <><b>{r.docNumber}</b><div className="sub-line">{r.supplierName}</div></> },
              { header: "Asked by", render: (r) => <>{r.requestedByName}<div className="sub-line">{dateTime(r.createdAt)}</div></> },
              { header: "Waiting on", render: (r) => <>{r.assignedToName ?? ""}{r.escalationCount ? <div className="sub-line">passed up {r.escalationCount}×</div> : null}</> },
              { header: "Amount", align: "num", render: (r) => inr(r.amountPaise) },
              {
                header: "",
                render: (r) =>
                  mayDecide && r.canDecide ? (
                    <span className="actions">
                      <button className="btn small primary" onClick={() => decide(r, "approve")}>Approve</button>
                      <button className="btn small" onClick={() => decide(r, "reject")}>Reject</button>
                      <button className="btn small ghost" onClick={() => escalate(r)}>Pass up</button>
                    </span>
                  ) : (
                    <span className="muted">{mayDecide ? "Not yours to decide" : "View only"}</span>
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
