import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { DEFAULT_PLANT_AREAS, type PlantAreaRef, checkReorder, cleanAreaName, floorOrder, isWipKind, moveDirection, nextArea } from "./plant";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "no error";
};

const floor: PlantAreaRef[] = [
  { id: "store", name: "Store", kind: "store", sortOrder: 1, isActive: true },
  { id: "cut", name: "Cutting", kind: "process", sortOrder: 2, isActive: true },
  { id: "weld", name: "Welding", kind: "process", sortOrder: 3, isActive: false },
  { id: "scrap", name: "Scrap", kind: "scrap", sortOrder: 4, isActive: true },
  { id: "qc", name: "QC", kind: "qc", sortOrder: 5, isActive: true },
  { id: "fg", name: "Finished", kind: "finished", sortOrder: 6, isActive: true },
];

describe("plant layout", () => {
  it("starts a company with a store first, scrap last and the processes between", () => {
    expect(DEFAULT_PLANT_AREAS[0]?.kind).toBe("store");
    expect(DEFAULT_PLANT_AREAS.at(-1)?.kind).toBe("scrap");
    expect(new Set(DEFAULT_PLANT_AREAS.map((a) => a.name)).size).toBe(DEFAULT_PLANT_AREAS.length);
    expect(DEFAULT_PLANT_AREAS.map((a) => a.kind)).toEqual(expect.arrayContaining(["process", "qc", "finished", "dispatch"]));
  });

  it("counts process and quality-check areas as work in progress", () => {
    expect(["store", "process", "qc", "finished", "dispatch", "scrap"].filter((k) => isWipKind(k as never))).toEqual(["process", "qc"]);
  });

  it("orders the floor by position and leaves out areas that are switched off", () => {
    expect(floorOrder([...floor].reverse()).map((a) => a.id)).toEqual(["store", "cut", "scrap", "qc", "fg"]);
  });

  it("finds the next stage, skipping switched-off areas and never choosing scrap", () => {
    expect(nextArea(floor, "store")?.id).toBe("cut");
    expect(nextArea(floor, "cut")?.id).toBe("qc"); // welding is off, scrap is not a stage
    expect(nextArea(floor, "qc")?.id).toBe("fg");
    expect(nextArea(floor, "fg")).toBeUndefined(); // end of the line
    expect(nextArea(floor, "scrap")).toBeUndefined();
    expect(code(() => nextArea(floor, "weld"))).toBe("UNKNOWN_AREA");
    expect(code(() => nextArea(floor, "nope"))).toBe("UNKNOWN_AREA");
  });

  it("names the direction of a move", () => {
    expect(moveDirection(floor, "store", "cut")).toBe("forward");
    expect(moveDirection(floor, "qc", "cut")).toBe("backward");
    expect(moveDirection(floor, "qc", "scrap")).toBe("scrap");
    expect(moveDirection(floor, "scrap", "cut")).toBe("from_scrap");
    expect(code(() => moveDirection(floor, "cut", "cut"))).toBe("SAME_AREA");
    expect(code(() => moveDirection(floor, "cut", "nope"))).toBe("UNKNOWN_AREA");
  });

  it("accepts a new order only when it names every active area once", () => {
    const active = ["a", "b", "c"];
    expect(checkReorder(active, ["c", "a", "b"])).toEqual(["c", "a", "b"]);
    expect(code(() => checkReorder(active, ["a", "b"]))).toBe("INCOMPLETE_ORDER");
    expect(code(() => checkReorder(active, ["a", "b", "b"]))).toBe("DUPLICATE_AREA");
    expect(code(() => checkReorder(active, ["a", "b", "x"]))).toBe("UNKNOWN_AREA");
  });

  it("tidies area names and refuses empty or very long ones", () => {
    expect(cleanAreaName("  Heat   treatment ")).toBe("Heat treatment");
    expect(code(() => cleanAreaName("   "))).toBe("NAME_REQUIRED");
    expect(code(() => cleanAreaName("x".repeat(61)))).toBe("NAME_TOO_LONG");
  });
});
