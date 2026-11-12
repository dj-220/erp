import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, get, messageOf, post } from "../api";
import { useAuth } from "../auth";
import { dateTime, inr } from "../format";
import { Alert, Card, DataTable, Loading, Page, ReasonDialog, useLoad } from "../ui";

interface Member {
  userId: string;
  email: string;
  name: string;
  role: string;
  limitPaise: number;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}
interface Company {
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  pan: string | null;
  stateCode: string;
  tallyCompanyName: string;
  allowNegativeStock: boolean;
  billRateTolerancePct: string;
  billQtyTolerancePct: string;
  billAmountTolerancePaise: number;
}

const ROLES: [value: string, label: string, note: string][] = [
  ["owner", "Owner", "Everything, including people and settings"],
  ["admin", "Admin", "Everything except adding owners"],
  ["accountant", "Accountant", "Bills, payments, reports and exports"],
  ["purchase", "Purchase", "Requests, orders and bills"],
  ["sales", "Sales", "Orders and invoices"],
  ["stores", "Stores", "Receipts, deliveries and counts"],
  ["viewer", "Viewer", "Look, but change nothing"],
];
const roleLabel = (role: string) => ROLES.find(([v]) => v === role)?.[1] ?? role;

export function Team() {
  const { can, me } = useAuth();
  const manage = can("member.manage");
  const state = useLoad(() => get<Member[]>("/api/members"), []);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = async (member: Member, changes: { role?: string; limitRupees?: string }) => {
    setError(null);
    try {
      await api("PATCH", `/api/members/${member.userId}`, changes);
      setNotice(`${member.name} updated.`);
      state.reload();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  const resetPassword = (member: Member) =>
    setDialog(
      <ResetPasswordDialog
        member={member}
        onCancel={() => setDialog(null)}
        onDone={(password) => {
          setDialog(null);
          setNotice(`Temporary password for ${member.name}: ${password}. Tell them in person or by phone. They must choose their own when they sign in.`);
          state.reload();
        }}
      />,
    );

  const remove = (member: Member) =>
    setDialog(
      <ReasonDialog
        title={`Remove ${member.name}?`}
        detail="They lose access to this company straight away. Their past work stays in the records."
        confirmLabel="Remove"
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          await api("DELETE", `/api/members/${member.userId}`);
          setDialog(null);
          setNotice(`${member.name} removed.`);
          state.reload();
        }}
      />,
    );

  return (
    <Page title="People and settings" subtitle="Who can do what in this company.">
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="grid">
        <Card title="Team" note="The approval limit is the largest purchase order a person may approve alone.">
          <Loading state={state}>
            <DataTable
              rows={state.data ?? []}
              rowKey={(r) => r.userId}
              columns={[
                { header: "Person", render: (r) => <><b>{r.name}</b>{r.userId === me?.user.id ? <span className="muted"> (you)</span> : null}<div className="sub-line">{r.email}</div></> },
                {
                  header: "Role",
                  render: (r) =>
                    manage && r.userId !== me?.user.id ? (
                      <select className="input" aria-label={`Role for ${r.name}`} value={r.role} onChange={(e) => change(r, { role: e.target.value })}>
                        {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    ) : (
                      roleLabel(r.role)
                    ),
                },
                { header: "Approval limit", align: "num", render: (r) => (r.role === "owner" ? "Any amount" : r.limitPaise > 0 ? inr(r.limitPaise) : <span className="muted">none</span>) },
                { header: "Last signed in", render: (r) => (r.lastLoginAt ? dateTime(r.lastLoginAt) : <span className="muted">never</span>) },
                {
                  header: "",
                  render: (r) =>
                    manage && r.userId !== me?.user.id ? (
                      <span className="actions">
                        <button className="btn small ghost" onClick={() => resetPassword(r)}>Reset password</button>
                        <button className="btn small ghost" onClick={() => remove(r)}>Remove</button>
                      </span>
                    ) : null,
                },
              ]}
            />
          </Loading>
        </Card>
        {manage ? <AddMember onAdded={(name) => { setNotice(`${name} added.`); state.reload(); }} /> : null}
        <CompanySettings />
      </div>
      {dialog}
    </Page>
  );
}

/** Letters and digits that are hard to misread when read out loud (no 0/O, 1/l/I). */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => alphabet[b % alphabet.length]).join("");
}

function ResetPasswordDialog({ member, onCancel, onDone }: { member: Member; onCancel: () => void; onDone: (password: string) => void }) {
  const [password, setPassword] = useState(generatePassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/members/${member.userId}/reset-password`, { temporaryPassword: password });
      onDone(password);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Reset password for ${member.name}`}>
        <h2>Reset password for {member.name}</h2>
        <div className="ink-2">
          This signs them out everywhere and unlocks the account. They must replace the temporary password when they sign in. You will see it once, on the next screen.
        </div>
        <div className="field">
          <label htmlFor="temp-pass">Temporary password</label>
          <input id="temp-pass" className="input" style={{ fontFamily: "ui-monospace, Consolas, monospace" }} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        {error ? <Alert>{error}</Alert> : null}
        <div className="actions" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={() => setPassword(generatePassword())} disabled={busy}>Make another</button>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || password.length < 10}>Set password</button>
        </div>
      </div>
    </div>
  );
}

function AddMember({ onAdded }: { onAdded: (name: string) => void }) {
  const [form, setForm] = useState({ name: "", email: "", role: "purchase", limitRupees: "0", initialPassword: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/members", { ...form, initialPassword: form.initialPassword || undefined });
      onAdded(form.name);
      setForm({ name: "", email: "", role: "purchase", limitRupees: "0", initialPassword: "" });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Add a person" note="If they already have a login on this system, leave the password empty and they keep their own.">
      {error ? <Alert>{error}</Alert> : null}
      <form onSubmit={submit} className="grid cols-2">
        <div className="field"><label htmlFor="m-name">Name</label><input id="m-name" className="input" required value={form.name} onChange={set("name")} /></div>
        <div className="field"><label htmlFor="m-email">Email</label><input id="m-email" className="input" type="email" required value={form.email} onChange={set("email")} autoComplete="off" /></div>
        <div className="field">
          <label htmlFor="m-role">Role</label>
          <select id="m-role" className="input" value={form.role} onChange={set("role")}>{ROLES.map(([v, l, n]) => <option key={v} value={v}>{l}: {n}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="m-limit">Approval limit (₹)</label><input id="m-limit" className="input" inputMode="decimal" value={form.limitRupees} onChange={set("limitRupees")} /></div>
        <div className="field"><label htmlFor="m-pass">First password (new people only)</label><input id="m-pass" className="input" type="password" autoComplete="new-password" value={form.initialPassword} onChange={set("initialPassword")} /></div>
        <div className="field" style={{ alignSelf: "end" }}><button className="btn primary" disabled={busy}>Add person</button></div>
      </form>
    </Card>
  );
}

function CompanySettings() {
  const { can } = useAuth();
  const state = useLoad(() => get<Company>("/api/company"), []);
  const editable = can("company.update");
  const [form, setForm] = useState<{ tallyCompanyName: string; allowNegativeStock: boolean; billRateTolerancePct: string; billQtyTolerancePct: string; billAmountRupees: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = state.data;
  const current = form ?? (c ? { tallyCompanyName: c.tallyCompanyName, allowNegativeStock: c.allowNegativeStock, billRateTolerancePct: c.billRateTolerancePct, billQtyTolerancePct: c.billQtyTolerancePct, billAmountRupees: String(Math.floor(c.billAmountTolerancePaise / 100)) } : null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    setError(null);
    setNotice(null);
    const rupees = Number(current.billAmountRupees);
    if (!Number.isInteger(rupees)) {
      setError("Enter the rounding allowance in whole rupees.");
      return;
    }
    try {
      await api("PATCH", "/api/company", {
        tallyCompanyName: current.tallyCompanyName,
        allowNegativeStock: current.allowNegativeStock,
        billRateTolerancePct: current.billRateTolerancePct,
        billQtyTolerancePct: current.billQtyTolerancePct,
        billAmountTolerancePaise: rupees * 100,
      });
      setForm(null);
      setNotice("Settings saved.");
      state.reload();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <Card title="Company" note={c ? `${c.legalName}${c.gstin ? ` · GSTIN ${c.gstin}` : ""} · state code ${c.stateCode}` : undefined}>
      <Loading state={state}>
        {current ? (
          <form onSubmit={save} className="grid cols-2">
            {notice ? <Alert kind="ok">{notice}</Alert> : null}
            {error ? <Alert>{error}</Alert> : null}
            <div className="field"><label htmlFor="s-tally">Company name in Tally</label><input id="s-tally" className="input" disabled={!editable} value={current.tallyCompanyName} onChange={(e) => setForm({ ...current, tallyCompanyName: e.target.value })} /></div>
            <div className="field">
              <label htmlFor="s-neg">Stock</label>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input id="s-neg" type="checkbox" disabled={!editable} checked={current.allowNegativeStock} onChange={(e) => setForm({ ...current, allowNegativeStock: e.target.checked })} /> Allow stock to go below zero</label>
            </div>
            <div className="field"><label htmlFor="s-rate">Bill rate tolerance (%)</label><input id="s-rate" className="input" inputMode="decimal" disabled={!editable} value={current.billRateTolerancePct} onChange={(e) => setForm({ ...current, billRateTolerancePct: e.target.value })} /></div>
            <div className="field"><label htmlFor="s-qty">Bill quantity tolerance (%)</label><input id="s-qty" className="input" inputMode="decimal" disabled={!editable} value={current.billQtyTolerancePct} onChange={(e) => setForm({ ...current, billQtyTolerancePct: e.target.value })} /></div>
            <div className="field"><label htmlFor="s-amt">Rounding allowance on a bill (₹)</label><input id="s-amt" className="input" inputMode="numeric" disabled={!editable} value={current.billAmountRupees} onChange={(e) => setForm({ ...current, billAmountRupees: e.target.value })} /></div>
            {editable ? <div className="field" style={{ alignSelf: "end" }}><button className="btn primary" disabled={form === null}>Save settings</button></div> : null}
          </form>
        ) : null}
      </Loading>
    </Card>
  );
}
