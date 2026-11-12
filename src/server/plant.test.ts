import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { auditLog, plantAreas } from "../db/schema";
import { DEFAULT_PLANT_AREAS } from "../domain/plant";
import { createCompany } from "./company";
import { cancelStockDocument, createStockDocument, postStockDocument } from "./inventory";
import { createItem } from "./items";
import { createPlantArea, ensureDefaultPlantAreas, getPlantArea, getPlantBoard, getWipByItem, listPlantAreas, movePlantStock, reorderPlantAreas, updatePlantArea } from "./plant";
import { getStockBalances, getStockValuation } from "./stock-queries";
import { expectDomainError, freshGstin } from "./test-helpers";

let db: Db;
let seq = 0;

beforeAll(async () => {
  ({ db } = await openDb());
});

/** A company with the standard floor, one raw material (500 m of steel rod in the store) and one part. */
async function factory(label = "Plant") {
  seq += 1;
  const { company, owner } = await createCompany(db, { legalName: `${label} ${seq}`, gstin: freshGstin("27"), owner: { email: `plant${seq}@plant.example`, name: "Owner" } });
  const c = company.id;
  await createItem(db, { companyId: c, sku: "ROD", name: "Steel rod", kind: "raw_material", uomCode: "MTR", purchasePrice: "100" });
  await createItem(db, { companyId: c, sku: "BOLT", name: "M8 bolt", kind: "finished", uomCode: "PCS", salesPrice: "5" });
  const grn = await createStockDocument(db, { companyId: c, docType: "goods_receipt", docDate: "2025-06-01", lines: [{ sku: "ROD", qty: 500, unitCost: "100" }] });
  await postStockDocument(db, { companyId: c, documentId: grn.id });
  const areas = await listPlantAreas(db, { companyId: c });
  const area = (name: string) => {
    const found = areas.find((a) => a.name === name);
    if (!found) throw new Error(`No area ${name}`);
    return found;
  };
  const move = (from: string, to: string | undefined, qty: number, extra: Record<string, unknown> = {}) =>
    movePlantStock(db, { companyId: c, actorUserId: owner.id, fromAreaId: area(from).id, ...(to ? { toAreaId: area(to).id } : {}), docDate: "2025-06-02", lines: [{ sku: "ROD", qty }], ...extra });
  const held = async (name: string) => (await getPlantArea(db, { companyId: c, areaId: area(name).id })).items.find((i) => i.sku === "ROD");
  return { c, owner: owner.id, areas, area, move, held };
}

describe("the factory floor", () => {
  it("gives a new company the standard layout, with the store on the main stock location", async () => {
    const f = await factory();
    expect(f.areas.map((a) => a.name)).toEqual(DEFAULT_PLANT_AREAS.map((a) => a.name));
    expect(f.areas.map((a) => a.sortOrder)).toEqual(f.areas.map((_, i) => i + 1));
    expect(f.areas[0]).toMatchObject({ kind: "store", isPrimary: true, locationName: "Main / Stock" });
    expect(f.areas.slice(1).every((a) => !a.isPrimary)).toBe(true);
    expect(new Set(f.areas.map((a) => a.locationId)).size).toBe(f.areas.length);
    // Goods received with no location named are in the store
    expect(await f.held("Raw Material Store")).toMatchObject({ onHand: "500.000", waiting: "500.000" });
  });

  it("adds the standard layout to a company that has none, once", async () => {
    const f = await factory();
    await db.delete(plantAreas).where(eq(plantAreas.companyId, f.c));
    expect(await listPlantAreas(db, { companyId: f.c })).toEqual([]);
    expect(await ensureDefaultPlantAreas(db)).toBe(1);
    expect(await ensureDefaultPlantAreas(db)).toBe(0);
    const again = await listPlantAreas(db, { companyId: f.c });
    expect(again.map((a) => a.name)).toEqual(DEFAULT_PLANT_AREAS.map((a) => a.name));
    expect(again[0]?.isPrimary).toBe(true);
  });

  it("moves material to the next stage and works out each area's stock from the moves", async () => {
    const f = await factory();
    const first = await f.move("Raw Material Store", undefined, 200);
    expect(first).toMatchObject({ from: { name: "Raw Material Store" }, to: { name: "Cutting" }, direction: "forward" });
    expect(first.document).toMatchObject({ docType: "transfer", state: "done" });
    expect(first.document.number).toMatch(/^TRF\//);

    await f.move("Cutting", undefined, 120); // on to Machining
    expect((await f.held("Raw Material Store"))?.onHand).toBe("300.000");
    expect((await f.held("Cutting"))?.onHand).toBe("80.000");
    expect((await f.held("Machining"))?.onHand).toBe("120.000");

    // Moving between areas changes neither the company's total stock nor its value
    const total = (await getStockBalances(db, { companyId: f.c, sku: "ROD" })).reduce((s, b) => s + Number(b.qty), 0);
    expect(total).toBe(500);
    expect((await getStockValuation(db, { companyId: f.c })).totalValuePaise).toBe(5_000_000);
  });

  it("refuses to move more than an area holds, and leaves nothing behind when it refuses", async () => {
    const f = await factory();
    await f.move("Raw Material Store", "Cutting", 50);
    await expectDomainError(f.move("Cutting", "Machining", 51), "INSUFFICIENT_STOCK");
    expect((await f.held("Cutting"))?.onHand).toBe("50.000");
    expect(await f.held("Machining")).toBeUndefined();
    const board = await getPlantBoard(db, { companyId: f.c });
    expect(board.areas.every((a) => a.pendingInCount === 0 && a.pendingOutCount === 0)).toBe(true); // the failed draft did not survive
  });

  it("handles rework (a move back) and scrap as ordinary moves with their direction recorded", async () => {
    const f = await factory();
    await f.move("Raw Material Store", "Cutting", 100);
    await f.move("Cutting", "Quality Check", 100);
    const back = await f.move("Quality Check", "Cutting", 10, { reference: "Burrs: rework" });
    expect(back.direction).toBe("backward");
    const scrapped = await f.move("Quality Check", "Scrap / Rework", 5);
    expect(scrapped.direction).toBe("scrap");
    const salvaged = await f.move("Scrap / Rework", "Cutting", 2);
    expect(salvaged.direction).toBe("from_scrap");

    expect((await f.held("Quality Check"))?.onHand).toBe("85.000");
    expect((await f.held("Cutting"))?.onHand).toBe("12.000");
    expect((await f.held("Scrap / Rework"))?.onHand).toBe("3.000");
    // Scrap is not a "next stage": from the last process the next stage is quality check, never scrap
    await expectDomainError(f.move("Scrap / Rework", undefined, 1), "NO_NEXT_AREA");
    await expectDomainError(f.move("Cutting", "Cutting", 1), "SAME_AREA");

    const wip = await getWipByItem(db, { companyId: f.c });
    expect(wip).toEqual([{ sku: "ROD", name: "Steel rod", uom: "MTR", qty: "97.000", areas: [{ area: "Cutting", qty: "12.000" }, { area: "Quality Check", qty: "85.000" }] }]);

    const log = await db.select().from(auditLog).where(eq(auditLog.companyId, f.c));
    const moves = log.filter((l) => l.action === "plant.moved").map((l) => l.after as { direction: string; source: string });
    expect(moves.map((m) => m.direction)).toEqual(["forward", "forward", "backward", "scrap", "from_scrap"]);
    expect(moves.every((m) => m.source === "manual")).toBe(true);
  });

  it("shows a transfer left for the receiver as pending at both ends until it is posted", async () => {
    const f = await factory();
    const sent = await f.move("Raw Material Store", "Cutting", 40, { post: false, source: "qr" });
    expect(sent.document.state).toBe("draft");

    const store = await getPlantArea(db, { companyId: f.c, areaId: f.area("Raw Material Store").id });
    expect(store.items[0]).toMatchObject({ onHand: "500.000", outgoing: "40.000", waiting: "460.000" });
    expect(store.pendingOutgoing).toEqual([expect.objectContaining({ sku: "ROD", qty: "40.000", otherArea: "Cutting", documentId: sent.document.id })]);
    const cutting = await getPlantArea(db, { companyId: f.c, areaId: f.area("Cutting").id });
    expect(cutting.items[0]).toMatchObject({ onHand: "0.000", incoming: "40.000", waiting: "0.000" });
    expect(cutting.pendingIncoming).toEqual([expect.objectContaining({ otherArea: "Raw Material Store" })]);
    expect(cutting.next).toMatchObject({ name: "Machining" });

    await postStockDocument(db, { companyId: f.c, documentId: sent.document.id });
    const after = await getPlantArea(db, { companyId: f.c, areaId: f.area("Cutting").id });
    expect(after.items[0]).toMatchObject({ onHand: "40.000", incoming: "0.000", waiting: "40.000" });
    expect(after.pendingIncoming).toEqual([]);
    expect(after.recentMoves[0]).toMatchObject({ sku: "ROD", qty: "40.000", direction: "in", otherPlace: "Raw Material Store", docType: "transfer" });
    const storeAfter = await getPlantArea(db, { companyId: f.c, areaId: f.area("Raw Material Store").id });
    expect(storeAfter.recentMoves.map((m) => [m.direction, m.otherPlace])).toEqual([["out", "Cutting"], ["in", "Vendors"]]);
    const audit = (await db.select().from(auditLog).where(eq(auditLog.companyId, f.c))).find((l) => l.action === "plant.moved");
    expect(audit?.after).toMatchObject({ source: "qr", posted: false });
  });

  it("lets the layout be changed: add, rename, reorder, switch off and on", async () => {
    const f = await factory();
    const heat = await createPlantArea(db, { companyId: f.c, actorUserId: f.owner, name: "  Heat   treatment ", kind: "process" });
    expect(heat.name).toBe("Heat treatment");
    let names = (await listPlantAreas(db, { companyId: f.c })).map((a) => a.name);
    expect(names.at(-1)).toBe("Scrap / Rework"); // scrap stays last
    expect(names.at(-2)).toBe("Heat treatment");
    await expectDomainError(createPlantArea(db, { companyId: f.c, name: "heat treatment", kind: "process" }), "DUPLICATE_AREA");
    await expectDomainError(createPlantArea(db, { companyId: f.c, name: "  ", kind: "process" }), "NAME_REQUIRED");

    const renamed = await updatePlantArea(db, { companyId: f.c, actorUserId: f.owner, areaId: f.area("Machining").id, name: "CNC" });
    expect(renamed.name).toBe("CNC");
    await expectDomainError(updatePlantArea(db, { companyId: f.c, areaId: f.area("Welding").id, name: "CNC" }), "DUPLICATE_AREA");
    await expectDomainError(updatePlantArea(db, { companyId: f.c, areaId: f.area("Welding").id, name: "Welding" }), "NOTHING_TO_CHANGE");

    // Reorder: heat treatment right after cutting
    const active = await listPlantAreas(db, { companyId: f.c });
    const ids = active.map((a) => a.id).filter((id) => id !== heat.id);
    ids.splice(2, 0, heat.id);
    names = (await reorderPlantAreas(db, { companyId: f.c, actorUserId: f.owner, areaIds: ids })).map((a) => a.name);
    expect(names.slice(0, 4)).toEqual(["Raw Material Store", "Cutting", "Heat treatment", "CNC"]);
    await expectDomainError(reorderPlantAreas(db, { companyId: f.c, areaIds: ids.slice(1) }), "INCOMPLETE_ORDER");
    // "Next stage" follows the new order
    expect((await f.move("Raw Material Store", "Cutting", 30)).to.name).toBe("Cutting");
    expect((await f.move("Cutting", undefined, 30)).to.name).toBe("Heat treatment");

    // Switching off: not while it holds stock, not the receiving store; an empty one is fine and "next" skips it
    await expectDomainError(updatePlantArea(db, { companyId: f.c, areaId: heat.id, isActive: false }), "AREA_NOT_EMPTY");
    await expectDomainError(updatePlantArea(db, { companyId: f.c, areaId: f.area("Raw Material Store").id, isActive: false }), "AREA_IS_PRIMARY");
    await updatePlantArea(db, { companyId: f.c, actorUserId: f.owner, areaId: f.area("Machining").id, isActive: false });
    expect((await listPlantAreas(db, { companyId: f.c })).map((a) => a.name)).not.toContain("CNC");
    expect((await listPlantAreas(db, { companyId: f.c, includeInactive: true })).find((a) => a.name === "CNC")?.isActive).toBe(false);
    const onward = await movePlantStock(db, { companyId: f.c, fromAreaId: heat.id, docDate: "2025-06-02", lines: [{ sku: "ROD", qty: 30 }] });
    expect(onward.to.name).toBe("Welding");
    await expectDomainError(movePlantStock(db, { companyId: f.c, fromAreaId: f.area("Welding").id, toAreaId: f.area("Machining").id, docDate: "2025-06-03", lines: [{ sku: "ROD", qty: 1 }] }), "UNKNOWN_AREA");
    await updatePlantArea(db, { companyId: f.c, areaId: f.area("Machining").id, isActive: true });
    expect((await listPlantAreas(db, { companyId: f.c })).map((a) => a.name)).toContain("CNC");

    const actions = (await db.select().from(auditLog).where(eq(auditLog.companyId, f.c))).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["plant_area.created", "plant_area.updated", "plant.reordered"]));
  });

  it("will not switch off an area with a transfer waiting", async () => {
    const f = await factory();
    const sent = await f.move("Raw Material Store", "Welding", 5, { post: false });
    await expectDomainError(updatePlantArea(db, { companyId: f.c, areaId: f.area("Welding").id, isActive: false }), "AREA_HAS_PENDING");
    await cancelStockDocument(db, { companyId: f.c, documentId: sent.document.id });
    expect((await updatePlantArea(db, { companyId: f.c, areaId: f.area("Welding").id, isActive: false })).isActive).toBe(false);
  });

  it("keeps one company's floor away from another's", async () => {
    const a = await factory("Mine");
    const b = await factory("Theirs");
    await expectDomainError(getPlantArea(db, { companyId: a.c, areaId: b.area("Cutting").id }), "UNKNOWN_AREA");
    await expectDomainError(updatePlantArea(db, { companyId: a.c, areaId: b.area("Cutting").id, name: "Hijack" }), "UNKNOWN_AREA");
    await expectDomainError(movePlantStock(db, { companyId: a.c, fromAreaId: a.area("Raw Material Store").id, toAreaId: b.area("Cutting").id, docDate: "2025-06-02", lines: [{ sku: "ROD", qty: 1 }] }), "UNKNOWN_AREA");
    await expectDomainError(reorderPlantAreas(db, { companyId: a.c, areaIds: b.areas.map((x) => x.id) }), "UNKNOWN_AREA");
    expect((await b.held("Raw Material Store"))?.onHand).toBe("500.000");
  });
});
