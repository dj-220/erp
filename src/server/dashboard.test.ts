import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { seedDemo } from "../demo/seed";
import { getDashboard } from "./dashboard";

/** A fixed "today", so every date in the demo, and every figure below, is reproducible. */
const TODAY = "2025-08-20";

let db: Db;
let companyId: string;
let people: Record<string, string>;

beforeAll(async () => {
  ({ db } = await openDb());
  ({ companyId, people } = await seedDemo(db, TODAY));
}, 120_000);

const view = (role: Parameters<typeof getDashboard>[1]["role"], who: string) =>
  getDashboard(db, { companyId, userId: people[who] as string, role, today: TODAY });

describe("the owner's dashboard", () => {
  it("shows every part", async () => {
    const dash = await view("owner", "owner");
    expect(dash.asOf).toBe(TODAY);
    expect(dash.sections).toEqual(["orders", "stock", "purchasing", "bills", "money", "activity"]);
  });

  it("sorts open orders into late, at risk and on time, with the reason", async () => {
    const { orders } = await view("owner", "owner");
    expect(orders).toMatchObject({ openCount: 3, lateCount: 1, atRiskCount: 1, onTimeCount: 1 });
    expect(orders?.board.map((o) => [o.status, o.reason])).toEqual([
      ["late", "2 days overdue, short of SHIRT-CHAMBRAY"],
      ["at_risk", "Short of FAB-OXFORD"],
      ["on_time", "Stock covers what remains"],
    ]);
    expect(orders?.shortItems).toEqual(["FAB-OXFORD", "SHIRT-CHAMBRAY"]);
    // 1,500 chambray shirts at Rs 1,250 + 2,400 oxford shirts at Rs 1,450
    expect(orders?.valueAtRiskPaise).toBe((1500 * 1250 + 2400 * 1450) * 100);
    expect(orders?.board[0]).toMatchObject({ customerName: "Nordlys Apparel", remainingValuePaise: 1500 * 1250 * 100 });
  });

  it("does not count stock on order that arrives after the promise date", async () => {
    // 3,000 m of Oxford fabric is on order, but for 12 days from now; the order is promised in 8
    const { orders } = await view("owner", "owner");
    expect(orders?.board[1]).toMatchObject({ status: "at_risk", shortOf: ["FAB-OXFORD"] });
  });

  it("flags stock at or below its reorder level, and values the stock", async () => {
    const { stock } = await view("owner", "owner");
    expect(stock?.lowStockCount).toBe(1);
    expect(stock?.lowStock[0]).toMatchObject({ sku: "POLY-12X16", onHand: "20000.000", reorderLevel: "25000.000" });
    expect(stock?.valuePaise).toBeGreaterThan(0);
  });

  it("lists what is waiting for approval and who it is waiting on", async () => {
    const { purchasing } = await view("owner", "owner");
    expect(purchasing?.pendingApprovals.count).toBe(2);
    // Polybags Rs 52,000 + 18% IGST, and Oxford fabric Rs 3,52,500 + 5% IGST
    expect(purchasing?.pendingApprovals.totalPaise).toBe(6_136_000 + 37_012_500);
    expect(purchasing?.pendingApprovals.rows.map((r) => [r.assignedToName, r.canDecide])).toEqual([
      ["Deepak Jain", true], // within Deepak's limit; the owner may also decide
      ["Rajiv Mehta", true],
    ]);
    expect(purchasing?.onOrder).toEqual({ count: 1, overdueCount: 0, valuePaise: 74_340_000 });
  });

  it("shows the held bill and the one waiting to be posted", async () => {
    const { bills } = await view("owner", "owner");
    expect(bills?.held.count).toBe(1);
    expect(bills?.held.totalPaise).toBe(70_150_500);
    expect(bills?.held.rows[0]?.findings.map((f) => f.code)).toEqual(["GSTIN_MISSING", "QTY_OVER_RECEIVED", "AMOUNT_OVER_RECEIVED_VALUE"]);
    expect(bills?.awaitingPostingCount).toBe(1);
  });

  it("adds up what customers owe and what the company owes", async () => {
    const { money } = await view("owner", "owner");
    // Invoices Rs 3,93,750 (unpaid, 64 days late), Rs 2,83,500 less Rs 1,00,000 received (20 days late),
    // Rs 2,99,250 less a Rs 19,950 credit note (not yet due)
    expect(money?.receivables.outstandingPaise).toBe((393_750 + 183_500 + 279_300) * 100);
    expect(money?.receivables.overduePaise).toBe((393_750 + 183_500) * 100);
    expect(money?.receivables.buckets).toMatchObject({ "61_90": 39_375_000, "1_30": 18_350_000, not_due: 27_930_000 });
    expect(money?.receivables.topParties[0]).toMatchObject({ name: "Harbor & Pine", outstandingPaise: 39_375_000 });
    // Mewar Rs 1,20,750 less Rs 1,00,000 paid; Patel Rs 10,384 (and Rs 5,000 paid on account)
    expect(money?.payables.outstandingPaise).toBe((20_750 + 10_384) * 100);
    expect(money?.payables.buckets).toMatchObject({ "31_60": 2_075_000, "1_30": 1_038_400 });
    expect(money?.payables.unappliedPaise).toBe(500_000);
    expect(money?.payables.msmeBreachedCount).toBe(1);
  });

  it("totals sales and purchases for the month and the financial year, and trends six months", async () => {
    const { money } = await view("owner", "owner");
    expect(money?.financialYear).toEqual({ label: "2025-26", salesPaise: 91_100_000, purchasesPaise: 12_380_000 });
    // August: the dresses (Rs 2,85,000) less the credit note (Rs 19,000); Rs 5,000 paid on account
    expect(money?.thisMonth).toEqual({ from: "2025-08-01", to: "2025-08-31", salesPaise: 26_600_000, purchasesPaise: 0, receivedPaise: 0, paidPaise: 500_000 });
    expect(money?.trend.map((t) => t.month)).toEqual(["2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08"]);
    expect(money?.trend.map((t) => t.salesPaise)).toEqual([0, 0, 37_500_000, 0, 27_000_000, 26_600_000]);
    expect(money?.trend.map((t) => t.purchasesPaise)).toEqual([0, 0, 0, 11_500_000, 880_000, 0]);
  });

  it("includes the latest activity, newest first", async () => {
    const { activity } = await view("owner", "owner");
    expect(activity).toHaveLength(10);
    // The last thing the seed does is send fabric to cutting
    expect(activity?.[0]?.actorName).toBe("Rajiv Mehta");
    expect(activity?.[0]?.action).toBe("plant.moved");
  });
});

describe("what each role is shown", () => {
  it("gives a salesperson only the orders", async () => {
    const dash = await view("sales", "suman");
    expect(dash.sections).toEqual(["orders"]);
    expect(Object.keys(dash).sort()).toEqual(["asOf", "orders", "role", "sections"]);
  });

  it("gives a viewer orders and stock quantities but no money", async () => {
    const dash = await view("viewer", "vik");
    expect(Object.keys(dash).sort()).toEqual(["asOf", "orders", "role", "sections", "stock"]);
    expect(dash.stock?.valuePaise).toBeUndefined();
  });

  it("gives a buyer purchasing and bills but not the ledgers", async () => {
    const dash = await view("purchase", "asha");
    expect(dash.purchasing?.pendingApprovals.count).toBe(2);
    expect(dash.purchasing?.pendingApprovals.rows.map((r) => r.canDecide)).toEqual([false, false]); // her own requests
    expect(dash.bills?.held.count).toBe(1);
    expect(dash.money).toBeUndefined();
    expect(dash.activity).toBeUndefined();
    expect(dash.stock?.valuePaise).toBeUndefined();
  });

  it("gives the accountant the money but not the audit activity", async () => {
    const dash = await view("accountant", "ravi");
    expect(dash.money?.receivables.outstandingPaise).toBe(85_655_000);
    expect(dash.stock?.valuePaise).toBeGreaterThan(0);
    expect(dash.activity).toBeUndefined();
    expect(dash.purchasing?.pendingApprovals.rows.map((r) => r.canDecide)).toEqual([false, false]); // limit Rs 50,000
  });

  it("tells a purchase manager which approvals are theirs to decide", async () => {
    const dash = await view("purchase", "deepak");
    expect(dash.purchasing?.pendingApprovals.rows.map((r) => r.canDecide)).toEqual([true, false]); // Rs 61,360 yes, Rs 3,70,125 no
  });
});
