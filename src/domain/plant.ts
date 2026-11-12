import { DomainError } from "./errors";

/**
 * What an area is for. "store" holds raw material, "process" is work in progress, "qc" is
 * quality check, "finished" is finished goods, "dispatch" is packed and waiting to leave, and
 * "scrap" holds rejects and rework, which sit outside the normal forward flow.
 */
export const PLANT_AREA_KINDS = ["store", "process", "qc", "finished", "dispatch", "scrap"] as const;
export type PlantAreaKind = (typeof PLANT_AREA_KINDS)[number];

export interface PlantAreaRef {
  id: string;
  name: string;
  kind: PlantAreaKind;
  sortOrder: number;
  isActive: boolean;
}

/** The layout a new company starts with. A company renames, reorders, adds and switches off areas to match its floor. */
export const DEFAULT_PLANT_AREAS: readonly { name: string; kind: PlantAreaKind }[] = [
  { name: "Raw Material Store", kind: "store" },
  { name: "Cutting", kind: "process" },
  { name: "Machining", kind: "process" },
  { name: "Welding", kind: "process" },
  { name: "Assembly", kind: "process" },
  { name: "Painting / Finishing", kind: "process" },
  { name: "Quality Check", kind: "qc" },
  { name: "Finished Goods", kind: "finished" },
  { name: "Dispatch", kind: "dispatch" },
  { name: "Scrap / Rework", kind: "scrap" },
];

/** Work in progress is whatever sits in a process or quality-check area. */
export const isWipKind = (kind: PlantAreaKind): boolean => kind === "process" || kind === "qc";

/** Active areas in floor order. */
export function floorOrder<T extends PlantAreaRef>(areas: readonly T[]): T[] {
  return areas.filter((a) => a.isActive).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * The area material normally goes to next: the next active area along the floor that is not
 * scrap. Scrap and rework are never a "next stage"; sending something there is a deliberate choice.
 * Returns undefined at the end of the line (and for the scrap area itself).
 */
export function nextArea<T extends PlantAreaRef>(areas: readonly T[], fromId: string): T | undefined {
  const order = floorOrder(areas);
  const at = order.findIndex((a) => a.id === fromId);
  if (at < 0) throw new DomainError("UNKNOWN_AREA", "That area does not exist or is switched off");
  if ((order[at] as T).kind === "scrap") return undefined;
  return order.slice(at + 1).find((a) => a.kind !== "scrap");
}

/** Whether a move goes with the flow, against it (rework), or out of it (to scrap). */
export function moveDirection(areas: readonly PlantAreaRef[], fromId: string, toId: string): "forward" | "backward" | "scrap" | "from_scrap" {
  const from = areas.find((a) => a.id === fromId);
  const to = areas.find((a) => a.id === toId);
  if (!from || !to) throw new DomainError("UNKNOWN_AREA", "That area does not exist");
  if (from.id === to.id) throw new DomainError("SAME_AREA", "Choose two different areas");
  if (to.kind === "scrap") return "scrap";
  if (from.kind === "scrap") return "from_scrap";
  return to.sortOrder > from.sortOrder ? "forward" : "backward";
}

/**
 * Check a new order for the floor: it must name every active area exactly once. Returns the ids
 * in their new order.
 */
export function checkReorder(activeIds: readonly string[], wanted: readonly string[]): string[] {
  const have = new Set(activeIds);
  const seen = new Set<string>();
  for (const id of wanted) {
    if (!have.has(id)) throw new DomainError("UNKNOWN_AREA", "The new order names an area that does not exist or is switched off");
    if (seen.has(id)) throw new DomainError("DUPLICATE_AREA", "The new order names an area twice");
    seen.add(id);
  }
  if (seen.size !== have.size) throw new DomainError("INCOMPLETE_ORDER", "The new order must include every active area");
  return [...wanted];
}

/** A tidy area name, or an error a person can act on. */
export function cleanAreaName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new DomainError("NAME_REQUIRED", "Give the area a name");
  if (name.length > 60) throw new DomainError("NAME_TOO_LONG", "Keep the area name under 60 characters");
  return name;
}
