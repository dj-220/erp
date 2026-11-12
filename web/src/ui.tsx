import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { messageOf } from "./api";

/* ---------------------------------------------------------------- Status chips */

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

const stroke = { fill: "none", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const ICONS: Record<Tone, ReactNode> = {
  good: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M4.8 8.3l2.2 2.2 4.2-4.4" stroke="#fff" {...stroke} />
    </>
  ),
  warning: (
    <>
      <path d="M8 1.8l6.6 11.6H1.4z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 6.2v3.3M8 11.4v.1" stroke="#0b0b0b" {...stroke} />
    </>
  ),
  serious: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M8 4.6v4M8 11v.1" stroke="#0b0b0b" {...stroke} />
    </>
  ),
  critical: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" {...stroke} />
    </>
  ),
  neutral: <circle cx="8" cy="8" r="3.4" fill="currentColor" />,
};

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`chip ${tone}`}>
      <svg viewBox="0 0 16 16" aria-hidden="true">{ICONS[tone]}</svg>
      {children}
    </span>
  );
}

const STATUS: Record<string, [Tone, string]> = {
  late: ["critical", "Late"],
  at_risk: ["warning", "At risk"],
  on_time: ["good", "On time"],
  fulfilled: ["good", "Delivered"],
  draft: ["neutral", "Draft"],
  confirmed: ["good", "Confirmed"],
  closed: ["neutral", "Closed"],
  cancelled: ["neutral", "Cancelled"],
  posted: ["good", "Posted"],
  pending_approval: ["warning", "Waiting for approval"],
  approved: ["good", "Approved"],
  rejected: ["critical", "Rejected"],
  sent: ["good", "Sent"],
  held: ["warning", "On hold"],
  matched: ["good", "Matched"],
  submitted: ["good", "Submitted"],
  done: ["good", "Done"],
  reversed: ["serious", "Reversed"],
  paid: ["neutral", "Paid out"],
  received: ["good", "Received"],
};

/** A word and an icon for any status the system uses. */
export function Status({ value }: { value: string }) {
  const [tone, label] = STATUS[value] ?? ["neutral", value.replace(/_/g, " ")];
  return <Chip tone={tone}>{label}</Chip>;
}

/* ---------------------------------------------------------------- Layout bits */

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · ERP`;
  }, [title]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
      {children}
    </>
  );
}

export function Card({ title, note, actions, children }: { title?: string; note?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {title ? (
        <div className="card-head">
          <div>
            <h2>{title}</h2>
            {note ? <p>{note}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "ok" | "warn"; children: ReactNode }) {
  return (
    <div className={`alert ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- Loading data */

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch on mount and whenever `deps` change. The previous result stays on screen, dimmed, while it reloads. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    setLoading(true);
    loadRef.current().then(
      (value) => {
        if (!live) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(messageOf(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function Loading({ state, children }: { state: Loaded<unknown>; children: ReactNode }) {
  if (state.error && state.data === undefined) return <Alert>{state.error}</Alert>;
  if (state.data === undefined) return <p className="muted" role="status">Loading…</p>;
  return (
    <div style={{ opacity: state.loading ? 0.55 : 1, transition: "opacity 0.15s" }} aria-busy={state.loading}>
      {state.error ? <Alert>{state.error}</Alert> : null}
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- Tooltip */

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

/** One floating readout. Content is React nodes (never HTML strings), so names from data cannot inject markup. */
export function useTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const showAt = useCallback((x: number, y: number, content: ReactNode) => setTip({ x, y, content }), []);
  const hide = useCallback(() => setTip(null), []);
  const handlers = (content: ReactNode) => ({
    onPointerMove: (e: React.PointerEvent) => showAt(e.clientX, e.clientY, content),
    onPointerLeave: hide,
    onFocus: (e: React.FocusEvent<Element>) => {
      const r = e.currentTarget.getBoundingClientRect();
      showAt(r.left + r.width / 2, r.top, content);
    },
    onBlur: hide,
  });
  const node = tip ? (
    <div
      className="tooltip"
      role="tooltip"
      style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: Math.max(8, tip.y - 12), transform: tip.y < 80 ? "translateY(24px)" : "translateY(-100%)" }}
    >
      {tip.content}
    </div>
  ) : null;
  return { handlers, node };
}

/* ---------------------------------------------------------------- Dialog */

/** Ask for confirmation, and for a reason when one is required. */
export function ReasonDialog({
  title,
  detail,
  confirmLabel,
  reasonLabel,
  reasonRequired = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  detail?: ReactNode;
  confirmLabel: string;
  reasonLabel?: string;
  reasonRequired?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {detail ? <div className="ink-2">{detail}</div> : null}
        {reasonLabel ? (
          <div className="field">
            <label htmlFor="reason">{reasonLabel}</label>
            <textarea id="reason" ref={field} className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        <div className="actions" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || (reasonRequired && Boolean(reasonLabel) && !reason.trim())}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Table */

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
  align?: "num";
  /** Keep the cell on one line (dates and short codes). */
  nowrap?: boolean;
}

export function DataTable<T>({ rows, columns, empty = "Nothing here yet.", rowKey }: { rows: readonly T[]; columns: readonly Column<T>[]; empty?: string; rowKey: (row: T) => string }) {
  if (rows.length === 0) return <p className="empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.header} className={c.align}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => <td key={c.header} className={[c.align, c.nowrap ? "nowrap" : ""].filter(Boolean).join(" ") || undefined}>{c.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
