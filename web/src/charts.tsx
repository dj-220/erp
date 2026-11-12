import { useEffect, useRef, useState } from "react";
import { inr, inrShort, monthLabel, niceScale } from "./format";
import { DataTable, useTooltip } from "./ui";

/** Chart or table: every chart has a table twin, so no value is only reachable by hovering. */
export function ViewToggle({ value, onChange }: { value: "chart" | "table"; onChange: (v: "chart" | "table") => void }) {
  return (
    <div className="seg" role="group" aria-label="View">
      {(["chart", "table"] as const).map((v) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {v === "chart" ? "Chart" : "Table"}
        </button>
      ))}
    </div>
  );
}

function useWidth<T extends HTMLElement>(fallback = 560) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    observer.observe(el);
    setWidth(Math.max(280, Math.floor(el.clientWidth || fallback)));
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width] as const;
}

/** A column that is square at the baseline and rounded (4px) at the data end. */
function columnPath(x: number, base: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  const top = base - h;
  return `M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${base} Z`;
}

export interface TrendPoint {
  month: string;
  salesPaise: number;
  purchasesPaise: number;
}

/**
 * Sales and purchases by month. Two series of one kind of thing (taxable value in rupees) on a
 * single axis, grouped columns, a legend, and the biggest column labelled directly.
 */
export function TrendChart({ data, view }: { data: readonly TrendPoint[]; view: "chart" | "table" }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTooltip();
  if (view === "table") {
    return (
      <DataTable
        rows={data}
        rowKey={(r) => r.month}
        columns={[
          { header: "Month", render: (r) => monthLabel(r.month) },
          { header: "Sales", align: "num", render: (r) => inr(r.salesPaise) },
          { header: "Purchases", align: "num", render: (r) => inr(r.purchasesPaise) },
        ]}
      />
    );
  }
  const height = 232;
  const m = { left: 54, right: 6, top: 22, bottom: 26 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  const empty = data.every((d) => d.salesPaise === 0 && d.purchasesPaise === 0);
  // With nothing to show, still draw a believable axis (up to ₹1 lakh) instead of a row of zeros.
  const top = empty ? 10_000_000 : Math.max(1, ...data.flatMap((d) => [d.salesPaise, d.purchasesPaise]));
  const { max, step } = niceScale(top);
  const y = (v: number) => m.top + innerH - (v / max) * innerH;
  const base = m.top + innerH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const band = innerW / Math.max(1, data.length);
  const barW = Math.max(6, Math.min(24, band * 0.3));
  const gap = 2;
  const biggest = data.flatMap((d, i) => [{ i, v: d.salesPaise, k: 0 }, { i, v: d.purchasesPaise, k: 1 }]).reduce((a, b) => (b.v > a.v ? b : a), { i: 0, v: 0, k: 0 });

  return (
    <div>
      <div className="legend">
        <span><i style={{ background: "var(--series-1)" }} />Sales</span>
        <span><i style={{ background: "var(--series-2)" }} />Purchases</span>
        <span className="muted">Taxable value, before GST</span>
      </div>
      <div className="chart" ref={ref}>
        <svg width={width} height={height} role="group" aria-label="Sales and purchases by month">
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? "base-line" : "grid-line"} x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} />
              <text className="axis-label" x={m.left - 8} y={y(t) + 4} textAnchor="end">{t === 0 ? "0" : inrShort(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = m.left + band * i + band / 2;
            const x1 = cx - barW - gap / 2;
            const x2 = cx + gap / 2;
            const content = (
              <>
                <div className="t-head">{monthLabel(d.month)}</div>
                <div className="t-row"><span className="t-name"><span className="t-key" style={{ background: "var(--series-1)" }} />Sales</span><span className="t-val">{inr(d.salesPaise)}</span></div>
                <div className="t-row"><span className="t-name"><span className="t-key" style={{ background: "var(--series-2)" }} />Purchases</span><span className="t-val">{inr(d.purchasesPaise)}</span></div>
              </>
            );
            const sh = (d.salesPaise / max) * innerH;
            const ph = (d.purchasesPaise / max) * innerH;
            return (
              <g key={d.month} className="hit" tabIndex={0} role="img" aria-label={`${monthLabel(d.month)}: sales ${inr(d.salesPaise)}, purchases ${inr(d.purchasesPaise)}`} {...tip.handlers(content)}>
                <rect className="focus-ring" x={m.left + band * i + 2} y={m.top} width={band - 4} height={innerH + 2} rx={6} />
                <rect x={m.left + band * i} y={m.top} width={band} height={innerH} fill="transparent" />
                {d.salesPaise > 0 ? <path className="bar" d={columnPath(x1, base, barW, sh)} fill="var(--series-1)" /> : null}
                {d.purchasesPaise > 0 ? <path className="bar" d={columnPath(x2, base, barW, ph)} fill="var(--series-2)" /> : null}
                {biggest.i === i && biggest.v > 0 ? (
                  <text className="value-label" x={biggest.k === 0 ? x1 + barW / 2 : x2 + barW / 2} y={y(biggest.v) - 6} textAnchor="middle">{inrShort(biggest.v)}</text>
                ) : null}
                <text className="axis-label" x={cx} y={height - 8} textAnchor="middle">{monthLabel(d.month)}</text>
              </g>
            );
          })}
        </svg>
        {empty ? <p className="muted" style={{ position: "absolute", inset: "40% 0 auto", textAlign: "center" }}>No sales or purchases posted in these months.</p> : null}
        {tip.node}
      </div>
    </div>
  );
}

const BUCKET_LABELS: [key: string, label: string][] = [
  ["not_due", "Not yet due"],
  ["1_30", "1–30 days late"],
  ["31_60", "31–60 days late"],
  ["61_90", "61–90 days late"],
  ["over_90", "Over 90 days"],
];

/**
 * What is owed, by how late it is. The reading order (not due, then later and later) is the
 * information, so the rows keep it; one hue because the entity (receivable or payable) is the
 * identity, and the length carries the amount.
 */
export function AgeingBars({ buckets, color, noun, view }: { buckets: Record<string, number>; color: string; noun: string; view: "chart" | "table" }) {
  const tip = useTooltip();
  const total = BUCKET_LABELS.reduce((s, [k]) => s + (buckets[k] ?? 0), 0);
  if (view === "table") {
    return (
      <DataTable
        rows={BUCKET_LABELS}
        rowKey={([k]) => k}
        columns={[
          { header: "Age", render: ([, label]) => label },
          { header: "Amount", align: "num", render: ([k]) => inr(buckets[k] ?? 0) },
          { header: "Share", align: "num", render: ([k]) => (total ? `${Math.round(((buckets[k] ?? 0) / total) * 100)}%` : "–") },
        ]}
      />
    );
  }
  if (total === 0) return <p className="empty">Nothing {noun}.</p>;
  const max = Math.max(...BUCKET_LABELS.map(([k]) => buckets[k] ?? 0));
  return (
    <div className="chart" role="group" aria-label={`${noun} by age`}>
      {BUCKET_LABELS.map(([key, label]) => {
        const value = buckets[key] ?? 0;
        const content = (
          <>
            <div className="t-head">{label}</div>
            <div className="t-row"><span className="t-name"><span className="t-key" style={{ background: color }} />{noun}</span><span className="t-val">{inr(value)}</span></div>
            <div className="t-row"><span className="t-name">Share</span><span className="t-val">{Math.round((value / total) * 100)}%</span></div>
          </>
        );
        return (
          <div key={key} className="hbar-row" tabIndex={0} aria-label={`${label}: ${inr(value)}`} {...tip.handlers(content)}>
            <span className="name">{label}</span>
            <span className="hbar-track">
              <span className="hbar-fill" style={{ width: `${Math.max(value ? 1 : 0, (value / max) * 78)}%`, background: color }} />
              <span className="hbar-value">{value ? inrShort(value) : "–"}</span>
            </span>
          </div>
        );
      })}
      {tip.node}
    </div>
  );
}

/** Stock against its reorder level. The fill goes from accent to warning to danger as stock runs down. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const color = ratio <= 0.5 ? "var(--critical)" : ratio < 1 ? "var(--warning)" : "var(--accent)";
  return (
    <div className="meter" role="img" aria-label={label} style={ratio < 1 ? { background: "var(--grid)" } : undefined}>
      <i style={{ width: `${Math.max(ratio * 100, 3)}%`, background: color }} />
    </div>
  );
}
