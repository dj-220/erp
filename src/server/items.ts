import Big from "big.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, pgErrorCode } from "../db/client";
import { items, uoms } from "../db/schema";
import { DomainError } from "../domain/errors";
import { isAllowedGstRate } from "../domain/gst";
import { recordAudit } from "./audit";
import { one } from "./util";

const KINDS = ["raw_material", "semi_finished", "finished", "trading", "consumable", "service"] as const;
const decimal = z.union([z.string(), z.number()]).transform((v) => v.toString());

export const CreateItemInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(KINDS),
  /**
   * HSN (goods) or SAC (services), 4/6/8 digits. Optional while setting up master data;
   * invoice posting will insist on it for taxable lines.
   */
  hsnSac: z.string().trim().optional(),
  gstRate: decimal.default("0"),
  /** Existing GST slab no longer in force, for loading historical data. */
  allowLegacyRate: z.boolean().default(false),
  uomCode: z.string().trim().min(1),
  salesPrice: decimal.optional(),
  purchasePrice: decimal.optional(),
  trackBatch: z.boolean().default(false),
  reorderLevel: decimal.default("0"),
  reorderQty: decimal.default("0"),
  tallyItemName: z.string().trim().min(1).optional(),
});
export type CreateItemInput = z.input<typeof CreateItemInput>;

export async function createItem(db: Db, rawInput: CreateItemInput) {
  const input = CreateItemInput.parse(rawInput);

  if (input.hsnSac !== undefined && !/^([0-9]{4}|[0-9]{6}|[0-9]{8})$/.test(input.hsnSac)) {
    throw new DomainError("INVALID_HSN", "HSN/SAC must be 4, 6 or 8 digits");
  }
  if (!isAllowedGstRate(input.gstRate, { allowLegacy: input.allowLegacyRate })) {
    throw new DomainError("INVALID_GST_RATE", `${input.gstRate}% is not a valid GST rate slab`);
  }
  for (const [label, value] of [
    ["Reorder level", input.reorderLevel],
    ["Reorder quantity", input.reorderQty],
  ] as const) {
    if (new Big(value).lt(0)) throw new DomainError("NEGATIVE_QUANTITY", `${label} cannot be negative`);
  }

  try {
    return await db.transaction(async (tx) => {
      const uom = (
        await tx
          .select()
          .from(uoms)
          .where(and(eq(uoms.companyId, input.companyId), eq(uoms.code, input.uomCode.toUpperCase())))
      )[0];
      if (!uom) throw new DomainError("UNKNOWN_UOM", `Unit "${input.uomCode}" does not exist`);

      const item = one(
        await tx
          .insert(items)
          .values({
            companyId: input.companyId,
            sku: input.sku,
            name: input.name,
            kind: input.kind,
            hsnSac: input.hsnSac ?? null,
            gstRate: new Big(input.gstRate).toFixed(2),
            uomId: uom.id,
            salesPrice: input.salesPrice ?? null,
            purchasePrice: input.purchasePrice ?? null,
            trackBatch: input.trackBatch,
            reorderLevel: input.reorderLevel,
            reorderQty: input.reorderQty,
            tallyItemName: input.tallyItemName ?? input.name,
          })
          .returning(),
        "item",
      );
      await recordAudit(tx, {
        companyId: input.companyId,
        actorUserId: input.actorUserId,
        action: "item.created",
        entityType: "item",
        entityId: item.id,
        after: { sku: item.sku, name: item.name, hsnSac: item.hsnSac, gstRate: item.gstRate },
      });
      return item;
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new DomainError("DUPLICATE_SKU", `An item with SKU "${input.sku}" already exists`);
    }
    throw error;
  }
}
