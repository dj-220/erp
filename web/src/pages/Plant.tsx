import { Fragment, useState } from "react";
import { announceChange, api, get, post } from "../api";
import { useAuth } from "../auth";
import { CheckField, FormShell, Grid, Modal, SelectField, TextField, useDocActions, useSubmit } from "../forms";
import { date, dateTime, qty, today, trimDecimal } from "../format";
import { Alert, Card, Chip, DataTable, Loading, Page, useLoad, type Tone } from "../ui";

export interface AreaItem { sku: string; name: string; uom: string; onHand: string; incoming: string; outgoing: string; waiting: string }
export interface BoardArea {
  id: string; name: string; kind: string; sortOrder: number; isActive: boolean; isPrimary: boolean; isWip: boolean; locationName: string;
  items: AreaItem[]; pendingInCount: number; pendingOutCount: number; next: { id: string; name: string } | null;
}
interface Pending { documentId: string; docDate: string; reference: string | null; sku: string; name: string; uom: string; qty: string; otherArea: string }
interface Move { at: string; docDate: string; documentId: string; number: string | null; docType: string; sku: string; qty: string; uom: string; direction: "in" | "out"; otherPlace: string }
interface AreaDetail { area: BoardArea; next: { id: string; name: string } | null; items: AreaItem[]; pendingIncoming: Pending[]; pendingOutgoing: Pending[]; recentMoves: Move[] }

const KIND: Record<string, [Tone, string]> = {
  store: ["neutral", "Store"],
  process: ["warning", "In process"],
  qc: ["warning", "Quality check"],
  finished: ["good", "Finished goods"],
  dispatch: ["good", "Dispatch"],
  scrap: ["critical", "Scrap and rework"],
};
export const KIND_OPTIONS: [string, string][] = [["store", "Store"], ["process", "Process (work in progress)"], ["qc", "Quality check"], ["finished", "Finished goods"], ["dispatch", "Dispatch"], ["scrap", "Scrap and rework"]];

export const KindChip = ({ kind }: { kind: string }) => {
  const [tone, label] = KIND[kind] ?? ["neutral", kind];
  return <Chip tone={tone}>{label}</Chip>;
};

/** The tabs across the top of Inventory: the overview, then one per area in floor order. */
function AreaTabs({ areas, current }: { areas: { id: string; name: string }[]; current: string }) {
  return (
    <nav className="tabs" aria-label="Plant areas">
      <a href="#/inventory" aria-current={current === "all" ? "page" : undefined}>All areas</a>
      {areas.map((a) => <a key={a.id} href={`#/inventory/${a.id}`} aria-current={current === a.id ? "page" : undefined}>{a.name}</a>)}
    </nav>
  );
}

export function Inventory({ areaId }: { areaId?: string }) {
  const { can } = useAuth();
  const board = useLoad(() => get<{ areas: BoardArea[] }>("/api/plant/board"), []);
  const areas = board.data?.areas ?? [];
  return (
    <Page
      title="Inventory by area"
      subtitle="What is in each part of the factory, worked out from the movements between them."
      actions={
        <>
          {can("plant.manage") ? <a className="btn" href="#/inventory/layout">Plant layout</a> : null}
          {can("stock.write") ? <a className="btn" href="#/stock/movements/new">Receive or adjust stock</a> : null}
        </>
      }
    >
      <Loading state={board}>
        <AreaTabs areas={areas} current={areaId ?? "all"} />
        {areaId ? <AreaView key={areaId} areaId={areaId} areas={areas} onChanged={board.reload} /> : <Floor areas={areas} />}
      </Loading>
    </Page>
  );
}

/* ---------------------------------------------------------------- All areas: the floor as a flow */

function Floor({ areas }: { areas: BoardArea[] }) {
  const line = areas.filter((a) => a.kind !== "scrap");
  const side = areas.filter((a) => a.kind === "scrap");
  const card = (a: BoardArea, held = a.items.filter((i) => Number(i.onHand) !== 0)) => (
    <a className="card flow-card" href={`#/inventory/${a.id}`} key={a.id}>
      <div className="flow-head"><b>{a.name}</b><KindChip kind={a.kind} /></div>
      {held.length === 0 ? <p className="muted" style={{ margin: 0 }}>Empty</p> : (
        <ul className="flow-items">
          {held.slice(0, 4).map((i) => <li key={i.sku}><span>{i.sku}</span><span className="num">{qty(i.onHand)} {i.uom}</span></li>)}
          {held.length > 4 ? <li className="muted"><span>and {held.length - 4} more</span></li> : null}
        </ul>
      )}
      {a.pendingInCount || a.pendingOutCount ? (
        <div className="sub-line">{a.pendingInCount ? `${a.pendingInCount} coming in` : ""}{a.pendingInCount && a.pendingOutCount ? " · " : ""}{a.pendingOutCount ? `${a.pendingOutCount} going out` : ""}</div>
      ) : null}
    </a>
  );
  return (
    <>
      <div className="flow" role="list" aria-label="The factory floor, in order">
        {line.map((a, i) => (
          <Fragment key={a.id}>
            {i > 0 ? <span className="flow-arrow" aria-hidden="true">→</span> : null}
            <div role="listitem" className="flow-cell">{card(a)}</div>
          </Fragment>
        ))}
      </div>
      {side.length ? (
        <>
          <h2 className="section-title">Outside the flow</h2>
          <div className="flow">{side.map((a) => <div key={a.id} className="flow-cell">{card(a)}</div>)}</div>
        </>
      ) : null}
      <Card title="Everything, by item and area" note="The same numbers as a table.">
        <DataTable
          rows={areas.flatMap((a) => a.items.map((i) => ({ ...i, area: a.name, areaId: a.id })))}
          rowKey={(r) => `${r.areaId}/${r.sku}`}
          empty="No stock anywhere yet. Receive goods to begin."
          columns={[
            { header: "Area", render: (r) => <a href={`#/inventory/${r.areaId}`}>{r.area}</a> },
            { header: "Item", render: (r) => <><b>{r.sku}</b><div className="sub-line">{r.name}</div></> },
            { header: "On hand", align: "num", render: (r) => `${qty(r.onHand)} ${r.uom}` },
            { header: "Coming in", align: "num", render: (r) => (Number(r.incoming) ? qty(r.incoming) : "") },
            { header: "Going out", align: "num", render: (r) => (Number(r.outgoing) ? qty(r.outgoing) : "") },
          ]}
        />
      </Card>
    </>
  );
}

/* ---------------------------------------------------------------- One area */

function AreaView({ areaId, areas, onChanged }: { areaId: string; areas: BoardArea[]; onChanged: () => void }) {
  const { can } = useAuth();
  const state = useLoad(() => get<AreaDetail>(`/api/plant/areas/${areaId}`), [areaId]);
  const reload = () => {
    state.reload();
    onChanged();
    announceChange();
  };
  const { notice, busy, error, act } = useDocActions(reload);
  const [moving, setMoving] = useState<{ sku?: string; toNext: boolean } | null>(null);
  const d = state.data;
  const mayMove = can("plant.move");
  const movable = d?.items.filter((i) => Number(i.waiting) > 0) ?? [];

  return (
    <Loading state={state}>
      {d ? (
        <div className="grid">
          {notice ? <Alert kind="ok">{notice}</Alert> : null}
          {error ? <Alert>{error}</Alert> : null}
          <Card
            title={d.area.name}
            note={<><KindChip kind={d.area.kind} /> {d.area.isPrimary ? "Goods received land here. " : ""}{d.next ? `Next stage: ${d.next.name}.` : d.area.kind === "scrap" ? "Rejects and rework wait here." : "Last stage."}</>}
            actions={
              mayMove && movable.length ? (
                <span className="actions">
                  {d.next ? <button className="btn primary big" onClick={() => setMoving({ toNext: true })}>Move to {d.next.name}</button> : null}
                  <button className="btn big" onClick={() => setMoving({ toNext: false })}>Move elsewhere</button>
                </span>
              ) : null
            }
          >
            <DataTable
              rows={d.items}
              rowKey={(i) => i.sku}
              empty="Nothing here right now."
              columns={[
                { header: "Item", render: (i) => <><b>{i.sku}</b><div className="sub-line">{i.name}</div></> },
                { header: "On hand", align: "num", render: (i) => `${qty(i.onHand)} ${i.uom}` },
                { header: d.area.isWip ? "Waiting to be processed" : "Free to move", align: "num", render: (i) => qty(i.waiting) },
                { header: "Coming in", align: "num", render: (i) => (Number(i.incoming) ? qty(i.incoming) : "") },
                { header: "Going out", align: "num", render: (i) => (Number(i.outgoing) ? qty(i.outgoing) : "") },
                { header: "", render: (i) => (mayMove && Number(i.waiting) > 0 ? <button className="btn small" onClick={() => setMoving({ sku: i.sku, toNext: Boolean(d.next) })}>Move</button> : null) },
              ]}
            />
          </Card>

          {d.pendingIncoming.length ? (
            <Card title="Coming in" note="Sent to this area and waiting to be confirmed as received. Stock moves only when confirmed.">
              <PendingTable rows={d.pendingIncoming} from label="Confirm received" busy={busy} onPost={can("stock.write") ? (id) => act("Received. Stock has moved into this area.", () => post(`/api/stock/documents/${id}/post`)) : undefined} onCancel={undefined} />
            </Card>
          ) : null}
          {d.pendingOutgoing.length ? (
            <Card title="Going out" note="Sent from this area, not yet confirmed at the other end.">
              <PendingTable rows={d.pendingOutgoing} from={false} label="" busy={busy} onPost={undefined} onCancel={can("stock.write") ? (id) => act("Transfer cancelled.", () => post(`/api/stock/documents/${id}/cancel`)) : undefined} />
            </Card>
          ) : null}

          <Card title="Recent movements">
            <DataTable
              rows={d.recentMoves}
              rowKey={(m) => `${m.documentId}/${m.sku}/${m.direction}`}
              empty="No movements yet."
              columns={[
                { header: "When", nowrap: true, render: (m) => <>{date(m.docDate)}<div className="sub-line">{dateTime(m.at)}</div></> },
                { header: "Item", render: (m) => <b>{m.sku}</b> },
                { header: "", render: (m) => <Chip tone={m.direction === "in" ? "good" : "neutral"}>{m.direction === "in" ? "In from" : "Out to"}</Chip> },
                { header: "Other place", render: (m) => m.otherPlace },
                { header: "Quantity", align: "num", render: (m) => `${qty(m.qty)} ${m.uom}` },
                { header: "Document", render: (m) => <a href={`#/stock/documents/${m.documentId}`}>{m.number ?? "Draft"}</a> },
              ]}
            />
          </Card>
        </div>
      ) : null}
      {moving && d ? (
        <MoveDialog
          from={d.area}
          areas={areas}
          items={movable}
          presetSku={moving.sku}
          presetTo={moving.toNext ? d.next?.id : undefined}
          onClose={() => setMoving(null)}
          onDone={(message) => {
            setMoving(null);
            act(message, async () => undefined);
          }}
        />
      ) : null}
    </Loading>
  );
}

function PendingTable({ rows, from, label, busy, onPost, onCancel }: { rows: Pending[]; from: boolean; label: string; busy: boolean; onPost?: (id: string) => void; onCancel?: (id: string) => void }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(p) => `${p.documentId}/${p.sku}`}
      columns={[
        { header: "Item", render: (p) => <><b>{p.sku}</b><div className="sub-line">{p.name}</div></> },
        { header: from ? "From" : "To", render: (p) => p.otherArea },
        { header: "Quantity", align: "num", render: (p) => `${qty(p.qty)} ${p.uom}` },
        { header: "Sent", nowrap: true, render: (p) => date(p.docDate) },
        {
          header: "",
          render: (p) => (
            <span className="actions">
              {onPost ? <button className="btn small primary" disabled={busy} onClick={() => onPost(p.documentId)}>{label}</button> : null}
              {onCancel ? <button className="btn small ghost" disabled={busy} onClick={() => onCancel(p.documentId)}>Cancel transfer</button> : null}
              <a className="btn small ghost" href={`#/stock/documents/${p.documentId}`}>Open</a>
            </span>
          ),
        },
      ]}
    />
  );
}

/** Move one or more items out of an area. Shared with the scan and voice screens, which pass `source`. */
export function MoveDialog({ from, areas, items, presetSku, presetTo, presetQty, source = "manual", onClose, onDone }: {
  from: { id: string; name: string };
  areas: BoardArea[];
  items: AreaItem[];
  presetSku?: string;
  presetTo?: string;
  presetQty?: string;
  source?: "manual" | "voice" | "qr" | "assistant";
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const others = areas.filter((a) => a.id !== from.id);
  const [toAreaId, setToAreaId] = useState(presetTo ?? "");
  const [docDate, setDocDate] = useState(today());
  const [leaveDraft, setLeaveDraft] = useState(false);
  const [reference, setReference] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>(
    Object.fromEntries(items.filter((i) => (presetSku ? i.sku === presetSku : false)).map((i) => [i.sku, presetQty ?? trimDecimal(i.waiting)])),
  );
  const { busy, error, run } = useSubmit();
  const to = others.find((a) => a.id === toAreaId);
  const backwards = to && to.kind !== "scrap" && to.sortOrder < (areas.find((a) => a.id === from.id)?.sortOrder ?? 0);

  const save = () =>
    run(async () => {
      const lines = items.filter((i) => Number(amounts[i.sku] ?? 0) > 0).map((i) => ({ sku: i.sku, qty: (amounts[i.sku] as string).trim() }));
      if (lines.length === 0) throw new Error("Enter a quantity for at least one item");
      if (!toAreaId) throw new Error("Choose where it is going");
      const done = await post<{ to: { name: string }; document: { state: string } }>("/api/plant/moves", {
        fromAreaId: from.id,
        toAreaId,
        docDate,
        lines,
        post: !leaveDraft,
        source,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      onDone(done.document.state === "done" ? `Moved to ${done.to.name}.` : `Sent to ${done.to.name}. It moves when they confirm it.`);
    });

  return (
    <Modal title={`Move from ${from.name}`} onClose={onClose} width={620}>
      <FormShell onSubmit={save} busy={busy} error={error} submitLabel={leaveDraft ? "Send" : "Move now"} onCancel={onClose}>
        <Grid>
          <SelectField id="mv-to" label="To" value={toAreaId} onChange={setToAreaId} options={others.map((a) => [a.id, a.name] as [string, string])} blank="Choose area" required />
          <TextField id="mv-date" label="Date" type="date" value={docDate} onChange={setDocDate} required />
        </Grid>
        {to?.kind === "scrap" ? <Alert kind="warn">This records the material as rejected or for rework. It stays in stock in {to.name} until you adjust it out.</Alert> : null}
        {backwards ? <Alert kind="warn">This sends material back a stage (rework).</Alert> : null}
        <DataTable
          rows={items}
          rowKey={(i) => i.sku}
          columns={[
            { header: "Item", render: (i) => <><b>{i.sku}</b><div className="sub-line">{i.name}</div></> },
            { header: "Free here", align: "num", render: (i) => `${qty(i.waiting)} ${i.uom}` },
            {
              header: "Move",
              render: (i) => (
                <span className="actions">
                  <input className="input big" style={{ textAlign: "right", maxWidth: 120 }} aria-label={`Quantity to move, ${i.sku}`} inputMode="decimal" value={amounts[i.sku] ?? ""} onChange={(e) => setAmounts({ ...amounts, [i.sku]: e.target.value })} />
                  <button type="button" className="btn small ghost" onClick={() => setAmounts({ ...amounts, [i.sku]: trimDecimal(i.waiting) })}>All</button>
                </span>
              ),
            },
          ]}
        />
        <Grid>
          <TextField id="mv-ref" label="Note (optional)" value={reference} onChange={setReference} />
          <CheckField id="mv-draft" label="Let the receiving area confirm it" checked={leaveDraft} onChange={setLeaveDraft} />
        </Grid>
      </FormShell>
    </Modal>
  );
}

/* ---------------------------------------------------------------- Layout settings */

interface AreaRow { id: string; name: string; kind: string; sortOrder: number; isActive: boolean; isPrimary: boolean }

export function PlantLayout() {
  const state = useLoad(() => get<AreaRow[]>("/api/plant/areas?all=1"), []);
  const { notice, busy, error, act } = useDocActions(() => {
    state.reload();
    announceChange();
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const [add, setAdd] = useState({ name: "", kind: "process" });
  const all = state.data ?? [];
  const active = all.filter((a) => a.isActive);

  const swap = (index: number, by: number) => {
    const ids = active.map((a) => a.id);
    const j = index + by;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j] as string, ids[index] as string];
    act("Order changed.", () => post("/api/plant/areas/reorder", { areaIds: ids }));
  };

  return (
    <Page title="Plant layout" subtitle="The areas of your factory, in the order material flows through them. Inventory shows one tab for each.">
      <p><a href="#/inventory">← Inventory by area</a></p>
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <Loading state={state}>
        <div className="grid">
          <Card title="Areas" note="Renaming or reordering changes nothing about the stock in an area. An area can be switched off only when it is empty.">
            <DataTable
              rows={all}
              rowKey={(a) => a.id}
              columns={[
                { header: "#", render: (a) => (a.isActive ? active.findIndex((x) => x.id === a.id) + 1 : "") },
                {
                  header: "Name",
                  render: (a) => (
                    <span className="actions">
                      <input className="input" aria-label={`Name of ${a.name}`} value={names[a.id] ?? a.name} onChange={(e) => setNames({ ...names, [a.id]: e.target.value })} />
                      {names[a.id] !== undefined && names[a.id]?.trim() !== a.name ? (
                        <button className="btn small primary" disabled={busy} onClick={() => act("Renamed.", async () => { await api("PATCH", `/api/plant/areas/${a.id}`, { name: names[a.id] }); setNames(({ [a.id]: _gone, ...rest }) => rest); })}>Save</button>
                      ) : null}
                    </span>
                  ),
                },
                {
                  header: "Used for",
                  render: (a) => (
                    <select className="input" aria-label={`What ${a.name} is used for`} value={a.kind} disabled={busy} onChange={(e) => act("Changed.", () => api("PATCH", `/api/plant/areas/${a.id}`, { kind: e.target.value }))}>
                      {KIND_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  ),
                },
                {
                  header: "Order",
                  render: (a) => {
                    const i = active.findIndex((x) => x.id === a.id);
                    return a.isActive ? (
                      <span className="actions">
                        <button className="btn small" aria-label={`Move ${a.name} earlier`} disabled={busy || i === 0} onClick={() => swap(i, -1)}>↑</button>
                        <button className="btn small" aria-label={`Move ${a.name} later`} disabled={busy || i === active.length - 1} onClick={() => swap(i, 1)}>↓</button>
                      </span>
                    ) : <span className="muted">Switched off</span>;
                  },
                },
                {
                  header: "",
                  render: (a) =>
                    a.isPrimary ? <span className="muted">Receiving store</span> : (
                      <button className="btn small ghost" disabled={busy} onClick={() => act(a.isActive ? `${a.name} switched off.` : `${a.name} switched on.`, () => api("PATCH", `/api/plant/areas/${a.id}`, { isActive: !a.isActive }))}>
                        {a.isActive ? "Switch off" : "Switch on"}
                      </button>
                    ),
                },
              ]}
            />
          </Card>
          <Card title="Add an area" note="It is added at the end of the line, before scrap. Move it into place afterwards.">
            <FormShell
              busy={busy}
              error={null}
              submitLabel="Add area"
              onSubmit={() => act(`${add.name.trim()} added.`, async () => { await post("/api/plant/areas", add); setAdd({ name: "", kind: "process" }); })}
            >
              <Grid>
                <TextField id="pa-name" label="Name" value={add.name} onChange={(v) => setAdd({ ...add, name: v })} required placeholder="For example, Heat treatment" />
                <SelectField id="pa-kind" label="Used for" value={add.kind} onChange={(v) => setAdd({ ...add, kind: v })} options={KIND_OPTIONS} />
              </Grid>
            </FormShell>
          </Card>
        </div>
      </Loading>
    </Page>
  );
}
