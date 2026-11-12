import { useEffect, useState, type FormEvent } from "react";
import { STATES } from "../../../src/domain/states";
import { get, messageOf, post } from "../api";
import { useAuth } from "../auth";
import { Alert, Page } from "../ui";

const Logo = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true" width="28" height="28">
    <rect width="32" height="32" rx="7" fill="var(--accent)" />
    <path d="M9 22V10h10M9 16h8M9 22h10" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
  </svg>
);

export function Login() {
  const { signIn } = useAuth();
  const [signup, setSignup] = useState<"unknown" | "off" | "on">("unknown");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    get<{ signup: boolean }>("/api/auth/options").then(
      (o) => setSignup(o.signup ? "on" : "off"),
      () => setSignup("off"),
    );
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(messageOf(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  if (creating) return <SignUp onBack={() => setCreating(false)} />;

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}><Logo /> ERP</div>
        <h1>Sign in</h1>
        {error ? <Alert>{error}</Alert> : null}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn primary" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="muted" style={{ margin: 0 }}>Forgot your password? Ask an owner or admin of your company to give you a temporary one.</p>
        {signup === "on" ? <button type="button" className="btn ghost" onClick={() => setCreating(true)}>Create a company</button> : null}
      </form>
    </main>
  );
}

/** Create a company and its first owner. Only offered when the server has sign-up switched on. */
function SignUp({ onBack }: { onBack: () => void }) {
  const { refresh } = useAuth();
  const [form, setForm] = useState({ legalName: "", gstin: "", stateCode: "", name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/register", {
        legalName: form.legalName,
        ...(form.gstin.trim() ? { gstin: form.gstin.trim().toUpperCase() } : { stateCode: form.stateCode }),
        owner: { email: form.email.trim(), name: form.name, password: form.password },
      });
      await refresh();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}><Logo /> ERP</div>
        <h1>Create a company</h1>
        {error ? <Alert>{error}</Alert> : null}
        <div className="field"><label htmlFor="su-co">Company name (as registered)</label><input id="su-co" className="input" required autoFocus value={form.legalName} onChange={set("legalName")} /></div>
        <div className="field"><label htmlFor="su-gstin">GSTIN (optional now, needed for GST invoices)</label><input id="su-gstin" className="input" value={form.gstin} onChange={set("gstin")} autoComplete="off" /></div>
        {form.gstin.trim() ? null : (
          <div className="field">
            <label htmlFor="su-state">State (taken from the GSTIN once you have one)</label>
            <select id="su-state" className="input" required value={form.stateCode} onChange={set("stateCode")}>
              <option value="">Choose a state</option>
              {STATES.filter((s) => !s.legacy && s.code !== "97" && s.code !== "99").map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </div>
        )}
        <div className="field"><label htmlFor="su-name">Your name</label><input id="su-name" className="input" required autoComplete="name" value={form.name} onChange={set("name")} /></div>
        <div className="field"><label htmlFor="su-email">Your email</label><input id="su-email" className="input" type="email" required autoComplete="username" value={form.email} onChange={set("email")} /></div>
        <div className="field"><label htmlFor="su-pass">Password</label><input id="su-pass" className="input" type="password" required autoComplete="new-password" value={form.password} onChange={set("password")} /><span className="sub-line">At least 10 characters, and not your email or a common password.</span></div>
        <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create company"}</button>
        <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>Back to sign in</button>
      </form>
    </main>
  );
}

export function ChangePassword({ forced = false }: { forced?: boolean }) {
  const { refresh, signOut } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== again) {
      setError("The two new passwords are not the same.");
      return;
    }
    setBusy(true);
    try {
      await post("/api/auth/change-password", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setAgain("");
      setDone(true);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form className="card" onSubmit={submit} style={{ maxWidth: 420, display: "grid", gap: 14 }}>
      {forced ? <Alert kind="warn">You were given a temporary password. Choose your own before you carry on.</Alert> : null}
      {done ? <Alert kind="ok">Password changed. Your other sessions were signed out.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="field"><label htmlFor="cur">Current password</label><input id="cur" className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
      <div className="field"><label htmlFor="new">New password</label><input id="new" className="input" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} /><span className="sub-line">At least 10 characters, and not your email or a common password.</span></div>
      <div className="field"><label htmlFor="again">New password again</label><input id="again" className="input" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} /></div>
      <div className="actions">
        <button className="btn primary" disabled={busy}>Change password</button>
        {forced ? <button type="button" className="btn ghost" onClick={() => void signOut()}>Sign out</button> : null}
      </div>
    </form>
  );

  return forced ? (
    <main className="login">{form}</main>
  ) : (
    <Page title="Change password">{form}</Page>
  );
}

/** A person who can sign in but belongs to no company yet. */
export function NoCompany() {
  const { me, signOut, switchCompany } = useAuth();
  const first = me?.companies[0];
  return (
    <main className="login">
      <div className="card">
        <h1>No company yet</h1>
        <p>You are signed in as {me?.user.email}, but you are not a member of any company.</p>
        {first ? <button className="btn primary" onClick={() => void switchCompany(first.companyId)}>Open {first.companyName}</button> : <p className="muted">Ask an owner of your company to add you under People and settings.</p>}
        <button className="btn" onClick={() => void signOut()}>Sign out</button>
      </div>
    </main>
  );
}
