import Big from "big.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor, Transactor, Tx } from "../db/client";
import { locations, plantAreas, warehouses } from "../db/schema";
import { DomainError } from "../domain/errors";
import { DEFAULT_PLANT_AREAS, PLANT_AREA_KINDS, type PlantAreaKind, checkReorder, cleanAreaName, floorOrder, isWipKind, moveDirection, nextArea } from "../domain/plant";
import { recordAudit } from "./audit";
import { createStockDocument, getStockDocument, postStockDocument } from "./inventory";
import { one } from "./util";

type Row = Record<string, unknown>;

export interface PlantArea {
  id: string;
  name: string;
  kind: PlantAreaKind;
  sortOrder: number;
  isActive: boolean;
  locationId: string;
  /** The stock location's own name, which stock documents use. */
  locationName: string;
  /** Receipts land here and deliveries leave from here unless another place is named. */
  isPrimary: boolean;
}

/** Where an entry came from: typed in, spoken, or scanned. Recorded with the audit entry. */
export const ENTRY_SOURCES = ["manual", "voice", "qr", "assistant"] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

/** The floor, in order. Switched-off areas come last and only when asked for. */
export async function listPlantAreas(db: Executor, args: { companyId: string; includeInactive?: boolean }): Promise<PlantArea[]> {
  const rows = await db
    .select({ a: plantAreas, locationName: locations.name, isPrimary: locations.isPrimary })
    .from(plantAreas)
    .innerJoin(locations, and(eq(locations.companyId, plantAreas.companyId), eq(locations.id, plantAreas.locationId)))
    .where(eq(plantAreas.companyId, args.companyId))
    .orderBy(asc(plantAreas.sortOrder), asc(plantAreas.name));
  const all = rows.map(({ a, locationName, isPrimary }) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    sortOrder: a.sortOrder,
    isActive: a.isActive,
    locationId: a.locationId,
    locationName,
    isPrimary,
  }));
  const active = floorOrder(all);
  return args.includeInactive ? [...active, ...all.filter((a) => !a.isActive)] : active;
}

/** A location name nobody else in the company is using. */
async function freeLocationName(tx: Tx, companyId: string, wanted: string): Promise<string> {
  const taken = new Set((await tx.select({ name: locations.name }).from(locations).where(eq(locations.companyId, companyId))).map((l) => l.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n += 1) if (!taken.has(`${wanted} (${n})`)) return `${wanted} (${n})`;
}

/**
 * Give a company the standard floor. The store is the warehouse's primary stock location (where
 * receipts already land); every other area gets a stock location of its own.
 */
export async function seedDefaultPlantAreas(tx: Tx, args: { companyId: string; warehouseId: string; primaryLocationId: string }) {
  let order = 0;
  for (const area of DEFAULT_PLANT_AREAS) {
    order += 1;
    let locationId = args.primaryLocationId;
    if (order > 1) {
      const location = one(
        await tx
          .insert(locations)
          .values({ companyId: args.companyId, warehouseId: args.warehouseId, name: await freeLocationName(tx, args.companyId, area.name), kind: "internal" })
          .returning(),
        "location",
      );
      locationId = location.id;
    }
    await tx.insert(plantAreas).values({ companyId: args.companyId, locationId, name: area.name, kind: area.kind, sortOrder: order });
  }
}

/** For databases created before plant areas existed: give every company without a floor the standard one. */
export async function ensureDefaultPlantAreas(db: Db): Promise<number> {
  const { rows } = await db.execute(sql`SELECT c.id FROM companies c WHERE NOT EXISTS (SELECT 1 FROM plant_areas a WHERE a.company_id = c.id)`);
  let done = 0;
  for (const r of rows as { id: string }[]) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM companies WHERE id = ${r.id} FOR UPDATE`);
      const already = await tx.select({ id: plantAreas.id }).from(plantAreas).where(eq(plantAreas.companyId, r.id)).limit(1);
      if (already.length > 0) return;
      const primary = (
        await tx.select().from(locations).where(and(eq(locations.companyId, r.id), eq(locations.isPrimary, true))).orderBy(asc(locations.name))
      )[0];
      if (!primary?.warehouseId) return;
      await seedDefaultPlantAreas(tx, { companyId: r.id, warehouseId: primary.warehouseId, primaryLocationId: primary.id });
      await recordAudit(tx, { companyId: r.id, action: "plant.layout_created", entityType: "company", entityId: r.id, after: { areas: DEFAULT_PLANT_AREAS.length } });
      done += 1;
    });
  }
  return done;
}

/** Lock the company's floor so two people changing it at once cannot leave it half done. */
async function lockFloor(tx: Tx, companyId: string) {
  one(await tx.execute(sql`SELECT id FROM companies WHERE id = ${companyId} FOR UPDATE`).then((r) => r.rows), "company");
}

export const CreatePlantAreaInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  name: z.string(),
  kind: z.enum(PLANT_AREA_KINDS),
  /** Warehouse the area is in. Defaults to "MAIN". */
  warehouseCode: z.string().trim().min(1).default("MAIN"),
});
export type CreatePlantAreaInput = z.input<typeof CreatePlantAreaInput>;

/** Add an area at the end of the floor (just before scrap areas, which stay last). */
export async function createPlantArea(db: Transactor, rawInput: CreatePlantAreaInput): Promise<PlantArea> {
  const input = CreatePlantAreaInput.parse(rawInput);
  const name = cleanAreaName(input.name);
  return db.transaction(async (tx) => {
    await lockFloor(tx, input.companyId);
    const existing = await listPlantAreas(tx, { companyId: input.companyId, includeInactive: true });
    if (existing.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      throw new DomainError("DUPLICATE_AREA", `There is already an area called "${name}"`);
    }
    const warehouse = (
      await tx.select().from(warehouses).where(and(eq(warehouses.companyId, input.companyId), eq(warehouses.code, input.warehouseCode)))
    )[0];
    if (!warehouse) throw new DomainError("UNKNOWN_WAREHOUSE", `Warehouse "${input.warehouseCode}" does not exist`);
    const location = one(
      await tx
        .insert(locations)
        .values({ companyId: input.companyId, warehouseId: warehouse.id, name: await freeLocationName(tx, input.companyId, name), kind: "internal" })
        .returning(),
      "location",
    );
    // New working areas go before the scrap areas; a new scrap area goes last.
    const active = existing.filter((a) => a.isActive);
    const firstScrap = input.kind === "scrap" ? undefined : active.find((a) => a.kind === "scrap");
    const sortOrder = firstScrap ? firstScrap.sortOrder : Math.max(0, ...existing.map((a) => a.sortOrder)) + 1;
    if (firstScrap) {
      await tx.execute(sql`UPDATE plant_areas SET sort_order = sort_order + 1 WHERE company_id = ${input.companyId} AND sort_order >= ${sortOrder}`);
    }
    const area = one(
      await tx.insert(plantAreas).values({ companyId: input.companyId, locationId: location.id, name, kind: input.kind, sortOrder }).returning(),
      "area",
    );
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "plant_area.created",
      entityType: "plant_area",
      entityId: area.id,
      after: { name, kind: input.kind, sortOrder },
    });
    return one((await listPlantAreas(tx, { companyId: input.companyId, includeInactive: true })).filter((a) => a.id === area.id), "area");
  });
}

/** Net stock in one location, by item, from posted moves. */
async function onHandAt(db: Executor, companyId: string, locationId: string): Promise<Map<string, Big>> {
  const { rows } = await db.execute(sql`
    SELECT item_id, sum(delta)::text AS qty FROM (
      SELECT item_id, qty AS delta FROM stock_moves WHERE company_id = ${companyId} AND state = 'done' AND to_location_id = ${locationId}
      UNION ALL
      SELECT item_id, -qty AS delta FROM stock_moves WHERE company_id = ${companyId} AND state = 'done' AND from_location_id = ${locationId}
    ) x GROUP BY item_id HAVING sum(delta) <> 0`);
  return new Map((rows as Row[]).map((r) => [String(r.item_id), new Big(String(r.qty))]));
}

/**
 * Rename an area, change what it is for, or switch it off or on. An area cannot be switched off
 * while it holds stock or has transfers waiting, and the store that receipts land in stays on.
 */
export async function updatePlantArea(
  db: Transactor,
  args: { companyId: string; actorUserId?: string; areaId: string; name?: string; kind?: PlantAreaKind; isActive?: boolean },
): Promise<PlantArea> {
  return db.transaction(async (tx) => {
    await lockFloor(tx, args.companyId);
    const all = await listPlantAreas(tx, { companyId: args.companyId, includeInactive: true });
    const area = all.find((a) => a.id === args.areaId);
    if (!area) throw new DomainError("UNKNOWN_AREA", "That area does not exist");
    const changes: { name?: string; kind?: PlantAreaKind; isActive?: boolean } = {};

    if (args.name !== undefined) {
      const name = cleanAreaName(args.name);
      if (all.some((a) => a.id !== area.id && a.name.toLowerCase() === name.toLowerCase())) {
        throw new DomainError("DUPLICATE_AREA", `There is already an area called "${name}"`);
      }
      if (name !== area.name) changes.name = name;
    }
    if (args.kind !== undefined && args.kind !== area.kind) changes.kind = args.kind;
    if (args.isActive !== undefined && args.isActive !== area.isActive) {
      if (!args.isActive) {
        if (area.isPrimary) throw new DomainError("AREA_IS_PRIMARY", `${area.name} is where goods are received, so it cannot be switched off`);
        if ((await onHandAt(tx, args.companyId, area.locationId)).size > 0) {
          throw new DomainError("AREA_NOT_EMPTY", `${area.name} still holds stock; move it out first`);
        }
        const pending = await tx.execute(sql`
          SELECT 1 FROM stock_moves WHERE company_id = ${args.companyId} AND state = 'draft'
            AND (from_location_id = ${area.locationId} OR to_location_id = ${area.locationId}) LIMIT 1`);
        if (pending.rows.length > 0) throw new DomainError("AREA_HAS_PENDING", `${area.name} has transfers waiting; post or cancel them first`);
      }
      changes.isActive = args.isActive;
    }
    if (Object.keys(changes).length === 0) throw new DomainError("NOTHING_TO_CHANGE", "Nothing to change");

    await tx.update(plantAreas).set(changes).where(and(eq(plantAreas.companyId, args.companyId), eq(plantAreas.id, area.id)));
    if (changes.isActive !== undefined) {
      await tx.update(locations).set({ isActive: changes.isActive }).where(and(eq(locations.companyId, args.companyId), eq(locations.id, area.locationId)));
    }
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "plant_area.updated",
      entityType: "plant_area",
      entityId: area.id,
      before: { name: area.name, kind: area.kind, isActive: area.isActive },
      after: { name: changes.name ?? area.name, kind: changes.kind ?? area.kind, isActive: changes.isActive ?? area.isActive },
    });
    return one((await listPlantAreas(tx, { companyId: args.companyId, includeInactive: true })).filter((a) => a.id === area.id), "area");
  });
}

/** Put the active areas in a new order. `areaIds` must name each active area once. */
export async function reorderPlantAreas(db: Transactor, args: { companyId: string; actorUserId?: string; areaIds: string[] }): Promise<PlantArea[]> {
  return db.transaction(async (tx) => {
    await lockFloor(tx, args.companyId);
    const all = await listPlantAreas(tx, { companyId: args.companyId, includeInactive: true });
    const active = all.filter((a) => a.isActive);
    const wanted = checkReorder(active.map((a) => a.id), args.areaIds);
    const order = [...wanted, ...all.filter((a) => !a.isActive).map((a) => a.id)];
    for (const [index, id] of order.entries()) {
      await tx.update(plantAreas).set({ sortOrder: index + 1 }).where(and(eq(plantAreas.companyId, args.companyId), eq(plantAreas.id, id)));
    }
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "plant.reordered",
      entityType: "company",
      entityId: args.companyId,
      before: { order: active.map((a) => a.name) },
      after: { order: wanted.map((id) => (active.find((a) => a.id === id) as PlantArea).name) },
    });
    return listPlantAreas(tx, { companyId: args.companyId });
  });
}

/* ---------------------------------------------------------------- What is where */

export interface AreaItem {
  sku: string;
  name: string;
  uom: string;
  /** In the area now, from posted moves. */
  onHand: string;
  /** On draft transfers that will bring more in. */
  incoming: string;
  /** On draft transfers that will take some out. */
  outgoing: string;
  /** On hand and not already promised to a draft transfer: what is free to work on or move. */
  waiting: string;
}

export interface PendingTransfer {
  documentId: string;
  docDate: string;
  reference: string | null;
  sku: string;
  name: string;
  uom: string;
  qty: string;
  /** The other end: where it comes from (incoming) or goes to (outgoing). */
  otherArea: string;
}

export interface AreaMove {
  at: string;
  docDate: string;
  documentId: string;
  number: string | null;
  docType: string;
  sku: string;
  qty: string;
  uom: string;
  direction: "in" | "out";
  /** Where it came from or went to: an area name, or "Vendors", "Customers" and so on. */
  otherPlace: string;
}

interface LocationFlow {
  items: AreaItem[];
  pendingIn: PendingTransfer[];
  pendingOut: PendingTransfer[];
}

/** Stock and draft transfers for every stock location of the company, in one pass. */
async function loadFlows(db: Executor, companyId: string): Promise<Map<string, LocationFlow>> {
  const flows = new Map<string, LocationFlow>();
  const flow = (locationId: string) => {
    let f = flows.get(locationId);
    if (!f) flows.set(locationId, (f = { items: [], pendingIn: [], pendingOut: [] }));
    return f;
  };
  const totals = new Map<string, { sku: string; name: string; uom: string; onHand: Big; incoming: Big; outgoing: Big }>();
  const total = (locationId: string, r: Row) => {
    const key = `${locationId}/${String(r.item_id)}`;
    let t = totals.get(key);
    if (!t) totals.set(key, (t = { sku: String(r.sku), name: String(r.name), uom: String(r.uom), onHand: new Big(0), incoming: new Big(0), outgoing: new Big(0) }));
    return t;
  };

  const done = await db.execute(sql`
    SELECT x.location_id, x.item_id, i.sku, i.name, u.code AS uom, sum(x.delta)::text AS qty FROM (
      SELECT to_location_id AS location_id, item_id, qty AS delta FROM stock_moves WHERE company_id = ${companyId} AND state = 'done'
      UNION ALL
      SELECT from_location_id AS location_id, item_id, -qty AS delta FROM stock_moves WHERE company_id = ${companyId} AND state = 'done'
    ) x
    JOIN locations l ON l.company_id = ${companyId} AND l.id = x.location_id AND l.kind = 'internal'
    JOIN items i ON i.company_id = ${companyId} AND i.id = x.item_id
    JOIN uoms u ON u.company_id = i.company_id AND u.id = i.uom_id
    GROUP BY x.location_id, x.item_id, i.sku, i.name, u.code HAVING sum(x.delta) <> 0`);
  for (const r of done.rows as Row[]) total(String(r.location_id), r).onHand = new Big(String(r.qty));

  const drafts = await db.execute(sql`
    SELECT m.document_id, d.doc_date, d.reference, m.item_id, i.sku, i.name, u.code AS uom, m.qty::text AS qty,
           m.from_location_id, m.to_location_id, lf.kind AS from_kind, lt.kind AS to_kind,
           coalesce(af.name, lf.name) AS from_name, coalesce(at.name, lt.name) AS to_name
    FROM stock_moves m
    JOIN stock_documents d ON d.company_id = m.company_id AND d.id = m.document_id
    JOIN items i ON i.company_id = m.company_id AND i.id = m.item_id
    JOIN uoms u ON u.company_id = i.company_id AND u.id = i.uom_id
    JOIN locations lf ON lf.company_id = m.company_id AND lf.id = m.from_location_id
    JOIN locations lt ON lt.company_id = m.company_id AND lt.id = m.to_location_id
    LEFT JOIN plant_areas af ON af.company_id = m.company_id AND af.location_id = m.from_location_id
    LEFT JOIN plant_areas at ON at.company_id = m.company_id AND at.location_id = m.to_location_id
    WHERE m.company_id = ${companyId} AND m.state = 'draft'
    ORDER BY d.doc_date, d.created_at, m.line_no`);
  for (const r of drafts.rows as Row[]) {
    const base = { documentId: String(r.document_id), docDate: String(r.doc_date), reference: (r.reference as string | null) ?? null, sku: String(r.sku), name: String(r.name), uom: String(r.uom), qty: new Big(String(r.qty)).toFixed(3) };
    if (r.to_kind === "internal") {
      total(String(r.to_location_id), r).incoming = total(String(r.to_location_id), r).incoming.plus(String(r.qty));
      flow(String(r.to_location_id)).pendingIn.push({ ...base, otherArea: String(r.from_name) });
    }
    if (r.from_kind === "internal") {
      total(String(r.from_location_id), r).outgoing = total(String(r.from_location_id), r).outgoing.plus(String(r.qty));
      flow(String(r.from_location_id)).pendingOut.push({ ...base, otherArea: String(r.to_name) });
    }
  }

  for (const [key, t] of totals) {
    const locationId = key.slice(0, key.indexOf("/"));
    const free = t.onHand.minus(t.outgoing);
    flow(locationId).items.push({
      sku: t.sku,
      name: t.name,
      uom: t.uom,
      onHand: t.onHand.toFixed(3),
      incoming: t.incoming.toFixed(3),
      outgoing: t.outgoing.toFixed(3),
      waiting: (free.gt(0) ? free : new Big(0)).toFixed(3),
    });
  }
  for (const f of flows.values()) f.items.sort((a, b) => a.sku.localeCompare(b.sku));
  return flows;
}

export interface BoardArea extends PlantArea {
  /** Counts as work in progress (a process or quality-check area). */
  isWip: boolean;
  items: AreaItem[];
  pendingInCount: number;
  pendingOutCount: number;
  next: { id: string; name: string } | null;
}

/** The whole floor: each active area in order with what it holds and what is on its way in and out. */
export async function getPlantBoard(db: Executor, args: { companyId: string }): Promise<{ areas: BoardArea[] }> {
  const areas = await listPlantAreas(db, { companyId: args.companyId });
  const flows = await loadFlows(db, args.companyId);
  return {
    areas: areas.map((a) => {
      const f = flows.get(a.locationId);
      const next = nextArea(areas, a.id);
      return {
        ...a,
        isWip: isWipKind(a.kind),
        items: f?.items ?? [],
        pendingInCount: f?.pendingIn.length ?? 0,
        pendingOutCount: f?.pendingOut.length ?? 0,
        next: next ? { id: next.id, name: next.name } : null,
      };
    }),
  };
}

/** One area in full: stock by item, transfers waiting either way, and its recent history. */
export async function getPlantArea(db: Executor, args: { companyId: string; areaId: string; recent?: number }) {
  const all = await listPlantAreas(db, { companyId: args.companyId, includeInactive: true });
  const area = all.find((a) => a.id === args.areaId);
  if (!area) throw new DomainError("UNKNOWN_AREA", "That area does not exist");
  const active = all.filter((a) => a.isActive);
  const flows = await loadFlows(db, args.companyId);
  const f = flows.get(area.locationId) ?? { items: [], pendingIn: [], pendingOut: [] };
  const next = area.isActive ? nextArea(active, area.id) : undefined;

  const limit = Math.min(Math.max(args.recent ?? 25, 1), 100);
  const { rows } = await db.execute(sql`
    SELECT d.posted_at, d.doc_date, d.id AS document_id, d.number, d.doc_type, i.sku, u.code AS uom, m.qty::text AS qty,
           (m.to_location_id = ${area.locationId}) AS inbound,
           CASE WHEN m.to_location_id = ${area.locationId} THEN coalesce(af.name, lf.name) ELSE coalesce(at.name, lt.name) END AS other
    FROM stock_moves m
    JOIN stock_documents d ON d.company_id = m.company_id AND d.id = m.document_id
    JOIN items i ON i.company_id = m.company_id AND i.id = m.item_id
    JOIN uoms u ON u.company_id = i.company_id AND u.id = i.uom_id
    JOIN locations lf ON lf.company_id = m.company_id AND lf.id = m.from_location_id
    JOIN locations lt ON lt.company_id = m.company_id AND lt.id = m.to_location_id
    LEFT JOIN plant_areas af ON af.company_id = m.company_id AND af.location_id = m.from_location_id
    LEFT JOIN plant_areas at ON at.company_id = m.company_id AND at.location_id = m.to_location_id
    WHERE m.company_id = ${args.companyId} AND m.state = 'done'
      AND (m.to_location_id = ${area.locationId} OR m.from_location_id = ${area.locationId})
    ORDER BY d.posted_at DESC, m.line_no DESC
    LIMIT ${limit}`);
  const recentMoves: AreaMove[] = (rows as Row[]).map((r) => ({
    at: new Date(String(r.posted_at)).toISOString(),
    docDate: String(r.doc_date),
    documentId: String(r.document_id),
    number: (r.number as string | null) ?? null,
    docType: String(r.doc_type),
    sku: String(r.sku),
    qty: new Big(String(r.qty)).toFixed(3),
    uom: String(r.uom),
    direction: r.inbound ? "in" : "out",
    otherPlace: String(r.other),
  }));

  return {
    area: { ...area, isWip: isWipKind(area.kind) },
    next: next ? { id: next.id, name: next.name } : null,
    items: f.items,
    pendingIncoming: f.pendingIn,
    pendingOutgoing: f.pendingOut,
    recentMoves,
  };
}

/* ---------------------------------------------------------------- Moving material */

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());

export const MovePlantStockInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  fromAreaId: z.uuid(),
  /** Leave out to send it to the next stage along the floor. */
  toAreaId: z.uuid().optional(),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  lines: z.array(z.object({ sku: z.string().trim().min(1), qty: decimal })).min(1, "Say what is being moved"),
  reference: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
  /** False leaves a draft for the receiving area to confirm. */
  post: z.boolean().default(true),
  source: z.enum(ENTRY_SOURCES).default("manual"),
});
export type MovePlantStockInput = z.input<typeof MovePlantStockInput>;

/**
 * Move material from one area to another (by default, to the next stage). It is an ordinary stock
 * transfer, so stock in each area stays worked out from the moves. Going backwards is rework and
 * going to a scrap area is a reject; both are allowed and recorded as such.
 */
export async function movePlantStock(db: Transactor, rawInput: MovePlantStockInput) {
  const input = MovePlantStockInput.parse(rawInput);
  return db.transaction(async (tx) => {
    const areas = await listPlantAreas(tx, { companyId: input.companyId });
    const from = areas.find((a) => a.id === input.fromAreaId);
    if (!from) throw new DomainError("UNKNOWN_AREA", "The area to move from does not exist or is switched off");
    const to = input.toAreaId ? areas.find((a) => a.id === input.toAreaId) : nextArea(areas, from.id);
    if (!to) {
      throw input.toAreaId
        ? new DomainError("UNKNOWN_AREA", "The area to move to does not exist or is switched off")
        : new DomainError("NO_NEXT_AREA", `${from.name} is the last stage; choose where this should go`);
    }
    const direction = moveDirection(areas, from.id, to.id);
    const draft = await createStockDocument(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      docType: "transfer",
      docDate: input.docDate,
      reference: input.reference ?? `${from.name} to ${to.name}`,
      notes: input.notes,
      lines: input.lines.map((l) => ({ sku: l.sku, qty: l.qty, fromLocation: from.locationName, toLocation: to.locationName })),
    });
    if (input.post) await postStockDocument(tx, { companyId: input.companyId, documentId: draft.id, actorUserId: input.actorUserId });
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "plant.moved",
      entityType: "stock_document",
      entityId: draft.id,
      after: { from: from.name, to: to.name, direction, posted: input.post, source: input.source, lines: input.lines.map((l) => ({ sku: l.sku, qty: l.qty })) },
    });
    return {
      document: await getStockDocument(tx, { companyId: input.companyId, documentId: draft.id }),
      from: { id: from.id, name: from.name },
      to: { id: to.id, name: to.name },
      direction,
    };
  });
}

/** Total quantity of each item sitting in work-in-progress areas (process and quality check). */
export async function getWipByItem(db: Executor, args: { companyId: string }): Promise<{ sku: string; name: string; uom: string; qty: string; areas: { area: string; qty: string }[] }[]> {
  const { areas } = await getPlantBoard(db, args);
  const out = new Map<string, { sku: string; name: string; uom: string; qty: Big; areas: { area: string; qty: string }[] }>();
  for (const a of areas.filter((x) => x.isWip)) {
    for (const i of a.items) {
      let row = out.get(i.sku);
      if (!row) out.set(i.sku, (row = { sku: i.sku, name: i.name, uom: i.uom, qty: new Big(0), areas: [] }));
      row.qty = row.qty.plus(i.onHand);
      row.areas.push({ area: a.name, qty: i.onHand });
    }
  }
  return [...out.values()].map((r) => ({ ...r, qty: r.qty.toFixed(3) })).sort((a, b) => a.sku.localeCompare(b.sku));
}

