import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Transactor } from "../db/client";
import { companies } from "../db/schema";
import { DomainError } from "../domain/errors";
import { recordAudit } from "./audit";
import { one } from "./util";

/** The company's details and the settings its owners can change. */
export async function getCompany(db: Executor, companyId: string) {
  const c = (await db.select().from(companies).where(eq(companies.id, companyId)))[0];
  if (!c) throw new DomainError("UNKNOWN_COMPANY", "That company does not exist");
  return {
    id: c.id,
    legalName: c.legalName,
    tradeName: c.tradeName,
    gstin: c.gstin,
    pan: c.pan,
    stateCode: c.stateCode,
    tallyCompanyName: c.tallyCompanyName,
    allowNegativeStock: c.allowNegativeStock,
    billRateTolerancePct: c.billRateTolerancePct,
    billQtyTolerancePct: c.billQtyTolerancePct,
    billAmountTolerancePaise: c.billAmountTolerancePaise,
  };
}

export const UpdateSettingsInput = z
  .object({
    tallyCompanyName: z.string().trim().min(1),
    allowNegativeStock: z.boolean(),
    billRateTolerancePct: z.union([z.string(), z.number()]).transform(String),
    billQtyTolerancePct: z.union([z.string(), z.number()]).transform(String),
    billAmountTolerancePaise: z.number().int(),
  })
  .partial()
  .strict();
export type UpdateSettingsInput = z.input<typeof UpdateSettingsInput>;

/** Change the company's settings. Tolerances decide how far a supplier's bill may stray before it is held. */
export async function updateCompanySettings(db: Transactor, args: { companyId: string; actorUserId: string; changes: UpdateSettingsInput }) {
  const changes = UpdateSettingsInput.parse(args.changes);
  for (const key of ["billRateTolerancePct", "billQtyTolerancePct"] as const) {
    const v = changes[key];
    if (v !== undefined && !(Number(v) >= 0 && Number(v) <= 100)) throw new DomainError("INVALID_TOLERANCE", "A tolerance must be between 0 and 100 percent");
  }
  if (changes.billAmountTolerancePaise !== undefined && (changes.billAmountTolerancePaise < 0 || changes.billAmountTolerancePaise > 1_000_000)) {
    throw new DomainError("INVALID_TOLERANCE", "The rounding allowance must be between Rs 0 and Rs 10,000");
  }
  if (Object.keys(changes).length === 0) throw new DomainError("NOTHING_TO_CHANGE", "Nothing to change");
  return db.transaction(async (tx) => {
    const before = await getCompany(tx, args.companyId);
    one(await tx.update(companies).set(changes).where(eq(companies.id, args.companyId)).returning(), "company");
    const after = await getCompany(tx, args.companyId);
    await recordAudit(tx, { companyId: args.companyId, actorUserId: args.actorUserId, action: "company.updated", entityType: "company", entityId: args.companyId, before, after });
    return after;
  });
}
