import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb, pgErrorCode } from "../db/client";
import { auditLog, boms, items, locations, memberships, parties, uoms, users, warehouses } from "../db/schema";
import { createBom } from "./boms";
import { createCompany } from "./company";
import { createItem } from "./items";
import { allocateDocNumber } from "./numbering";
import { createParty } from "./parties";
import { errorText, expectDomainError, gstinFrom } from "./test-helpers";

let db: Db;
let client: Awaited<ReturnType<typeof openDb>>["client"];

const MAHARASHTRA = gstinFrom("27ABCDE1234F1Z");
const KARNATAKA = gstinFrom("29AABCU9603R1Z");
const GUJARAT = gstinFrom("24AAACC1206D1Z");

beforeAll(async () => {
  ({ db, client } = await openDb());
});

describe("createCompany", () => {
  it("sets up owner, units, warehouse, locations and an audit entry", async () => {
    const { company, owner } = await createCompany(db, {
      legalName: "Sunrise Garments Pvt Ltd",
      gstin: MAHARASHTRA,
      owner: { email: "Owner@Sunrise.example", name: "A. Owner" },
    });
    expect(company.stateCode).toBe("27");
    expect(company.pan).toBe("ABCDE1234F");
    expect(company.tallyCompanyName).toBe("Sunrise Garments Pvt Ltd");
    expect(owner.email).toBe("owner@sunrise.example");

    const member = await db.select().from(memberships).where(eq(memberships.companyId, company.id));
    expect(member).toHaveLength(1);
    expect(member[0]).toMatchObject({ role: "owner", userId: owner.id });

    expect(await db.select().from(uoms).where(eq(uoms.companyId, company.id))).toHaveLength(22);
    expect(await db.select().from(warehouses).where(eq(warehouses.companyId, company.id))).toHaveLength(1);
    const locs = await db.select().from(locations).where(eq(locations.companyId, company.id));
    // One stock location for each of the ten default plant areas, plus the five virtual ones
    expect([...new Set(locs.map((l) => l.kind))].sort()).toEqual(["adjustment", "customer", "internal", "production", "supplier", "transit"]);
    expect(locs.filter((l) => l.kind === "internal")).toHaveLength(10);
    expect(locs.filter((l) => l.isPrimary).map((l) => l.name)).toEqual(["Main / Stock"]);
    expect(locs.filter((l) => l.warehouseId === null)).toHaveLength(5);

    const log = await db.select().from(auditLog).where(eq(auditLog.companyId, company.id));
    expect(log.map((l) => l.action)).toEqual(["company.created"]);
  });

  it("works without a GSTIN when a state is given", async () => {
    const { company } = await createCompany(db, {
      legalName: "Small Workshop",
      stateCode: "09",
      owner: { email: "w@workshop.example", name: "W" },
    });
    expect(company.gstin).toBeNull();
    expect(company.stateCode).toBe("09");
  });

  it("rejects bad input and writes nothing", async () => {
    const owner = { email: "x@bad.example", name: "X" };
    await expectDomainError(
      createCompany(db, { legalName: "Bad", gstin: "27ABCDE1234F1ZZ", owner }),
      "INVALID_GSTIN",
    );
    await expectDomainError(
      createCompany(db, { legalName: "Bad", gstin: MAHARASHTRA, stateCode: "29", owner }),
      "GSTIN_STATE_MISMATCH",
    );
    await expectDomainError(createCompany(db, { legalName: "Bad", owner }), "STATE_REQUIRED");
    expect(await db.select().from(users).where(eq(users.email, "x@bad.example"))).toHaveLength(0);
  });

  it("reuses an existing user and refuses a second company with the same GSTIN", async () => {
    const first = await createCompany(db, {
      legalName: "Multi Co A",
      gstin: GUJARAT,
      owner: { email: "multi@group.example", name: "Multi" },
    });
    const second = await createCompany(db, {
      legalName: "Multi Co B",
      stateCode: "24",
      owner: { email: "MULTI@group.example", name: "Multi" },
    });
    expect(second.owner.id).toBe(first.owner.id);

    await expect(
      createCompany(db, { legalName: "Copycat", gstin: GUJARAT, owner: { email: "c@copy.example", name: "C" } }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === "23505");
    // The failure happened inside the transaction, after the owner row was inserted: it must roll back.
    expect(await db.select().from(users).where(eq(users.email, "c@copy.example"))).toHaveLength(0);
  });
});

describe("audit log is append-only", () => {
  it("blocks UPDATE, DELETE and TRUNCATE", async () => {
    const { company } = await createCompany(db, {
      legalName: "Audit Co",
      stateCode: "07",
      owner: { email: "a@audit.example", name: "A" },
    });
    await expect(db.update(auditLog).set({ action: "tampered" }).where(eq(auditLog.companyId, company.id))).rejects.toSatisfy(
      (e) => errorText(e).includes("append-only"),
    );
    await expect(db.delete(auditLog).where(eq(auditLog.companyId, company.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("append-only"),
    );
    await expect(client.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);
    expect(await db.select().from(auditLog).where(eq(auditLog.companyId, company.id))).toHaveLength(1);
  });
});

describe("document numbering", () => {
  let companyId: string;
  let otherCompanyId: string;
  beforeAll(async () => {
    companyId = (await createCompany(db, { legalName: "Num Co", stateCode: "27", owner: { email: "n@num.example", name: "N" } })).company.id;
    otherCompanyId = (await createCompany(db, { legalName: "Num Co 2", stateCode: "27", owner: { email: "n2@num.example", name: "N" } })).company.id;
  });

  it("issues consecutive numbers per document type and financial year", async () => {
    const issue = (docType: "sales_invoice" | "purchase_order", date: string, id = companyId) =>
      db.transaction((tx) => allocateDocNumber(tx, { companyId: id, docType, date }));

    expect(await issue("sales_invoice", "2025-06-01")).toBe("INV/25-26/00001");
    expect(await issue("sales_invoice", "2026-03-31")).toBe("INV/25-26/00002");
    expect(await issue("purchase_order", "2025-06-01")).toBe("PO/25-26/00001");
    // A new financial year starts again at 1.
    expect(await issue("sales_invoice", "2026-04-01")).toBe("INV/26-27/00001");
    // Another company has its own series.
    expect(await issue("sales_invoice", "2025-06-01", otherCompanyId)).toBe("INV/25-26/00001");
  });

  it("gives the number back if the document's transaction rolls back (no gaps)", async () => {
    const attempt = db.transaction(async (tx) => {
      const n = await allocateDocNumber(tx, { companyId, docType: "credit_note", date: "2025-07-01" });
      expect(n).toBe("CN/25-26/00001");
      throw new Error("document failed to save");
    });
    await expect(attempt).rejects.toThrow("document failed to save");
    const retry = await db.transaction((tx) => allocateDocNumber(tx, { companyId, docType: "credit_note", date: "2025-07-01" }));
    expect(retry).toBe("CN/25-26/00001");
  });
});

describe("company isolation is enforced by the database", () => {
  let a: string;
  let b: string;
  beforeAll(async () => {
    a = (await createCompany(db, { legalName: "Iso A", stateCode: "27", owner: { email: "a@iso.example", name: "A" } })).company.id;
    b = (await createCompany(db, { legalName: "Iso B", stateCode: "27", owner: { email: "b@iso.example", name: "B" } })).company.id;
  });

  it("refuses an item that uses another company's unit", async () => {
    const [uomOfA] = await db.select().from(uoms).where(and(eq(uoms.companyId, a), eq(uoms.code, "KGS")));
    await expect(
      db.insert(items).values({ companyId: b, sku: "LEAK", name: "Leak", kind: "trading", uomId: (uomOfA as { id: string }).id }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === "23503");
  });

  it("refuses a location in another company's warehouse", async () => {
    const [whOfA] = await db.select().from(warehouses).where(eq(warehouses.companyId, a));
    await expect(
      db.insert(locations).values({ companyId: b, warehouseId: (whOfA as { id: string }).id, name: "Sneaky", kind: "internal" }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === "23503");
  });

  it("refuses a BOM line that uses another company's item", async () => {
    await createItem(db, { companyId: a, sku: "FG", name: "Finished", kind: "finished", uomCode: "PCS" });
    await createItem(db, { companyId: a, sku: "RM", name: "Raw", kind: "raw_material", uomCode: "KGS" });
    await createItem(db, { companyId: b, sku: "FG", name: "Finished", kind: "finished", uomCode: "PCS" });
    // Component SKUs are looked up inside the caller's company, so A's "RM" is invisible to B.
    await expectDomainError(
      createBom(db, { companyId: b, outputSku: "FG", lines: [{ componentSku: "RM", qty: 1 }] }),
      "UNKNOWN_ITEM",
    );
  });
});

describe("parties", () => {
  let companyId: string;
  beforeAll(async () => {
    companyId = (await createCompany(db, { legalName: "Party Co", stateCode: "27", owner: { email: "p@party.example", name: "P" } })).company.id;
  });

  it("derives state and PAN from a valid GSTIN", async () => {
    const party = await createParty(db, { companyId, kind: "supplier", name: "Mewar Weaving Mills", gstin: KARNATAKA.toLowerCase(), isMsme: true, creditDays: 30 });
    expect(party).toMatchObject({ gstin: KARNATAKA, stateCode: "29", pan: "AABCU9603R", registrationType: "regular", tallyLedgerName: "Mewar Weaving Mills", isMsme: true });
    const log = await db.select().from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.entityId, party.id)));
    expect(log.map((l) => l.action)).toEqual(["party.created"]);
  });

  it("applies the GSTIN and state rules", async () => {
    await expectDomainError(createParty(db, { companyId, kind: "customer", name: "X", gstin: "29AABCU9603R1ZZ" }), "INVALID_GSTIN");
    await expectDomainError(createParty(db, { companyId, kind: "customer", name: "X", gstin: GUJARAT, stateCode: "27" }), "GSTIN_STATE_MISMATCH");
    await expectDomainError(createParty(db, { companyId, kind: "customer", name: "X" }), "STATE_REQUIRED");
    await expectDomainError(createParty(db, { companyId, kind: "customer", name: "X", stateCode: "27", registrationType: "regular" }), "GSTIN_REQUIRED");
    await expectDomainError(createParty(db, { companyId, kind: "customer", name: "X", gstin: GUJARAT, registrationType: "unregistered" }), "GSTIN_NOT_ALLOWED");
    const walkIn = await createParty(db, { companyId, kind: "customer", name: "Walk-in", stateCode: "27" });
    expect(walkIn).toMatchObject({ gstin: null, registrationType: "unregistered" });
  });

  it("refuses a duplicate GSTIN in one company but allows it in another", async () => {
    const other = (await createCompany(db, { legalName: "Party Co 2", stateCode: "29", owner: { email: "p2@party.example", name: "P" } })).company.id;
    await createParty(db, { companyId, kind: "supplier", name: "First", gstin: GUJARAT });
    await expectDomainError(createParty(db, { companyId, kind: "supplier", name: "Second", gstin: GUJARAT }), "DUPLICATE_GSTIN");
    await expect(createParty(db, { companyId: other, kind: "supplier", name: "Elsewhere", gstin: GUJARAT })).resolves.toBeDefined();
  });

  it("the database itself rejects a GSTIN that disagrees with the state", async () => {
    await expect(
      db.insert(parties).values({ companyId, kind: "customer", name: "Raw", gstin: GUJARAT, registrationType: "regular", stateCode: "27" }),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === "23514");
  });
});

describe("items", () => {
  let companyId: string;
  beforeAll(async () => {
    companyId = (await createCompany(db, { legalName: "Item Co", stateCode: "27", owner: { email: "i@item.example", name: "I" } })).company.id;
  });

  it("creates an item against a unit code and stores the rate with two decimals", async () => {
    const item = await createItem(db, { companyId, sku: "FAB-OX-BLU", name: "Oxford fabric, blue", kind: "raw_material", hsnSac: "5208", gstRate: 5, uomCode: "mtr", purchasePrice: "241.5", reorderLevel: 500 });
    expect(item).toMatchObject({ hsnSac: "5208", gstRate: "5.00", tallyItemName: "Oxford fabric, blue", reorderLevel: "500.000" });
  });

  it("applies the item rules", async () => {
    await expectDomainError(createItem(db, { companyId, sku: "A", name: "A", kind: "trading", uomCode: "NOS", hsnSac: "52" }), "INVALID_HSN");
    await expectDomainError(createItem(db, { companyId, sku: "A", name: "A", kind: "trading", uomCode: "NOS", gstRate: "7" }), "INVALID_GST_RATE");
    await expectDomainError(createItem(db, { companyId, sku: "A", name: "A", kind: "trading", uomCode: "NOS", gstRate: "12" }), "INVALID_GST_RATE");
    await expect(createItem(db, { companyId, sku: "OLD", name: "Old stock", kind: "trading", uomCode: "NOS", gstRate: "12", allowLegacyRate: true })).resolves.toBeDefined();
    await expectDomainError(createItem(db, { companyId, sku: "A", name: "A", kind: "trading", uomCode: "XYZ" }), "UNKNOWN_UOM");
    await expectDomainError(createItem(db, { companyId, sku: "FAB-OX-BLU", name: "Dup", kind: "trading", uomCode: "NOS" }), "DUPLICATE_SKU");
    await expectDomainError(createItem(db, { companyId, sku: "N", name: "N", kind: "trading", uomCode: "NOS", reorderLevel: -1 }), "NEGATIVE_QUANTITY");
  });
});

describe("bills of materials", () => {
  let companyId: string;
  const item = (sku: string, kind: "finished" | "semi_finished" | "raw_material" | "service", uomCode = "PCS") =>
    createItem(db, { companyId, sku, name: sku, kind, uomCode });

  beforeAll(async () => {
    companyId = (await createCompany(db, { legalName: "Bom Co", stateCode: "27", owner: { email: "b@bom.example", name: "B" } })).company.id;
    await item("SHIRT", "finished");
    await item("PANEL", "semi_finished");
    await item("FABRIC", "raw_material", "MTR");
    await item("BUTTON", "raw_material");
    await item("STITCHING", "service");
  });

  it("creates version 1, then replaces it with version 2", async () => {
    const v1 = await createBom(db, { companyId, outputSku: "SHIRT", lines: [{ componentSku: "FABRIC", qty: "1.6", scrapPct: "5" }, { componentSku: "BUTTON", qty: 8 }] });
    expect(v1.version).toBe(1);
    const v2 = await createBom(db, { companyId, outputSku: "SHIRT", lines: [{ componentSku: "FABRIC", qty: "1.5" }] });
    expect(v2.version).toBe(2);
    const all = await db.select().from(boms).where(eq(boms.companyId, companyId));
    expect(all.filter((b) => b.isActive).map((b) => b.version)).toEqual([2]);
  });

  it("rejects a component that would make the structure circular", async () => {
    await createBom(db, { companyId, outputSku: "SHIRT", lines: [{ componentSku: "PANEL", qty: 2 }] });
    // PANEL -> SHIRT while SHIRT -> PANEL would loop.
    await expectDomainError(createBom(db, { companyId, outputSku: "PANEL", lines: [{ componentSku: "SHIRT", qty: 1 }] }), "BOM_CYCLE");
    await expectDomainError(createBom(db, { companyId, outputSku: "SHIRT", lines: [{ componentSku: "SHIRT", qty: 1 }] }), "BOM_CYCLE");
  });

  it("applies the remaining BOM rules", async () => {
    await expectDomainError(createBom(db, { companyId, outputSku: "FABRIC", lines: [{ componentSku: "BUTTON", qty: 1 }] }), "NOT_PRODUCIBLE");
    await expectDomainError(createBom(db, { companyId, outputSku: "PANEL", lines: [{ componentSku: "STITCHING", qty: 1 }] }), "NOT_STOCKED");
    await expectDomainError(createBom(db, { companyId, outputSku: "PANEL", lines: [{ componentSku: "NOPE", qty: 1 }] }), "UNKNOWN_ITEM");
    await expectDomainError(createBom(db, { companyId, outputSku: "PANEL", lines: [{ componentSku: "FABRIC", qty: 0 }] }), "INVALID_QTY");
    await expectDomainError(createBom(db, { companyId, outputSku: "PANEL", lines: [{ componentSku: "FABRIC", qty: 1, scrapPct: 100 }] }), "INVALID_SCRAP");
    await expectDomainError(
      createBom(db, { companyId, outputSku: "PANEL", lines: [{ componentSku: "FABRIC", qty: 1 }, { componentSku: "FABRIC", qty: 2 }] }),
      "DUPLICATE_COMPONENT",
    );
  });
});
