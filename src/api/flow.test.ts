import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { gstinChecksumChar } from "../domain/gstin";
import { createApp } from "./app";

const NOW = new Date("2025-08-20T10:00:00Z");
const gstin = (state: string, pan: string) => {
  const body = `${state}${pan}1Z`;
  return body + gstinChecksumChar(body);
};

class Client {
  cookie = "";
  constructor(readonly app: ReturnType<typeof createApp>) {}
  async call(method: string, path: string, body?: unknown) {
    const res = await this.app.request(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [name, value] = (pair as string).split("=");
      if (name === "erp_session") this.cookie = value && !attrs.some((a) => a.trim().toLowerCase() === "max-age=0") ? `${name}=${value}` : "";
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, headers: res.headers, buffer, text: buffer.toString("utf8") };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b?: unknown) => this.call("POST", p, b ?? {});
  patch = (p: string, b: unknown) => this.call("PATCH", p, b);
  delete = (p: string) => this.call("DELETE", p);
}

/** Expect a status and hand back the JSON, so a failing step says which one it was. */
const ok = (res: { status: number; json: any; text: string }, status = 200, label = "") => {
  expect(res.status, `${label} ${res.text.slice(0, 300)}`).toBe(status);
  return res.json;
};

describe("a whole business, through the API alone", () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let owner: Client;
  const ids: Record<string, string> = {};
  const millGstin = gstin("24", "AABCM1111M");

  beforeAll(async () => {
    ({ db } = await openDb());
    app = createApp(db, { allowSignup: true }, () => NOW);
    owner = new Client(app);
  }, 60_000);

  it("signs up a company and its owner, and signs them in", async () => {
    const res = await owner.post("/api/auth/register", { legalName: "Flow Co", gstin: gstin("27", "AAAFC1234F"), owner: { email: "founder@flow.example", name: "Founder", password: "a very long passphrase" } });
    const json = ok(res, 201, "register");
    expect(json).toMatchObject({ role: "owner", user: { email: "founder@flow.example" } });
    ids.company = json.companyId;
    expect(ok(await owner.get("/api/company"))).toMatchObject({ legalName: "Flow Co", tallyCompanyName: "Flow Co", allowNegativeStock: false });
  });

  it("sets up items and parties", async () => {
    ok(await owner.post("/api/items", { sku: "FAB", name: "Fabric", kind: "raw_material", uomCode: "MTR", hsnSac: "5208", gstRate: 5, purchasePrice: "240" }), 201);
    ok(await owner.post("/api/items", { sku: "SHIRT", name: "Shirt", kind: "finished", uomCode: "PCS", hsnSac: "6205", gstRate: 5, salesPrice: "1000" }), 201);
    ids.mill = ok(await owner.post("/api/parties", { kind: "supplier", name: "Mill", gstin: millGstin, creditDays: 30 }), 201).id;
    ids.buyer = ok(await owner.post("/api/parties", { kind: "customer", name: "Buyer", gstin: gstin("27", "AABCB2222B"), creditDays: 30 }), 201).id;
    ok(await owner.post("/api/items", { sku: "FAB", name: "Again", kind: "raw_material", uomCode: "MTR" }), 409, "duplicate SKU");
    expect(ok(await owner.get("/api/items?q=shi")).rows.map((r: { sku: string }) => r.sku)).toEqual(["SHIRT"]);
    expect(ok(await owner.get("/api/parties?kind=customer")).total).toBe(1);
    expect(ok(await owner.get("/api/uoms")).length).toBeGreaterThan(20);
    const main = ok(await owner.get("/api/warehouses"))[0] as { code: string; locations: { name: string; kind: string; isPrimary: boolean }[] };
    expect(main.code).toBe("MAIN");
    // One stock location per plant area; only the store is where receipts land by default
    expect(main.locations.filter((l) => l.isPrimary)).toEqual([expect.objectContaining({ name: "Main / Stock", kind: "internal" })]);
    expect(main.locations).toHaveLength(10);
  });

  it("buys, receives, and is billed", async () => {
    const draft = ok(await owner.post("/api/purchasing/orders", { supplierId: ids.mill, orderDate: "2025-08-01", expectedDate: "2025-08-10", lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] }), 201, "create PO");
    expect(draft).toMatchObject({ state: "draft", supplyKind: "inter", totalPaise: 2_520_000 });
    ids.po = draft.id;
    expect(ok(await owner.post(`/api/purchasing/orders/${ids.po}/submit`))).toMatchObject({ state: "approved", number: "PO/25-26/00001" });
    expect(ok(await owner.post(`/api/purchasing/orders/${ids.po}/receive`, { docDate: "2025-08-05" }), 201)).toMatchObject({ number: "GRN/25-26/00001", state: "done" });

    const bill = ok(await owner.post("/api/bills", { purchaseOrderId: ids.po, supplierBillNo: "M-1", billDate: "2025-08-06", supplierGstin: millGstin, lines: [{ poLineNo: 1, qty: 100, unitPrice: 240, gstRate: 5 }] }), 201, "create bill");
    ids.bill = bill.id;
    expect(ok(await owner.post("/api/bills", { purchaseOrderId: ids.po, supplierBillNo: "m-1 ", billDate: "2025-08-06", lines: [{ poLineNo: 1, qty: 1, unitPrice: 240, gstRate: 5 }] }), 409).error.code).toBe("DUPLICATE_BILL");
    expect(ok(await owner.post(`/api/bills/${ids.bill}/submit`))).toMatchObject({ state: "matched", findings: [] });
    expect(ok(await owner.post(`/api/bills/${ids.bill}/post`))).toMatchObject({ state: "posted", number: "PB/25-26/00001", outstandingPaise: 2_520_000 });
    expect(ok(await owner.get("/api/reports/payables-ageing?asOf=2025-08-20")).totalOutstandingPaise).toBe(2_520_000);
  });

  it("pays the supplier", async () => {
    const paid = ok(await owner.post("/api/payments", { direction: "paid", partyId: ids.mill, paymentDate: "2025-08-10", amount: "25200", mode: "bank", reference: "UTR 1", allocations: [{ docId: ids.bill, amount: "25200" }] }), 201, "pay");
    expect(paid).toMatchObject({ number: "PAY/25-26/00001", unallocatedPaise: 0, warnings: [] });
    expect(ok(await owner.get("/api/reports/payables-ageing?asOf=2025-08-20")).totalOutstandingPaise).toBe(0);
    expect(ok(await owner.get("/api/payments?direction=paid")).total).toBe(1);
    expect(ok(await owner.get(`/api/payments/${paid.id}`)).allocations).toHaveLength(1);
  });

  it("stocks, sells, delivers, invoices and is paid", async () => {
    const receipt = ok(await owner.post("/api/stock/documents", { docType: "goods_receipt", docDate: "2025-08-01", lines: [{ sku: "SHIRT", qty: 20, unitCost: "400" }] }), 201);
    expect(ok(await owner.post(`/api/stock/documents/${receipt.id}/post`)).state).toBe("done");
    // A client cannot attach its own stock document to someone's order line
    const forged = await owner.post("/api/stock/documents", { docType: "delivery", docDate: "2025-08-01", lines: [{ sku: "SHIRT", qty: 1, salesOrderLineId: crypto.randomUUID() }] });
    expect(forged.status).toBe(201);
    expect(ok(await owner.get(`/api/stock/documents/${forged.json.id}`)).lines[0]).not.toHaveProperty("salesOrderLineId");

    const order = ok(await owner.post("/api/sales/orders", { customerId: ids.buyer, orderDate: "2025-08-08", promisedDate: "2025-08-18", lines: [{ sku: "SHIRT", qty: 10 }] }), 201, "create SO");
    expect(ok(await owner.post(`/api/sales/orders/${order.id}/confirm`)).number).toBe("SO/25-26/00001");
    expect(ok(await owner.post(`/api/sales/orders/${order.id}/deliver`, { docDate: "2025-08-09" }), 201)).toMatchObject({ number: "DEL/25-26/00001" });
    const draft = ok(await owner.post(`/api/sales/orders/${order.id}/invoice`, { invoiceDate: "2025-08-09" }), 201, "invoice");
    expect(draft).toMatchObject({ state: "draft", taxableValuePaise: 1_000_000, cgstPaise: 25_000, sgstPaise: 25_000, totalPaise: 1_050_000 });
    const posted = ok(await owner.post(`/api/sales/invoices/${draft.id}/post`));
    expect(posted).toMatchObject({ state: "posted", number: "INV/25-26/00001" });
    ids.invoice = posted.id;

    const received = ok(await owner.post("/api/payments", { direction: "received", partyId: ids.buyer, paymentDate: "2025-08-15", amount: "5000", mode: "upi", allocations: [{ docId: ids.invoice, amount: "5000" }] }), 201);
    expect(received.number).toBe("RCT/25-26/00001");
    const credit = ok(await owner.post(`/api/sales/invoices/${ids.invoice}/notes`, { kind: "credit_note", noteDate: "2025-08-16", reason: "One shirt returned", lines: [{ invoiceLineNo: 1, qty: 1, unitPrice: 1000 }] }), 201);
    ok(await owner.post(`/api/sales/invoices/${credit.id}/post`));
    expect(ok(await owner.get("/api/sales/invoices?state=posted")).total).toBe(2);
    expect(ok(await owner.get("/api/sales/board")).map((r: { status: string }) => r.status)).toEqual(["fulfilled"]);
  });

  it("shows it all on the dashboard", async () => {
    const dash = ok(await owner.get("/api/dashboard"));
    // Rs 10,500 invoice, less a Rs 1,050 credit note, less Rs 5,000 received
    expect(dash.money.receivables.outstandingPaise).toBe(1_050_000 - 105_000 - 500_000);
    expect(dash.money.payables.outstandingPaise).toBe(0);
    expect(dash.money.financialYear).toMatchObject({ label: "2025-26", salesPaise: 900_000, purchasesPaise: 2_400_000 });
    expect(dash.orders).toMatchObject({ openCount: 0 });
    expect(dash.stock.valuePaise).toBeGreaterThan(0);
    expect(dash.activity.length).toBeGreaterThan(5);
  });

  it("downloads an Excel workbook", async () => {
    const res = await owner.get("/api/exports/excel?sheets=sales_invoices,bills,payables");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="erp-export-2025-08-20.xlsx"');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.buffer as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["About", "Sales invoices", "Supplier bills", "Payables"]);
    expect(wb.getWorksheet("Supplier bills")?.getCell("B2").value).toBe("M-1");
    expect((await owner.get("/api/exports/excel?sheets=passwords")).status).toBe(400);
    expect((await owner.get("/api/exports/excel")).status).toBe(200); // every sheet
  });

  it("previews, then downloads, the Tally files, once", async () => {
    const preview = ok(await owner.get("/api/exports/tally/preview?from=2025-04-01&to=2025-08-20"));
    expect(preview).toMatchObject({ voucherCount: 5, counts: { invoices: 1, creditNotes: 1, bills: 1, payments: 1, receipts: 1 } });
    const masters = await owner.get("/api/exports/tally/masters?from=2025-04-01&to=2025-08-20");
    expect(masters.headers.get("content-type")).toContain("application/xml");
    expect(masters.text).toContain('<LEDGER NAME="Mill" ACTION="Create">');

    const vouchers = await owner.post("/api/exports/tally/vouchers", { from: "2025-04-01", to: "2025-08-20" });
    expect(vouchers.status).toBe(200);
    expect(vouchers.headers.get("x-voucher-count")).toBe("5");
    expect(vouchers.headers.get("x-batch-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(vouchers.text).toContain("<SVCURRENTCOMPANY>Flow Co</SVCURRENTCOMPANY>");
    expect(vouchers.text.match(/<VOUCHER /g)).toHaveLength(5);

    const again = await owner.post("/api/exports/tally/vouchers", { from: "2025-04-01", to: "2025-08-20" });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("NOTHING_TO_EXPORT");
    expect(ok(await owner.get("/api/exports/tally/preview?from=2025-04-01&to=2025-08-20")).voucherCount).toBe(0);
    expect((await owner.get("/api/exports/tally/preview?from=2025-09-01&to=2025-04-01")).status).toBe(422);
  });

  it("keeps the audit trail readable", async () => {
    const audit = ok(await owner.get("/api/audit?limit=5"));
    expect(audit.rows).toHaveLength(5);
    expect(audit.total).toBeGreaterThan(20);
    expect(audit.rows[0]).toMatchObject({ actorName: "Founder" });
    expect(ok(await owner.get(`/api/audit?entityType=purchase_bill&entityId=${ids.bill}`)).rows.map((r: { action: string }) => r.action)).toEqual([
      "purchase_bill.posted",
      "purchase_bill.matched",
      "purchase_bill.recorded",
    ]);
  });

  it("changes company settings, within limits", async () => {
    expect(ok(await owner.patch("/api/company", { billRateTolerancePct: "2", allowNegativeStock: true }))).toMatchObject({ billRateTolerancePct: "2.00", allowNegativeStock: true });
    expect((await owner.patch("/api/company", { billRateTolerancePct: "150" })).json.error.code).toBe("INVALID_TOLERANCE");
    expect((await owner.patch("/api/company", { gstin: "27AAAAA0000A1Z5" })).status).toBe(400); // not a setting
    expect((await owner.patch("/api/company", {})).json.error.code).toBe("NOTHING_TO_CHANGE");
  });
});

describe("people, passwords and companies", () => {
  it("adds, changes and removes team members, and signs a removed person out of the company", async () => {
    const { db } = await openDb();
    const app = createApp(db, { allowSignup: true }, () => NOW);
    const owner = new Client(app);
    ok(await owner.post("/api/auth/register", { legalName: "Team Co", stateCode: "27", owner: { email: "lead@team.example", name: "Lead", password: "a very long passphrase" } }), 201);

    expect((await owner.post("/api/members", { email: "new@team.example", name: "New", role: "sales", initialPassword: "weak" })).json.error.code).toBe("WEAK_PASSWORD");
    const added = ok(await owner.post("/api/members", { email: "new@team.example", name: "New", role: "sales", limitRupees: 0, initialPassword: "temporary passphrase" }), 201);
    expect(added.created).toBe(true);
    expect(ok(await owner.get("/api/members")).map((m: { role: string }) => m.role)).toEqual(["owner", "sales"]);

    const sales = new Client(app);
    const login = ok(await sales.post("/api/auth/login", { email: "new@team.example", password: "temporary passphrase" }));
    expect(login).toMatchObject({ role: "sales", mustChangePassword: true });
    expect((await sales.post("/api/members", { email: "x@team.example", name: "X", role: "viewer", initialPassword: "temporary passphrase" })).status).toBe(403);

    ok(await owner.patch(`/api/members/${added.userId}`, { role: "purchase", limitRupees: 25000 }));
    expect(ok(await sales.get("/api/auth/me"))).toMatchObject({ role: "purchase", approvalLimitPaise: 2_500_000 });
    expect((await owner.patch(`/api/members/${added.userId}`, { role: "emperor" })).status).toBe(400);

    ok(await owner.delete(`/api/members/${added.userId}`));
    const after = await sales.get("/api/dashboard");
    expect(after.status).toBe(403);
    expect(after.json.error.code).toBe("NO_COMPANY");
    expect((await owner.delete(`/api/members/${crypto.randomUUID()}`)).json.error.code).toBe("NOT_A_MEMBER");
  });

  it("changes a password and ends the other sessions", async () => {
    const { db } = await openDb();
    const app = createApp(db, { allowSignup: true }, () => NOW);
    const here = new Client(app);
    ok(await here.post("/api/auth/register", { legalName: "Pw Co", stateCode: "27", owner: { email: "person@pw.example", name: "Person", password: "a very long passphrase" } }), 201);
    const there = new Client(app);
    ok(await there.post("/api/auth/login", { email: "person@pw.example", password: "a very long passphrase" }));

    expect((await here.post("/api/auth/change-password", { currentPassword: "wrong wrong wrong", newPassword: "a different passphrase" })).status).toBe(401);
    expect((await here.post("/api/auth/change-password", { currentPassword: "a very long passphrase", newPassword: "short" })).json.error.code).toBe("WEAK_PASSWORD");
    ok(await here.post("/api/auth/change-password", { currentPassword: "a very long passphrase", newPassword: "a different passphrase" }));
    expect((await here.get("/api/auth/me")).status).toBe(200);
    expect((await there.get("/api/auth/me")).status).toBe(401);
    expect((await new Client(app).post("/api/auth/login", { email: "person@pw.example", password: "a very long passphrase" })).status).toBe(401);
  });

  it("switches company only into one the person belongs to", async () => {
    const { db } = await openDb();
    const app = createApp(db, { allowSignup: true }, () => NOW);
    const c = new Client(app);
    const reg = ok(await c.post("/api/auth/register", { legalName: "Sw Co", stateCode: "27", owner: { email: "p@sw.example", name: "P", password: "a very long passphrase" } }), 201);
    expect(ok(await c.post("/api/auth/switch-company", { companyId: reg.companyId })).companyId).toBe(reg.companyId);
    const refused = await c.post("/api/auth/switch-company", { companyId: crypto.randomUUID() });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("NOT_A_MEMBER");
  });

  it("limits how fast sign-ups can be made", async () => {
    const { db } = await openDb();
    const c = new Client(createApp(db, { allowSignup: true }, () => NOW));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.post("/api/auth/register", { legalName: "X", stateCode: "27", owner: { email: `p${i}@rate.example`, name: "P", password: "short" } })).status);
    expect(statuses).toEqual([422, 422, 422, 422, 422, 429]);
  });
});
