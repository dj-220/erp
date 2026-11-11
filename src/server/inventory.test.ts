import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb, pgErrorCode } from "../db/client";
import { auditLog, companies, locations, stockDocuments, stockMoves, warehouses } from "../db/schema";
import { createBom } from "./boms";
import { createCompany } from "./company";
import {
  cancelStockDocument,
  createStockCount,
  createStockDocument,
  getStockDocument,
  postStockDocument,
} from "./inventory";
import { createItem } from "./items";
import { createParty } from "./parties";
import { calculateShortages, getReorderSuggestions, getStockBalances, getStockValuation } from "./stock-queries";
import { errorText, expectDomainError } from "./test-helpers";

let db: Db;
let counter = 0;

beforeAll(async () => {
  ({ db } = await openDb());
});

/** A fresh company, so each group of tests starts from empty stock. */
async function newCompany(label: string) {
  counter += 1;
  const { company } = await createCompany(db, {
    legalName: `${label} ${counter}`,
    stateCode: "27",
    owner: { email: `owner${counter}@stock.example`, name: "Owner" },
  });
  return company.id;
}

const stockItem = (
  companyId: string,
  sku: string,
  uomCode: string,
  extra: Partial<Parameters<typeof createItem>[1]> = {},
) => createItem(db, { companyId, sku, name: sku, kind: "raw_material", uomCode, ...extra });

/** Create and post a document in one go; returns the posted document with its lines. */
async function run(companyId: string, input: Omit<Parameters<typeof createStockDocument>[1], "companyId">) {
  const draft = await createStockDocument(db, { companyId, ...input });
  await postStockDocument(db, { companyId, documentId: draft.id });
  return getStockDocument(db, { companyId, documentId: draft.id });
}

const receive = (companyId: string, sku: string, qty: number | string, unitCost: string, docDate = "2025-06-01") =>
  run(companyId, { docType: "goods_receipt", docDate, lines: [{ sku, qty, unitCost }] });
const deliver = (companyId: string, sku: string, qty: number | string, docDate = "2025-06-02") =>
  run(companyId, { docType: "delivery", docDate, lines: [{ sku, qty }] });

describe("receipts, deliveries and weighted-average valuation", () => {
  it("values stock at the running average and uses up its value exactly", async () => {
    const c = await newCompany("Valuation");
    await stockItem(c, "FAB", "MTR");

    const r1 = await receive(c, "FAB", 100, "10");
    expect(r1.number).toBe("GRN/25-26/00001");
    expect(r1.state).toBe("done");
    expect(r1.lines).toMatchObject([{ from: "Vendors", to: "Main / Stock", qty: "100.000", valuePaise: 100000, state: "done" }]);

    await receive(c, "FAB", 100, "20", "2025-06-15");
    let v = await getStockValuation(db, { companyId: c });
    expect(v.rows).toEqual([{ sku: "FAB", name: "FAB", uom: "MTR", qty: "200.000", valuePaise: 300000, avgCost: "15.0000" }]);

    // 50 of the 200 leave at the Rs 15 average: Rs 750
    const d1 = await deliver(c, "FAB", 50);
    expect(d1.number).toBe("DEL/25-26/00001");
    expect(d1.lines[0]).toMatchObject({ from: "Main / Stock", to: "Customers", valuePaise: 75000 });
    v = await getStockValuation(db, { companyId: c });
    expect(v.rows[0]).toMatchObject({ qty: "150.000", valuePaise: 225000, avgCost: "15.0000" });

    // Issue the rest: all remaining value goes with it
    const d2 = await deliver(c, "FAB", 150);
    expect(d2.lines[0]?.valuePaise).toBe(225000);
    v = await getStockValuation(db, { companyId: c });
    expect(v).toEqual({ rows: [], totalValuePaise: 0 });
  });

  it("starts a new numbering series each financial year", async () => {
    const c = await newCompany("Numbering");
    await stockItem(c, "FAB", "MTR");
    expect((await receive(c, "FAB", 1, "1", "2026-03-31")).number).toBe("GRN/25-26/00001");
    expect((await receive(c, "FAB", 1, "1", "2026-04-01")).number).toBe("GRN/26-27/00001");
  });

  it("leaves no rounding residue when issuing a piece at a time", async () => {
    const c = await newCompany("Residue");
    await stockItem(c, "BTN", "PCS");
    // 3 pieces at Rs 0.3333 = Rs 0.9999, which rounds to 100 paise
    const r = await receive(c, "BTN", 3, "0.3333");
    expect(r.lines[0]?.valuePaise).toBe(100);
    const issued = [(await deliver(c, "BTN", 1)).lines[0]?.valuePaise, (await deliver(c, "BTN", 1)).lines[0]?.valuePaise, (await deliver(c, "BTN", 1)).lines[0]?.valuePaise];
    expect(issued).toEqual([33, 34, 33]);
    expect(await getStockValuation(db, { companyId: c })).toEqual({ rows: [], totalValuePaise: 0 });
  });

  it("records who did what in the audit log", async () => {
    const c = await newCompany("Audit");
    await stockItem(c, "FAB", "MTR");
    const doc = await receive(c, "FAB", 1, "1");
    const log = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, c), eq(auditLog.entityId, doc.id)));
    expect(log.map((l) => l.action)).toEqual(["stock_document.created", "stock_document.posted"]);
  });
});

describe("availability and all-or-nothing posting", () => {
  it("refuses to deliver stock that is not there, and does not use up a number", async () => {
    const c = await newCompany("Availability");
    await stockItem(c, "FAB", "MTR");
    await receive(c, "FAB", 5, "10");

    const tooMuch = await createStockDocument(db, { companyId: c, docType: "delivery", docDate: "2025-06-02", lines: [{ sku: "FAB", qty: 10 }] });
    await expectDomainError(postStockDocument(db, { companyId: c, documentId: tooMuch.id }), "INSUFFICIENT_STOCK");
    const still = await getStockDocument(db, { companyId: c, documentId: tooMuch.id });
    expect(still).toMatchObject({ state: "draft", number: null });

    // The failed attempt did not consume DEL/25-26/00001
    expect((await deliver(c, "FAB", 3)).number).toBe("DEL/25-26/00001");

    await cancelStockDocument(db, { companyId: c, documentId: tooMuch.id });
    expect((await getStockDocument(db, { companyId: c, documentId: tooMuch.id })).state).toBe("cancelled");
    await expectDomainError(postStockDocument(db, { companyId: c, documentId: tooMuch.id }), "NOT_DRAFT");
  });

  it("counts earlier lines of the same document, and rolls everything back if a later line fails", async () => {
    const c = await newCompany("Rollback");
    await stockItem(c, "FAB", "MTR");
    await receive(c, "FAB", 4, "10");
    const doc = await createStockDocument(db, {
      companyId: c,
      docType: "delivery",
      docDate: "2025-06-02",
      lines: [{ sku: "FAB", qty: 3 }, { sku: "FAB", qty: 3 }], // only 4 in stock for 6
    });
    await expectDomainError(postStockDocument(db, { companyId: c, documentId: doc.id }), "INSUFFICIENT_STOCK");
    const after = await getStockDocument(db, { companyId: c, documentId: doc.id });
    expect(after.state).toBe("draft");
    expect(after.lines.map((l) => l.state)).toEqual(["draft", "draft"]);
    expect(await getStockBalances(db, { companyId: c })).toMatchObject([{ sku: "FAB", qty: "4.000" }]);
  });

  it("cannot post twice or cancel a posted document", async () => {
    const c = await newCompany("Twice");
    await stockItem(c, "FAB", "MTR");
    const posted = await receive(c, "FAB", 1, "1");
    await expectDomainError(postStockDocument(db, { companyId: c, documentId: posted.id }), "NOT_DRAFT");
    await expectDomainError(cancelStockDocument(db, { companyId: c, documentId: posted.id }), "NOT_DRAFT");
    await expectDomainError(postStockDocument(db, { companyId: c, documentId: crypto.randomUUID() }), "UNKNOWN_DOCUMENT");
  });

  it("lets stock go negative only when the company allows it, valuing it at the purchase price", async () => {
    const c = await newCompany("Negative");
    await stockItem(c, "NEG", "PCS", { purchasePrice: "7" });
    await expectDomainError(deliver(c, "NEG", 5), "INSUFFICIENT_STOCK");

    await db.update(companies).set({ allowNegativeStock: true }).where(eq(companies.id, c));
    const d = await deliver(c, "NEG", 5);
    expect(d.lines[0]?.valuePaise).toBe(3500); // 5 x Rs 7
    expect(await getStockBalances(db, { companyId: c })).toMatchObject([{ sku: "NEG", qty: "-5.000" }]);
  });
});

describe("transfers and stock counts", () => {
  let c: string;
  beforeAll(async () => {
    c = await newCompany("Transfers");
    await stockItem(c, "FAB", "MTR");
    const warehouse = (await db.select().from(warehouses).where(eq(warehouses.companyId, c)))[0];
    await db.insert(locations).values({ companyId: c, warehouseId: warehouse?.id as string, name: "Main / Rack A", kind: "internal" });
    await receive(c, "FAB", 100, "10");
  });

  it("moves stock between locations without changing its value", async () => {
    await run(c, { docType: "transfer", docDate: "2025-06-03", lines: [{ sku: "FAB", qty: 40, fromLocation: "Main / Stock", toLocation: "Main / Rack A" }] });
    expect(await getStockBalances(db, { companyId: c })).toEqual([
      { sku: "FAB", name: "FAB", uom: "MTR", location: "Main / Rack A", qty: "40.000" },
      { sku: "FAB", name: "FAB", uom: "MTR", location: "Main / Stock", qty: "60.000" },
    ]);
    expect((await getStockValuation(db, { companyId: c })).rows[0]).toMatchObject({ qty: "100.000", valuePaise: 100000 });
    // Filters
    expect(await getStockBalances(db, { companyId: c, locationName: "Main / Rack A" })).toHaveLength(1);
    expect(await getStockBalances(db, { companyId: c, sku: "NOPE" })).toEqual([]);
  });

  it("enforces transfer rules", async () => {
    const t = (fromLocation: string, toLocation: string, qty = 1) =>
      createStockDocument(db, { companyId: c, docType: "transfer", docDate: "2025-06-03", lines: [{ sku: "FAB", qty, fromLocation, toLocation }] });
    await expectDomainError(t("Main / Stock", "Main / Stock"), "SAME_LOCATION");
    await expectDomainError(t("Main / Stock", "Vendors"), "NOT_INTERNAL_LOCATION");
    await expectDomainError(t("Main / Stock", "Nowhere"), "UNKNOWN_LOCATION");
    await expectDomainError(
      createStockDocument(db, { companyId: c, docType: "transfer", docDate: "2025-06-03", lines: [{ sku: "FAB", qty: 1 }] }),
      "LOCATION_REQUIRED",
    );
    const over = await t("Main / Rack A", "Main / Stock", 41); // only 40 at Rack A
    await expectDomainError(postStockDocument(db, { companyId: c, documentId: over.id }), "INSUFFICIENT_STOCK");
  });

  it("allows only one primary stock location per warehouse, and only an internal one", async () => {
    const warehouse = (await db.select().from(warehouses).where(eq(warehouses.companyId, c)))[0] as typeof warehouses.$inferSelect;
    await expect(
      db.insert(locations).values({ companyId: c, warehouseId: warehouse.id, name: "Main / Rack B", kind: "internal", isPrimary: true }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === "23505");
    await expect(
      db.insert(locations).values({ companyId: c, warehouseId: null, name: "Odd virtual", kind: "customer", isPrimary: true }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === "23514");
  });

  it("turns a physical count into adjustments valued at the average", async () => {
    // Books: 40 at Rack A. Counted 35 -> decrease 5 at Rs 10 = Rs 50
    const draft = await createStockCount(db, { companyId: c, docDate: "2025-06-04", location: "Main / Rack A", counts: [{ sku: "FAB", countedQty: 35 }] });
    expect(draft.moves).toHaveLength(1);
    await postStockDocument(db, { companyId: c, documentId: draft.id });
    const posted = await getStockDocument(db, { companyId: c, documentId: draft.id });
    expect(posted.lines[0]).toMatchObject({ from: "Main / Rack A", to: "Inventory adjustment", qty: "5.000", valuePaise: 5000 });
    expect(posted.number).toBe("ADJ/25-26/00001");
    expect((await getStockValuation(db, { companyId: c })).rows[0]).toMatchObject({ qty: "95.000", valuePaise: 95000 });

    // Counted 50 against 35 in the books: 15 found, at the stated cost of Rs 12 = Rs 180
    const found = await createStockCount(db, { companyId: c, docDate: "2025-06-05", location: "Main / Rack A", counts: [{ sku: "FAB", countedQty: 50, unitCost: 12 }] });
    await postStockDocument(db, { companyId: c, documentId: found.id });
    expect((await getStockValuation(db, { companyId: c })).rows[0]).toMatchObject({ qty: "110.000", valuePaise: 113000, avgCost: "10.2727" });

    // A count that agrees with the books creates nothing
    await expectDomainError(
      createStockCount(db, { companyId: c, docDate: "2025-06-06", location: "Main / Rack A", counts: [{ sku: "FAB", countedQty: 50 }] }),
      "NOTHING_TO_ADJUST",
    );
  });

  it("cannot value stock found with no known cost", async () => {
    const c2 = await newCompany("NoCost");
    await stockItem(c2, "UNPRICED", "PCS");
    const draft = await createStockCount(db, { companyId: c2, docDate: "2025-06-04", counts: [{ sku: "UNPRICED", countedQty: 5 }] });
    await expectDomainError(postStockDocument(db, { companyId: c2, documentId: draft.id }), "COST_REQUIRED");
  });
});

describe("the ledger cannot be rewritten", () => {
  it("rejects changes to posted documents and moves, however they are attempted", async () => {
    const c = await newCompany("Immutable");
    await stockItem(c, "FAB", "MTR");
    const doc = await receive(c, "FAB", 10, "10");
    const move = (await db.select().from(stockMoves).where(eq(stockMoves.documentId, doc.id)))[0] as typeof stockMoves.$inferSelect;

    await expect(db.update(stockMoves).set({ valuePaise: 1 }).where(eq(stockMoves.id, move.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("cannot be changed or deleted"),
    );
    await expect(db.delete(stockMoves).where(eq(stockMoves.id, move.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("cannot be changed or deleted"),
    );
    await expect(db.update(stockDocuments).set({ reference: "edited" }).where(eq(stockDocuments.id, doc.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("cannot be changed or deleted"),
    );
    await expect(db.delete(stockDocuments).where(eq(stockDocuments.id, doc.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("cannot be changed or deleted"),
    );
    await expect(
      db.insert(stockMoves).values({
        companyId: c,
        documentId: doc.id,
        lineNo: 99,
        itemId: move.itemId,
        fromLocationId: move.fromLocationId,
        toLocationId: move.toLocationId,
        qty: "1",
      }),
    ).rejects.toSatisfy((e) => errorText(e).includes("cannot add a stock move to a done document"));
    expect((await getStockValuation(db, { companyId: c })).totalValuePaise).toBe(10000);
  });

  it("refuses moves that point at another company's data", async () => {
    const a = await newCompany("Iso A");
    const b = await newCompany("Iso B");
    await stockItem(a, "FAB", "MTR");
    await stockItem(b, "FAB", "MTR");
    const draftB = await createStockDocument(db, { companyId: b, docType: "goods_receipt", docDate: "2025-06-01", lines: [{ sku: "FAB", qty: 1, unitCost: "1" }] });
    const locOfA = (await db.select().from(locations).where(and(eq(locations.companyId, a), eq(locations.kind, "internal"))))[0] as typeof locations.$inferSelect;
    const moveB = draftB.moves[0] as typeof stockMoves.$inferSelect;
    await expect(
      db.update(stockMoves).set({ toLocationId: locOfA.id }).where(eq(stockMoves.id, moveB.id)),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === "23503");
  });
});

describe("input rules", () => {
  let c: string;
  let supplierId: string;
  beforeAll(async () => {
    c = await newCompany("Rules");
    await stockItem(c, "FAB", "MTR");
    await stockItem(c, "BTN", "PCS");
    await stockItem(c, "BATCHY", "PCS", { trackBatch: true });
    await createItem(db, { companyId: c, sku: "SVC", name: "Stitching", kind: "service", uomCode: "NOS" });
    supplierId = (await createParty(db, { companyId: c, kind: "supplier", name: "Mill", stateCode: "29" })).id;
  });
  const doc = (docType: "goods_receipt" | "delivery" | "adjustment", line: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    createStockDocument(db, { companyId: c, docType, docDate: "2025-06-01", lines: [line as never], ...extra });

  it("validates quantities, items and costs", async () => {
    await expectDomainError(doc("goods_receipt", { sku: "BTN", qty: "1.5", unitCost: "1" }), "QTY_PRECISION");
    await expectDomainError(doc("goods_receipt", { sku: "FAB", qty: 0, unitCost: "1" }), "INVALID_QTY");
    await expectDomainError(doc("goods_receipt", { sku: "FAB", qty: "abc", unitCost: "1" }), "INVALID_NUMBER");
    await expectDomainError(doc("goods_receipt", { sku: "NOPE", qty: 1, unitCost: "1" }), "UNKNOWN_ITEM");
    await expectDomainError(doc("goods_receipt", { sku: "SVC", qty: 1, unitCost: "1" }), "NOT_STOCKED");
    await expectDomainError(doc("goods_receipt", { sku: "BATCHY", qty: 1, unitCost: "1" }), "BATCH_NOT_SUPPORTED");
    await expectDomainError(doc("goods_receipt", { sku: "FAB", qty: 1 }), "COST_REQUIRED");
    await expectDomainError(doc("goods_receipt", { sku: "FAB", qty: 1, unitCost: "-1" }), "INVALID_COST");
    await expectDomainError(doc("delivery", { sku: "FAB", qty: 1, unitCost: "1" }), "COST_NOT_ALLOWED");
  });

  it("validates locations, adjustments, dates and parties", async () => {
    await expectDomainError(doc("adjustment", { sku: "FAB", qty: 1 }), "DIRECTION_REQUIRED");
    await expectDomainError(doc("goods_receipt", { sku: "FAB", qty: 1, unitCost: "1", toLocation: "Customers" }), "NOT_INTERNAL_LOCATION");
    await expectDomainError(doc("goods_receipt", { sku: "FAB", qty: 1, unitCost: "1" }, { docDate: "2025-02-30" }), "INVALID_DATE");
    await expectDomainError(doc("goods_receipt", { sku: "FAB", qty: 1, unitCost: "1" }, { warehouseCode: "NOPE" }), "UNKNOWN_WAREHOUSE");
    await expectDomainError(doc("delivery", { sku: "FAB", qty: 1 }, { partyId: supplierId }), "WRONG_PARTY_KIND");
    await expectDomainError(doc("goods_receipt", { sku: "FAB", qty: 1, unitCost: "1" }, { partyId: crypto.randomUUID() }), "UNKNOWN_PARTY");
    await expect(doc("goods_receipt", { sku: "FAB", qty: 1, unitCost: "1" }, { partyId: supplierId })).resolves.toMatchObject({ partyId: supplierId });
    await expect(createStockDocument(db, { companyId: c, docType: "delivery", docDate: "2025-06-01", lines: [] })).rejects.toThrow();
  });
});

describe("reorder suggestions and shortages", () => {
  let c: string;
  beforeAll(async () => {
    c = await newCompany("Planning");
    await stockItem(c, "FAB", "MTR", { reorderLevel: 50, reorderQty: 200 });
    await stockItem(c, "BTN", "PCS", { reorderLevel: 100, reorderQty: 500 });
    await createItem(db, { companyId: c, sku: "SHIRT", name: "Shirt", kind: "finished", uomCode: "PCS" });
    await createBom(db, { companyId: c, outputSku: "SHIRT", lines: [{ componentSku: "FAB", qty: "1.5", scrapPct: 10 }, { componentSku: "BTN", qty: 8 }] });
    await receive(c, "FAB", 100, "10");
    await receive(c, "BTN", 500, "1");
  });

  it("works out what to buy for a demand, net of stock and incoming orders", async () => {
    // 100 shirts need 165 m of fabric (with 10% scrap) and 800 buttons
    const demands = [{ sku: "SHIRT", qty: 100, needBy: "2025-07-01" }];
    expect(await calculateShortages(db, { companyId: c, demands })).toEqual([
      { sku: "BTN", name: "BTN", uom: "PCS", qtyToBuy: "300", firstNeededBy: "2025-07-01" },
      { sku: "FAB", name: "FAB", uom: "MTR", qtyToBuy: "65.000", firstNeededBy: "2025-07-01" },
    ]);
    // 20 m already on order
    const withIncoming = await calculateShortages(db, { companyId: c, demands, incoming: [{ sku: "FAB", qty: 20 }] });
    expect(withIncoming.find((r) => r.sku === "FAB")?.qtyToBuy).toBe("45.000");
  });

  it("rejects bad demands", async () => {
    await expectDomainError(calculateShortages(db, { companyId: c, demands: [{ sku: "NOPE", qty: 1, needBy: "2025-07-01" }] }), "UNKNOWN_ITEM");
    await expectDomainError(calculateShortages(db, { companyId: c, demands: [{ sku: "SHIRT", qty: 1.5, needBy: "2025-07-01" }] }), "QTY_PRECISION");
    await expectDomainError(calculateShortages(db, { companyId: c, demands: [{ sku: "SHIRT", qty: 1, needBy: "soon" }] }), "INVALID_DATE");
  });

  it("suggests a reorder once stock falls to the level, unless more is already on order", async () => {
    expect(await getReorderSuggestions(db, { companyId: c })).toEqual([]);
    await deliver(c, "FAB", 60); // 40 m left, at or below the level of 50
    const suggestions = await getReorderSuggestions(db, { companyId: c });
    expect(suggestions).toEqual([
      { sku: "FAB", name: "FAB", uom: "MTR", onHand: "40.000", reorderLevel: "50.000", suggestedQty: "200.000" },
    ]);
    expect(await getReorderSuggestions(db, { companyId: c, incomingBySku: new Map([["FAB", 100]]) })).toEqual([]);
  });
});
