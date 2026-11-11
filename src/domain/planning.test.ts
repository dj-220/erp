import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { type PlanBom, type PlanDemand, planShortages } from "./planning";

const SHIRT_BOM: PlanBom = {
  outputQty: 1,
  lines: [
    { componentId: "FAB", qty: "1.5", scrapPct: 10 },
    { componentId: "BTN", qty: 8, scrapPct: 0 },
  ],
};
const boms = new Map<string, PlanBom>([["SHIRT", SHIRT_BOM]]);
const demand = (itemId: string, qty: number, needBy = "2025-07-01"): PlanDemand => ({ itemId, qty, needBy });

describe("planShortages", () => {
  it("explodes a BOM including scrap and subtracts stock", () => {
    // 100 shirts: fabric 100 x 1.5 x 1.10 = 165 m, buttons 800
    const result = planShortages({
      demands: [demand("SHIRT", 100)],
      boms,
      available: new Map([["FAB", 100], ["BTN", 500]]),
    });
    expect(result).toEqual([
      { itemId: "BTN", qty: "300.000", firstNeededBy: "2025-07-01" },
      { itemId: "FAB", qty: "65.000", firstNeededBy: "2025-07-01" },
    ]);
  });

  it("counts incoming stock as available", () => {
    const result = planShortages({
      demands: [demand("SHIRT", 100)],
      boms,
      available: new Map([["FAB", 120], ["BTN", 800]]), // 100 on hand + 20 incoming
    });
    expect(result).toEqual([{ itemId: "FAB", qty: "45.000", firstNeededBy: "2025-07-01" }]);
  });

  it("uses finished stock first, so only the missing shirts are exploded", () => {
    const result = planShortages({
      demands: [demand("SHIRT", 100)],
      boms,
      available: new Map([["SHIRT", 30], ["FAB", 100], ["BTN", 560]]), // 70 shirts to make
    });
    // fabric 70 x 1.5 x 1.1 = 115.5 -> 15.5 short; buttons 560 -> none short
    expect(result).toEqual([{ itemId: "FAB", qty: "15.500", firstNeededBy: "2025-07-01" }]);
  });

  it("uses semi-finished stock before asking for raw material", () => {
    const multi = new Map<string, PlanBom>([
      ["SHIRT", { outputQty: 1, lines: [{ componentId: "PANEL", qty: 2, scrapPct: 0 }] }],
      ["PANEL", { outputQty: 1, lines: [{ componentId: "FAB", qty: "0.5", scrapPct: 0 }] }],
    ]);
    // 10 shirts need 20 panels; 8 panels in stock -> make 12 -> 6 m of fabric
    const result = planShortages({
      demands: [demand("SHIRT", 10)],
      boms: multi,
      available: new Map([["PANEL", 8]]),
    });
    expect(result).toEqual([{ itemId: "FAB", qty: "6.000", firstNeededBy: "2025-07-01" }]);
  });

  it("does not let two demands use the same stock twice", () => {
    const plain = new Map<string, PlanBom>([["SHIRT", { outputQty: 1, lines: [{ componentId: "FAB", qty: "1.5", scrapPct: 0 }] }]]);
    const result = planShortages({
      demands: [demand("SHIRT", 100, "2025-07-01"), demand("SHIRT", 100, "2025-08-01")],
      boms: plain,
      available: new Map([["FAB", 200]]), // each order needs 150
    });
    expect(result).toEqual([{ itemId: "FAB", qty: "100.000", firstNeededBy: "2025-08-01" }]);
  });

  it("serves the earliest demand first, whatever order they were listed in", () => {
    const plain = new Map<string, PlanBom>([["SHIRT", { outputQty: 1, lines: [{ componentId: "FAB", qty: "1.5", scrapPct: 0 }] }]]);
    const result = planShortages({
      demands: [demand("SHIRT", 100, "2025-08-01"), demand("SHIRT", 100, "2025-07-01")],
      boms: plain,
      available: new Map([["FAB", 150]]),
    });
    // July gets the stock; August is short by a full 150
    expect(result).toEqual([{ itemId: "FAB", qty: "150.000", firstNeededBy: "2025-08-01" }]);
  });

  it("buys directly when an item has no BOM, ignoring negative stock", () => {
    const result = planShortages({
      demands: [demand("BTN", 10)],
      boms: new Map(),
      available: new Map([["BTN", -5]]),
    });
    expect(result).toEqual([{ itemId: "BTN", qty: "10.000", firstNeededBy: "2025-07-01" }]);
  });

  it("reports which demands were left short, when demands carry an id", () => {
    const plain = new Map<string, PlanBom>([["SHIRT", { outputQty: 1, lines: [{ componentId: "FAB", qty: "1.5", scrapPct: 0 }] }]]);
    const run = (stock: number) =>
      planShortages({
        demands: [
          { itemId: "SHIRT", qty: 100, needBy: "2025-07-01", id: "ORDER-A" },
          { itemId: "SHIRT", qty: 100, needBy: "2025-08-01", id: "ORDER-B" },
        ],
        boms: plain,
        available: new Map([["FAB", stock]]),
      });
    // Stock covers the earlier order only: just B is short
    expect(run(150)).toEqual([{ itemId: "FAB", qty: "150.000", firstNeededBy: "2025-08-01", demandIds: ["ORDER-B"] }]);
    // Stock covers neither fully: both are short
    expect(run(100)[0]?.demandIds).toEqual(["ORDER-A", "ORDER-B"]);
    // Enough for both: nothing short
    expect(run(300)).toEqual([]);
  });

  it("returns nothing when stock covers the demand", () => {
    expect(
      planShortages({ demands: [demand("BTN", 10)], boms: new Map(), available: new Map([["BTN", 10]]) }),
    ).toEqual([]);
  });

  it("handles BOMs that yield several units without rounding noise", () => {
    const threePerRun = new Map<string, PlanBom>([["X", { outputQty: 3, lines: [{ componentId: "Y", qty: 3, scrapPct: 0 }] }]]);
    // 2 X needs 2/3 of a run x 3 = exactly 2 (not 2.001)
    expect(planShortages({ demands: [demand("X", 2)], boms: threePerRun, available: new Map() })).toEqual([
      { itemId: "Y", qty: "2.000", firstNeededBy: "2025-07-01" },
    ]);
    // 100 X needs 100 Y; one run covers 3, 33.33 runs x 3
    const oneThird = new Map<string, PlanBom>([["X", { outputQty: 3, lines: [{ componentId: "Y", qty: 1, scrapPct: 0 }] }]]);
    // 100 X needs 33.333... Y, rounded UP so we never under-buy
    expect(planShortages({ demands: [demand("X", 100)], boms: oneThird, available: new Map() })).toEqual([
      { itemId: "Y", qty: "33.334", firstNeededBy: "2025-07-01" },
    ]);
  });

  it("rounds up to the unit's whole numbers when it has no decimals", () => {
    const result = planShortages({
      demands: [demand("BTN", 2.1)],
      boms: new Map(),
      available: new Map(),
      decimalsOf: () => 0,
    });
    expect(result).toEqual([{ itemId: "BTN", qty: "3", firstNeededBy: "2025-07-01" }]);
  });

  describe("stock on order", () => {
    const supply = (itemId: string, qty: number, expectedBy: string) => ({ itemId, qty, expectedBy });
    const buy = (qty: number, needBy = "2025-07-10", id?: string): PlanDemand => ({ itemId: "FAB", qty, needBy, ...(id ? { id } : {}) });

    it("counts stock arriving on or before the date it is needed, and nothing later", () => {
      const result = planShortages({
        demands: [buy(100)],
        boms: new Map(),
        available: new Map([["FAB", 30]]),
        incoming: [supply("FAB", 50, "2025-07-05"), supply("FAB", 40, "2025-07-15"), supply("FAB", 10, "2025-07-10")],
      });
      // 30 on hand + 50 + 10 (the one arriving on the day) = 90; the 07-15 order is too late
      expect(result).toEqual([{ itemId: "FAB", qty: "10.000", firstNeededBy: "2025-07-10" }]);
    });

    it("is no help at all if it arrives after the demand", () => {
      const result = planShortages({
        demands: [buy(20)],
        boms: new Map(),
        available: new Map(),
        incoming: [supply("FAB", 500, "2025-07-11")],
      });
      expect(result).toEqual([{ itemId: "FAB", qty: "20.000", firstNeededBy: "2025-07-10" }]);
    });

    it("does not let two demands use the same incoming stock twice", () => {
      const result = planShortages({
        demands: [buy(40, "2025-07-10", "A"), buy(40, "2025-07-12", "B")],
        boms: new Map(),
        available: new Map(),
        incoming: [supply("FAB", 60, "2025-07-05")],
      });
      expect(result).toEqual([{ itemId: "FAB", qty: "20.000", firstNeededBy: "2025-07-12", demandIds: ["B"] }]);
    });

    it("is used for materials a BOM needs, after stock on hand", () => {
      const result = planShortages({
        demands: [{ itemId: "SHIRT", qty: 100, needBy: "2025-07-10" }],
        boms: new Map([["SHIRT", { outputQty: 1, lines: [{ componentId: "FAB", qty: "1.5", scrapPct: 0 }] }]]),
        available: new Map([["FAB", 100]]),
        incoming: [supply("FAB", 30, "2025-07-01")],
      });
      expect(result).toEqual([{ itemId: "FAB", qty: "20.000", firstNeededBy: "2025-07-10" }]); // 150 needed, 130 covered
    });

    it("ignores empty or negative orders", () => {
      const result = planShortages({
        demands: [buy(5)],
        boms: new Map(),
        available: new Map(),
        incoming: [supply("FAB", 0, "2025-07-01"), supply("FAB", -9, "2025-07-01")],
      });
      expect(result).toEqual([{ itemId: "FAB", qty: "5.000", firstNeededBy: "2025-07-10" }]);
    });
  });

  it("stops on a circular BOM instead of looping forever", () => {
    const circular = new Map<string, PlanBom>([
      ["A", { outputQty: 1, lines: [{ componentId: "B", qty: 1, scrapPct: 0 }] }],
      ["B", { outputQty: 1, lines: [{ componentId: "A", qty: 1, scrapPct: 0 }] }],
    ]);
    let code: string | undefined;
    try {
      planShortages({ demands: [demand("A", 1)], boms: circular, available: new Map() });
    } catch (e) {
      code = e instanceof DomainError ? e.code : "other";
    }
    expect(code).toBe("BOM_TOO_DEEP");
  });
});
