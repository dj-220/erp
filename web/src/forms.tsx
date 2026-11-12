import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { get, messageOf } from "./api";
import { Alert, Loading, useLoad } from "./ui";

/** Move to another page of the app. */
export const go = (path: string) => {
  window.location.hash = `#${path}`;
};

/* ---------------------------------------------------------------- Lookups */

export interface PartyRef { id: string; name: string; kind: string; gstin: string | null; stateCode: string; creditDays: number }
export interface ItemRef { id: string; sku: string; name: string; kind: string; uom: string; gstRate: string; salesPrice: string | null; purchasePrice: string | null; hsnSac: string | null }
export interface WarehouseRef { code: string; name: string; stateCode: string; locations: { name: string; kind: string; isPrimary: boolean }[] }
export interface UomRef { code: string; name: string; decimals: number }

export interface Lookups {
  parties: PartyRef[];
  items: ItemRef[];
  uoms: UomRef[];
  warehouses: WarehouseRef[];
}

/** The people, items, units and warehouses a form needs to offer as choices. */
export function useLookups() {
  return useLoad<Lookups>(async () => {
    const [parties, items, uoms, warehouses] = await Promise.all([
      get<{ rows: PartyRef[] }>("/api/parties?limit=200"),
      get<{ rows: ItemRef[] }>("/api/items?limit=200"),
      get<UomRef[]>("/api/uoms"),
      get<WarehouseRef[]>("/api/warehouses"),
    ]);
    return { parties: parties.rows, items: items.rows, uoms, warehouses };
  }, []);
}

/* ---------------------------------------------------------------- Submitting */

/** Run an action with a busy flag and an error message, for any form or button. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/* ---------------------------------------------------------------- Fields */

export function Field({ label, id, hint, children, wide }: { label: string; id: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="field" style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? <span className="sub-line">{hint}</span> : null}
    </div>
  );
}

export function TextField({ label, id, value, onChange, hint, required, type = "text", inputMode, placeholder, wide }: {
  label: string; id: string; value: string; onChange: (v: string) => void; hint?: ReactNode; required?: boolean;
  type?: string; inputMode?: "decimal" | "numeric" | "text"; placeholder?: string; wide?: boolean;
}) {
  return (
    <Field label={label} id={id} hint={hint} wide={wide}>
      <input id={id} className="input" type={type} inputMode={inputMode} required={required} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function SelectField({ label, id, value, onChange, options, hint, required, blank }: {
  label: string; id: string; value: string; onChange: (v: string) => void; options: readonly (readonly [string, string])[];
  hint?: ReactNode; required?: boolean; blank?: string;
}) {
  return (
    <Field label={label} id={id} hint={hint}>
      <select id={id} className="input" required={required} value={value} onChange={(e) => onChange(e.target.value)}>
        {blank !== undefined ? <option value="">{blank}</option> : null}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </Field>
  );
}

export function TextArea({ label, id, value, onChange, hint }: { label: string; id: string; value: string; onChange: (v: string) => void; hint?: ReactNode }) {
  return (
    <Field label={label} id={id} hint={hint} wide>
      <textarea id={id} className="input" rows={2} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function CheckField({ label, id, checked, onChange }: { label: string; id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field" style={{ alignSelf: "end" }}>
      <label htmlFor={id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
    </div>
  );
}

/** A form body: a grid of fields, an error line, and the buttons. */
export function FormShell({ onSubmit, busy, error, submitLabel, onCancel, children }: {
  onSubmit: () => Promise<void> | void; busy: boolean; error: string | null; submitLabel: string; onCancel?: () => void; children: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmit();
  };
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
      {error ? <Alert>{error}</Alert> : null}
      {children}
      <div className="actions">
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
        {onCancel ? <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button> : null}
      </div>
    </form>
  );
}

export const Grid = ({ children }: { children: ReactNode }) => (
  <div className="grid cols-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>{children}</div>
);

/* ---------------------------------------------------------------- Line grid */

export type Line = Record<string, string>;
export interface LineColumn {
  key: string;
  label: string;
  kind: "sku" | "text" | "num" | "select";
  placeholder?: string;
  width?: number;
  /** For a "select" column: the choices as [value, label]. */
  options?: readonly (readonly [string, string])[];
}

/**
 * The lines of a document. Pick an item and its price and tax rate are filled in (you can change
 * them). Numbers stay as text until the server reads them, so no rounding happens in the browser.
 */
export function LineGrid({ columns, lines, onChange, items, defaults, addLabel = "Add line" }: {
  columns: readonly LineColumn[];
  lines: readonly Line[];
  onChange: (lines: Line[]) => void;
  items: readonly ItemRef[];
  /** Values to fill in when an item is picked. */
  defaults?: (item: ItemRef) => Line;
  addLabel?: string;
}) {
  const blank = (): Line => Object.fromEntries(columns.map((c) => [c.key, ""]));
  const set = (i: number, key: string, value: string) => {
    const next = lines.map((l) => ({ ...l }));
    const line = next[i] as Line;
    line[key] = value;
    if (key === "sku" && defaults) {
      const item = items.find((it) => it.sku === value);
      if (item) for (const [k, v] of Object.entries(defaults(item))) if (!line[k]) line[k] = v;
    }
    onChange(next);
  };
  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              {columns.map((c) => <th key={c.key} className={c.kind === "num" ? "num" : undefined}>{c.label}</th>)}
              <th><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                {columns.map((c) => (
                  <td key={c.key} style={{ minWidth: c.width ?? (c.kind === "num" ? 104 : undefined) }}>
                    {c.kind === "sku" ? (
                      <select className="input" aria-label={`${c.label}, line ${i + 1}`} value={line[c.key] ?? ""} onChange={(e) => set(i, c.key, e.target.value)}>
                        <option value="">Choose item</option>
                        {items.map((it) => <option key={it.sku} value={it.sku}>{it.sku} · {it.name}</option>)}
                      </select>
                    ) : c.kind === "select" ? (
                      <select className="input" aria-label={`${c.label}, line ${i + 1}`} value={line[c.key] ?? ""} onChange={(e) => set(i, c.key, e.target.value)}>
                        <option value="">{c.placeholder ?? "Choose"}</option>
                        {(c.options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    ) : (
                      <input
                        className="input"
                        style={c.kind === "num" ? { textAlign: "right" } : undefined}
                        aria-label={`${c.label}, line ${i + 1}`}
                        inputMode={c.kind === "num" ? "decimal" : "text"}
                        placeholder={c.placeholder}
                        value={line[c.key] ?? ""}
                        onChange={(e) => set(i, c.key, e.target.value)}
                      />
                    )}
                  </td>
                ))}
                <td><button type="button" className="btn small ghost" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 1} onClick={() => onChange(lines.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p><button type="button" className="btn small" onClick={() => onChange([...lines, blank()])}>{addLabel}</button></p>
    </div>
  );
}

export const newLine = (columns: readonly LineColumn[]): Line => Object.fromEntries(columns.map((c) => [c.key, ""]));

/** A line without its empty boxes, ready to send. Numbers stay text. */
export function clean(line: Line): Line {
  return Object.fromEntries(Object.entries(line).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
}

/** Wait for lookups, then show the form. */
export function WithLookups({ children }: { children: (l: Lookups) => ReactNode }) {
  const state = useLookups();
  return <Loading state={state}>{state.data ? children(state.data) : null}</Loading>;
}

/* ---------------------------------------------------------------- Dialog */

/** A dialog for a short form. Escape or a click outside closes it. */
export function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width, maxHeight: "90vh", overflowY: "auto" }}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Label and value pairs at the top of a document. */
export function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "12px 24px", margin: 0 }}>
      {items.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <div key={k}>
          <dt className="muted" style={{ fontSize: 12 }}>{k}</dt>
          <dd style={{ margin: 0, fontWeight: 550 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Run a document action (a POST), then say so and reload. */
export function useDocActions(reload: () => void) {
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, setError, run } = useSubmit();
  const act = (label: string, work: () => Promise<unknown>, after?: () => void) =>
    run(async () => {
      setNotice(null);
      await work();
      setNotice(label);
      reload();
      after?.();
    });
  return { notice, setNotice, busy, error, setError, act };
}
