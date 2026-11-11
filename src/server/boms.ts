import Big from "big.js";
import { and, eq, inArray, max, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { bomLines, boms, items } from "../db/schema";
import { DomainError } from "../domain/errors";
import { recordAudit } from "./audit";
import { one } from "./util";

const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());

export const CreateBomInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  /** SKU of the item this BOM produces. */
  outputSku: z.string().trim().min(1),
  /** Units produced by one run of the BOM. */
  outputQty: decimal.default("1"),
  lines: z
    .array(
      z.object({
        componentSku: z.string().trim().min(1),
        qty: decimal,
        scrapPct: decimal.default("0"),
      }),
    )
    .min(1, "A BOM needs at least one component"),
});
export type CreateBomInput = z.input<typeof CreateBomInput>;

const PRODUCIBLE = new Set(["finished", "semi_finished"]);
const STOCKED = new Set(["raw_material", "semi_finished", "finished", "trading", "consumable"]);

/**
 * Create the next version of an item's BOM and make it the only active one.
 * Rejects circular structures (A needs B, B needs A), which would make material
 * planning loop forever.
 */
export async function createBom(db: Db, rawInput: CreateBomInput) {
  const input = CreateBomInput.parse(rawInput);

  if (new Big(input.outputQty).lte(0)) throw new DomainError("INVALID_QTY", "Output quantity must be positive");
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (new Big(line.qty).lte(0)) throw new DomainError("INVALID_QTY", `Quantity for ${line.componentSku} must be positive`);
    const scrap = new Big(line.scrapPct);
    if (scrap.lt(0) || scrap.gte(100)) throw new DomainError("INVALID_SCRAP", "Scrap must be from 0 up to (not including) 100 percent");
    if (seen.has(line.componentSku)) throw new DomainError("DUPLICATE_COMPONENT", `${line.componentSku} appears twice`);
    seen.add(line.componentSku);
  }
  if (seen.has(input.outputSku)) throw new DomainError("BOM_CYCLE", "An item cannot be a component of itself");

  return db.transaction(async (tx) => {
    const skus = [input.outputSku, ...seen];
    const found = await tx
      .select()
      .from(items)
      .where(and(eq(items.companyId, input.companyId), inArray(items.sku, skus)));
    const bySku = new Map(found.map((i) => [i.sku, i]));

    const output = bySku.get(input.outputSku);
    if (!output) throw new DomainError("UNKNOWN_ITEM", `Item "${input.outputSku}" does not exist`);
    if (!PRODUCIBLE.has(output.kind)) {
      throw new DomainError("NOT_PRODUCIBLE", `${output.sku} is a ${output.kind} item; only finished or semi-finished items have a BOM`);
    }
    for (const sku of seen) {
      const component = bySku.get(sku);
      if (!component) throw new DomainError("UNKNOWN_ITEM", `Component "${sku}" does not exist`);
      if (!STOCKED.has(component.kind)) throw new DomainError("NOT_STOCKED", `${sku} is a service and cannot be a component`);
      if (!component.isActive) throw new DomainError("INACTIVE_ITEM", `${sku} is inactive`);
    }

    // Cycle check over every other active BOM in this company.
    const edges = await tx
      .select({ parent: boms.itemId, child: bomLines.componentItemId })
      .from(bomLines)
      .innerJoin(boms, and(eq(bomLines.bomId, boms.id), eq(bomLines.companyId, boms.companyId)))
      .where(and(eq(boms.companyId, input.companyId), eq(boms.isActive, true), ne(boms.itemId, output.id)));
    const children = new Map<string, string[]>();
    for (const e of edges) children.set(e.parent, [...(children.get(e.parent) ?? []), e.child]);
    const stack = [...seen].map((sku) => (bySku.get(sku) as { id: string }).id);
    const visited = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === output.id) {
        throw new DomainError("BOM_CYCLE", `${output.sku} would end up containing itself through its components`);
      }
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(children.get(current) ?? []));
    }

    const previous = one(
      await tx
        .select({ latest: max(boms.version) })
        .from(boms)
        .where(and(eq(boms.companyId, input.companyId), eq(boms.itemId, output.id))),
      "version row",
    ).latest;
    const version = (previous ?? 0) + 1;

    if (previous !== null) {
      await tx
        .update(boms)
        .set({ isActive: false })
        .where(and(eq(boms.companyId, input.companyId), eq(boms.itemId, output.id)));
    }
    const bom = one(
      await tx
        .insert(boms)
        .values({ companyId: input.companyId, itemId: output.id, version, outputQty: input.outputQty })
        .returning(),
      "bom",
    );
    await tx.insert(bomLines).values(
      input.lines.map((line) => ({
        companyId: input.companyId,
        bomId: bom.id,
        componentItemId: (bySku.get(line.componentSku) as { id: string }).id,
        qty: line.qty,
        scrapPct: line.scrapPct,
      })),
    );
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: previous === null ? "bom.created" : "bom.replaced",
      entityType: "bom",
      entityId: bom.id,
      after: { output: output.sku, version, components: input.lines.map((l) => l.componentSku) },
    });
    return bom;
  });
}
