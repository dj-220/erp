import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { DEMO_PASSWORD, DEMO_TEAM, seedDemo } from "../demo/seed";
import { gstinChecksumChar } from "../domain/gstin";
import { registerAccount } from "../server/auth";
import { type ApiConfig, createApp } from "./app";
import { createRateLimiter, toApiError } from "./http";
import { DomainError } from "../domain/errors";

const NOW = new Date("2025-08-20T10:00:00Z");
const TODAY = "2025-08-20";
const gstin = (state: string, pan: string) => {
  const body = `${state}${pan}1Z`;
  return body + gstinChecksumChar(body);
};

/** A browser stand-in: remembers the session cookie between calls. */
class Client {
  cookie = "";
  constructor(readonly app: ReturnType<typeof createApp>) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.request(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
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
    return { status: res.status, json, headers: res.headers, buffer, text: buffer.toString("utf8"), setCookie: res.headers.getSetCookie() };
  }
  get = (path: string) => this.call("GET", path);
  post = (path: string, body?: unknown) => this.call("POST", path, body ?? {});
  patch = (path: string, body: unknown) => this.call("PATCH", path, body);
  delete = (path: string) => this.call("DELETE", path);
  async signIn(email: string, password = DEMO_PASSWORD) {
    const res = await this.post("/api/auth/login", { email, password });
    expect(res.status, `login as ${email}`).toBe(200);
    return res;
  }
}

describe("error mapping", () => {
  it("turns domain errors into sensible statuses and hides unexpected ones", () => {
    const status = (code: string) => toApiError(new DomainError(code, "x")).status;
    expect(status("UNAUTHENTICATED")).toBe(401);
    expect(status("INVALID_LOGIN")).toBe(401);
    expect(status("INSUFFICIENT_AUTHORITY")).toBe(403);
    expect(status("READ_ONLY")).toBe(403);
    expect(status("UNKNOWN_ORDER")).toBe(404);
    expect(status("DUPLICATE_BILL")).toBe(409);
    expect(status("NOT_DRAFT")).toBe(409);
    expect(status("INSUFFICIENT_STOCK")).toBe(409);
    expect(status("OVER_ALLOCATION")).toBe(409);
    expect(status("RATE_LIMITED")).toBe(429);
    expect(status("QTY_PRECISION")).toBe(422);
    const unexpected = toApiError(new Error("secret database detail"));
    expect(unexpected.status).toBe(500);
    expect(JSON.stringify(unexpected.body)).not.toContain("secret");
  });

  it("limits attempts per window", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    limiter.hit("a");
    limiter.hit("a");
    expect(() => limiter.hit("a")).toThrow(DomainError);
    limiter.hit("b"); // another key is unaffected
    t = 1001; // the window passes
    expect(() => limiter.hit("a")).not.toThrow();
  });
});

describe("signing in and out", () => {
  let db: Db;
  beforeAll(async () => {
    ({ db } = await openDb());
    await seedDemo(db, TODAY);
  }, 120_000);
  const fresh = (config: Partial<ApiConfig> = {}, clock = () => NOW) => new Client(createApp(db, config, clock));

  it("is open for the health check and closed for everything else", async () => {
    const c = fresh();
    expect((await c.get("/api/health")).json).toEqual({ ok: true });
    expect((await c.get("/api/auth/options")).json).toEqual({ signup: false });
    expect((await fresh({ allowSignup: true }).get("/api/auth/options")).json).toEqual({ signup: true });
    for (const path of ["/api/dashboard", "/api/parties", "/api/bills", "/api/auth/me"]) {
      const res = await c.get(path);
      expect(res.status, path).toBe(401);
      expect(res.json.error.code).toBe("UNAUTHENTICATED");
    }
    expect((await c.get("/api/nothing-here")).status).toBe(401); // not even route names are revealed
  });

  it("starts a session in an HttpOnly cookie and never puts the token in the body", async () => {
    const c = fresh();
    const res = await c.signIn("rajiv@sunrise.example");
    const cookie = res.setCookie.find((l) => l.startsWith("erp_session="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i); // off unless configured
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(res.json).toMatchObject({ user: { email: "rajiv@sunrise.example", name: "Rajiv Mehta" }, role: "owner", mustChangePassword: false });
    expect(res.json.companies).toHaveLength(1);
    expect(res.json.permissions).toContain("export.tally");
    expect(res.text).not.toContain(c.cookie.split("=")[1] as string);
    expect((await c.get("/api/auth/me")).json).toMatchObject({ role: "owner" });
  });

  it("marks the cookie Secure when configured, and sets security headers", async () => {
    const c = fresh({ secureCookies: true });
    const res = await c.signIn("rajiv@sunrise.example");
    expect(res.setCookie.find((l) => l.startsWith("erp_session="))).toMatch(/Secure/i);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("ends the session on logout and rejects a tampered cookie", async () => {
    const c = fresh();
    await c.signIn("rajiv@sunrise.example");
    const token = c.cookie;
    expect((await c.post("/api/auth/logout")).status).toBe(200);
    expect(c.cookie).toBe("");
    expect((await c.get("/api/dashboard")).status).toBe(401);
    // The old token no longer works anywhere
    const replay = fresh();
    replay.cookie = token;
    expect((await replay.get("/api/dashboard")).status).toBe(401);
    replay.cookie = "erp_session=made-up-token";
    expect((await replay.get("/api/dashboard")).status).toBe(401);
  });

  it("gives one answer for a wrong password and an unknown email, and locks after five tries", async () => {
    const c = fresh();
    const wrong = await c.post("/api/auth/login", { email: "ravi@sunrise.example", password: "not the password" });
    const unknown = await c.post("/api/auth/login", { email: "nobody@sunrise.example", password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
    for (let i = 0; i < 5; i++) await c.post("/api/auth/login", { email: "suman@sunrise.example", password: `guess number ${i}` });
    expect((await c.post("/api/auth/login", { email: "suman@sunrise.example", password: DEMO_PASSWORD })).status).toBe(401); // locked
    expect((await c.post("/api/auth/login", { email: "", password: "" })).status).toBe(400);
  });

  it("throttles repeated login attempts from one place", async () => {
    const c = fresh();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await c.post("/api/auth/login", { email: "x@sunrise.example", password: "wrong wrong wrong" })).status;
    expect(last).toBe(429);
  });

  it("keeps sign-up closed unless it is switched on", async () => {
    const res = await fresh().post("/api/auth/register", { legalName: "X", stateCode: "27", owner: { email: "a@b.example", name: "A", password: "long enough password" } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("SIGNUP_DISABLED");
  });
});

describe("requests that change things", () => {
  let db: Db;
  let c: Client;
  beforeAll(async () => {
    ({ db } = await openDb());
    await seedDemo(db, TODAY);
    c = new Client(createApp(db, { allowedOrigins: ["https://app.example"] }, () => NOW));
    await c.signIn("rajiv@sunrise.example");
  }, 120_000);

  it("refuses a change that comes from another site", async () => {
    const res = await c.call("POST", "/api/auth/logout", {}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("BAD_ORIGIN");
    expect((await c.get("/api/auth/me")).status).toBe(200); // still signed in: nothing happened
  });

  it("accepts its own origin and the ones it was told about", async () => {
    expect((await c.call("POST", "/api/stock/shortages", { demands: [{ sku: "SHIRT-OXFORD", qty: 1, needBy: TODAY }] }, { origin: "http://localhost" })).status).toBe(200);
    expect((await c.call("POST", "/api/stock/shortages", { demands: [{ sku: "SHIRT-OXFORD", qty: 1, needBy: TODAY }] }, { origin: "https://app.example" })).status).toBe(200);
  });

  it("insists on JSON and caps the size", async () => {
    const form = await c.app.request("/api/parties", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: c.cookie }, body: "name=x" });
    expect(form.status).toBe(415);
    const huge = await c.call("POST", "/api/parties", { name: "x" }, { "content-length": "2000000" });
    expect(huge.status).toBe(413);
  });

  it("reports bad input as 400 with the fields at fault, never a stack trace", async () => {
    const res = await c.post("/api/parties", { kind: "customer" });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("INVALID_INPUT");
    expect(res.json.error.issues.map((i: { path: string }) => i.path)).toContain("name");
    const broken = await c.app.request("/api/parties", { method: "POST", headers: { "content-type": "application/json", cookie: c.cookie }, body: "{not json" });
    expect(broken.status).toBe(400);
    expect(await broken.text()).not.toMatch(/at .*\.ts|node_modules/);
    expect((await c.get("/api/sales/orders/not-a-uuid")).status).toBe(400);
    expect((await c.get(`/api/sales/orders/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("who may do what", () => {
  let db: Db;
  const app = () => createApp(db, {}, () => NOW);
  beforeAll(async () => {
    ({ db } = await openDb());
    await seedDemo(db, TODAY);
  }, 120_000);
  const as = async (email: string) => {
    const c = new Client(app());
    await c.signIn(email);
    return c;
  };
  const email = (key: string) => (DEMO_TEAM.find((p) => p.key === key) as (typeof DEMO_TEAM)[number]).email;

  it("keeps the money from people who do not need it", async () => {
    const sales = await as(email("suman"));
    for (const path of ["/api/bills", "/api/payments", "/api/reports/receivables-ageing", "/api/stock/valuation", "/api/exports/excel", "/api/audit", "/api/members"]) {
      const res = await sales.get(path);
      expect(res.status, path).toBe(403);
      expect(res.json.error.code).toBe("FORBIDDEN");
    }
    expect((await sales.get("/api/sales/orders")).status).toBe(200);
  });

  it("lets everyone see the factory floor, stores move material on it, and only managers change its layout", async () => {
    type Area = { id: string; name: string; kind: string; items: { sku: string; onHand: string; outgoing: string }[]; pendingInCount: number; next: { name: string } | null };
    const viewer = await as(email("vik"));
    const board = (await viewer.get("/api/plant/board")).json as { areas: Area[] };
    expect(board.areas.map((a) => a.name)).toEqual(["Raw Material Store", "Cutting", "Stitching", "Finishing", "Quality Check", "Finished Goods", "Dispatch", "Scrap / Rework"]);
    const area = (name: string) => board.areas.find((a) => a.name === name) as Area;
    expect(area("Cutting").items.find((i) => i.sku === "FAB-LINEN")?.onHand).toBe("350.000");
    expect(area("Cutting").pendingInCount).toBe(1); // oxford sent from the store, not yet confirmed
    expect(area("Cutting").next?.name).toBe("Stitching");
    expect(area("Raw Material Store").items.find((i) => i.sku === "FAB-OXFORD")?.outgoing).toBe("300.000");
    expect(area("Finished Goods").items.map((i) => i.sku)).toEqual(expect.arrayContaining(["SHIRT-CHAMBRAY", "DRESS-FLORAL"]));
    expect(area("Raw Material Store").items.some((i) => i.sku.startsWith("SHIRT-"))).toBe(false);

    const move = { fromAreaId: area("Cutting").id, docDate: TODAY, lines: [{ sku: "FAB-LINEN", qty: "50" }] };
    expect((await viewer.post("/api/plant/moves", move)).status).toBe(403);
    expect((await (await as(email("suman"))).post("/api/plant/moves", move)).status).toBe(403); // sales
    const stores = await as(email("imran"));
    const moved = await stores.post("/api/plant/moves", { ...move, source: "voice" });
    expect(moved.status).toBe(201);
    expect(moved.json).toMatchObject({ to: { name: "Stitching" }, direction: "forward", document: { state: "done" } });
    expect((await stores.post("/api/plant/moves", { ...move, lines: [{ sku: "FAB-LINEN", qty: "9999" }] })).json.error.code).toBe("INSUFFICIENT_STOCK");
    const detail = (await viewer.get(`/api/plant/areas/${area("Cutting").id}`)).json;
    expect(detail.items.find((i: { sku: string }) => i.sku === "FAB-LINEN").onHand).toBe("300.000");
    expect(detail.recentMoves[0]).toMatchObject({ direction: "out", otherPlace: "Stitching", qty: "50.000" });

    // Layout: stores cannot change it, the owner can; a company id in the body is ignored
    expect((await stores.post("/api/plant/areas", { name: "Washing", kind: "process" })).status).toBe(403);
    expect((await stores.patch(`/api/plant/areas/${area("Dispatch").id}`, { name: "Gate" })).status).toBe(403);
    const owner = await as(email("owner"));
    const made = await owner.post("/api/plant/areas", { name: "Washing", kind: "process", companyId: "00000000-0000-4000-8000-000000000000" });
    expect(made.status).toBe(201);
    expect((await owner.patch(`/api/plant/areas/${made.json.id}`, { name: "Washing and drying" })).json.name).toBe("Washing and drying");
    expect((await owner.patch(`/api/plant/areas/${area("Cutting").id}`, { isActive: false })).json.error.code).toBe("AREA_NOT_EMPTY");
    const all = (await owner.get("/api/plant/areas?all=1")).json as { id: string; name: string; isActive: boolean }[];
    expect(all.filter((a) => !a.isActive).map((a) => a.name).sort()).toEqual(["Assembly", "Welding"]);
    const order = all.filter((a) => a.isActive).map((a) => a.id).reverse();
    expect((await owner.post("/api/plant/areas/reorder", { areaIds: order })).json[0].name).toBe("Scrap / Rework");
    expect((await owner.post("/api/plant/areas/reorder", { areaIds: order.slice(1) })).json.error.code).toBe("INCOMPLETE_ORDER");
    // Put the floor back the way the other tests expect it
    expect((await owner.post("/api/plant/areas/reorder", { areaIds: order.reverse() })).status).toBe(200);
    expect((await owner.patch(`/api/plant/areas/${made.json.id}`, { isActive: false })).status).toBe(200);
  });

  it("lets a viewer look but not touch", async () => {
    const viewer = await as(email("vik"));
    expect((await viewer.get("/api/sales/board")).status).toBe(200);
    expect((await viewer.get("/api/stock/balances")).status).toBe(200);
    expect((await viewer.post("/api/parties", { kind: "customer", name: "Nope", stateCode: "27" })).status).toBe(403);
    expect((await viewer.post("/api/stock/documents", { docType: "goods_receipt", docDate: TODAY, lines: [{ sku: "BTN-14L", qty: 1, unitCost: "1" }] })).status).toBe(403);
    expect((await viewer.get("/api/bills")).status).toBe(403);
  });

  it("gives each working role its own part of the system", async () => {
    const stores = await as(email("imran"));
    expect((await stores.post("/api/sales/orders", {})).status).toBe(403);
    expect((await stores.get("/api/stock/documents")).status).toBe(200);
    const buyer = await as(email("asha"));
    expect((await buyer.get("/api/exports/excel")).status).toBe(403);
    expect((await buyer.post("/api/bills/00000000-0000-4000-8000-000000000000/post")).status).toBe(403); // posting is the accountant's
    expect((await buyer.get("/api/bills")).status).toBe(200);
    const accountant = await as(email("ravi"));
    expect((await accountant.get("/api/exports/excel?sheets=payables")).status).toBe(200);
    expect((await accountant.get("/api/audit")).status).toBe(403);
    expect((await (await as(email("owner"))).get("/api/audit")).status).toBe(200);
  });

  it("sends each role a dashboard with only its own parts", async () => {
    const keys = async (who: string) => Object.keys((await (await as(email(who))).get("/api/dashboard")).json).sort();
    expect(await keys("suman")).toEqual(["asOf", "orders", "role", "sections"]);
    expect(await keys("vik")).toEqual(["asOf", "orders", "role", "sections", "stock"]);
    expect(await keys("ravi")).toEqual(["asOf", "bills", "money", "orders", "purchasing", "role", "sections", "stock"]);
    expect(await keys("owner")).toEqual(["activity", "asOf", "bills", "money", "orders", "purchasing", "role", "sections", "stock"]);
  });

  it("enforces approval authority on top of the role, from the session alone", async () => {
    const deepak = await as(email("deepak"));
    const pending = (await deepak.get("/api/approvals/pending")).json as { requestId: string; amountPaise: number; canDecide: boolean }[];
    expect(pending.map((p) => p.canDecide)).toEqual([true, false]);
    const tooBig = pending.find((p) => !p.canDecide) as (typeof pending)[number];
    const refused = await deepak.post(`/api/approvals/${tooBig.requestId}/decide`, { decision: "approve" });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("INSUFFICIENT_AUTHORITY");
    const noReason = await deepak.post(`/api/approvals/${(pending.find((p) => p.canDecide) as (typeof pending)[number]).requestId}/decide`, { decision: "reject" });
    expect(noReason.json.error.code).toBe("COMMENT_REQUIRED");
    const owner = await as(email("owner"));
    const done = await owner.post(`/api/approvals/${tooBig.requestId}/decide`, { decision: "approve", comment: "Go ahead" });
    expect(done.status).toBe(200);
    expect(done.json.state).toBe("approved");
  });

  it("applies a viewer's lack of authority to a bill the owner could release", async () => {
    const owner = await as(email("owner"));
    const held = ((await owner.get("/api/bills?states=held")).json as { billId: string }[])[0] as { billId: string };
    const asha = await as(email("asha")); // entered it
    expect((await asha.post(`/api/bills/${held.billId}/release`, { reason: "I say so" })).json.error.code).toBe("SELF_OVERRIDE");
    const ravi = await as(email("ravi")); // limit Rs 50,000
    expect((await ravi.post(`/api/bills/${held.billId}/release`, { reason: "Looks fine" })).json.error.code).toBe("INSUFFICIENT_AUTHORITY");
    const released = await owner.post(`/api/bills/${held.billId}/release`, { reason: "Supplier confirmed the extra 50 m separately" });
    expect(released.status).toBe(200);
    expect(released.json.state).toBe("matched");
    expect(released.json.findings.length).toBe(3);
  });

  // Last in this block: it changes the stores person's password, which the tests above sign in with.
  it("lets an owner set a temporary password for someone, and nobody without that right", async () => {
    const owner = await as(email("owner"));
    const team = (await owner.get("/api/members")).json as { userId: string; email: string }[];
    const idOf = (address: string) => (team.find((m) => m.email === address) as { userId: string }).userId;
    const target = email("imran");
    const temporary = "temporary passphrase";

    const viewer = await as(email("vik"));
    expect((await viewer.post(`/api/members/${idOf(target)}/reset-password`, { temporaryPassword: temporary })).status).toBe(403);
    expect((await owner.post(`/api/members/${idOf(email("owner"))}/reset-password`, { temporaryPassword: temporary })).json.error.code).toBe("NOT_ALLOWED");
    expect((await owner.post(`/api/members/${idOf(target)}/reset-password`, { temporaryPassword: "short" })).json.error.code).toBe("WEAK_PASSWORD");

    expect((await owner.post(`/api/members/${idOf(target)}/reset-password`, { temporaryPassword: temporary })).status).toBe(200);
    const fresh = new Client(app());
    expect((await fresh.post("/api/auth/login", { email: target, password: DEMO_PASSWORD })).status).toBe(401);
    const signedIn = await fresh.post("/api/auth/login", { email: target, password: temporary });
    expect(signedIn.status).toBe(200);
    expect(signedIn.json.mustChangePassword).toBe(true);
  });
});

describe("one company cannot reach another's data", () => {
  it("returns 404 for another company's records and ignores a company id in the body", async () => {
    const { db } = await openDb();
    await seedDemo(db, TODAY);
    await registerAccount(db, { legalName: "Other Co", gstin: gstin("29", "AAACO1111A"), owner: { email: "boss@other.example", name: "Boss", password: "another long passphrase" } });
    const app = createApp(db, {}, () => NOW);

    const mine = new Client(app);
    await mine.signIn("rajiv@sunrise.example");
    const order = ((await mine.get("/api/sales/orders")).json.rows as { id: string }[])[0] as { id: string };
    const bill = ((await mine.get("/api/bills")).json as { billId: string }[])[0] as { billId: string };

    const theirs = new Client(app);
    await theirs.signIn("boss@other.example", "another long passphrase");
    expect((await theirs.get(`/api/sales/orders/${order.id}`)).status).toBe(404);
    expect((await theirs.get(`/api/bills/${bill.billId}`)).status).toBe(404); // not even confirmed to exist
  });

  it("scopes every list to the signed-in company, and a forged company id changes nothing", async () => {
    const { db } = await openDb();
    const a = await seedDemo(db, TODAY);
    await registerAccount(db, { legalName: "Other Co", gstin: gstin("29", "AAACO1111A"), owner: { email: "boss@other.example", name: "Boss", password: "another long passphrase" } });
    const app = createApp(db, {}, () => NOW);
    const theirs = new Client(app);
    await theirs.signIn("boss@other.example", "another long passphrase");
    for (const path of ["/api/parties", "/api/items", "/api/sales/orders", "/api/sales/invoices", "/api/purchasing/orders", "/api/payments", "/api/stock/documents"]) {
      expect((await theirs.get(path)).json.total, path).toBe(0);
    }
    expect((await theirs.get("/api/bills")).json).toEqual([]);
    expect((await theirs.get("/api/approvals/pending")).json).toEqual([]);

    // Naming the other company in the body is ignored: the party lands in the caller's own company
    const created = await theirs.post("/api/parties", { companyId: a.companyId, kind: "customer", name: "Forged", stateCode: "29" });
    expect(created.status).toBe(201);
    expect(created.json.companyId).not.toBe(a.companyId);
    const mine = new Client(app);
    await mine.signIn("rajiv@sunrise.example");
    expect(((await mine.get("/api/parties?q=Forged")).json as { total: number }).total).toBe(0);
  });
});
