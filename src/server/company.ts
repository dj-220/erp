import { eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_UOMS, VIRTUAL_LOCATIONS } from "../db/defaults";
import type { Db } from "../db/client";
import { companies, locations, memberships, uoms, users, warehouses } from "../db/schema";
import { DomainError } from "../domain/errors";
import { parseGstin } from "../domain/gstin";
import { requireState } from "../domain/states";
import { recordAudit } from "./audit";
import { one } from "./util";

export const CreateCompanyInput = z.object({
  legalName: z.string().trim().min(1),
  tradeName: z.string().trim().min(1).optional(),
  /** Optional for an unregistered business; when given it is validated offline. */
  gstin: z.string().trim().min(1).optional(),
  /** Required only when there is no GSTIN to take the state from. */
  stateCode: z.string().length(2).optional(),
  addressLine: z.string().trim().optional(),
  city: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.email().optional(),
  tallyCompanyName: z.string().trim().min(1).optional(),
  owner: z.object({ email: z.email(), name: z.string().trim().min(1) }),
});
export type CreateCompanyInput = z.input<typeof CreateCompanyInput>;

/**
 * Create a company with its owner, the standard units of measure, a main warehouse and the
 * virtual locations stock moves need. All or nothing.
 */
export async function createCompany(db: Db, rawInput: CreateCompanyInput) {
  const input = CreateCompanyInput.parse(rawInput);

  let stateCode = input.stateCode;
  let gstin: string | null = null;
  let pan: string | null = null;
  if (input.gstin) {
    const parsed = parseGstin(input.gstin);
    if (!parsed.valid) {
      throw new DomainError("INVALID_GSTIN", `The GSTIN is not valid (${parsed.reason.toLowerCase()})`);
    }
    if (stateCode && stateCode !== parsed.stateCode) {
      throw new DomainError("GSTIN_STATE_MISMATCH", "The state does not match the first two digits of the GSTIN");
    }
    gstin = parsed.gstin;
    pan = parsed.pan;
    stateCode = parsed.stateCode;
  }
  if (!stateCode) throw new DomainError("STATE_REQUIRED", "A state is required when there is no GSTIN");
  const state = requireState(stateCode);

  return db.transaction(async (tx) => {
    const email = input.owner.email.toLowerCase();
    const existing = (await tx.select().from(users).where(eq(users.email, email)))[0];
    const owner =
      existing ?? one(await tx.insert(users).values({ email, name: input.owner.name }).returning(), "user");

    const company = one(
      await tx
        .insert(companies)
        .values({
          legalName: input.legalName,
          tradeName: input.tradeName ?? null,
          gstin,
          pan,
          stateCode,
          addressLine: input.addressLine ?? null,
          city: input.city ?? null,
          pincode: input.pincode ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          tallyCompanyName: input.tallyCompanyName ?? input.legalName,
        })
        .returning(),
      "company",
    );

    await tx.insert(memberships).values({ companyId: company.id, userId: owner.id, role: "owner" });
    await tx.insert(uoms).values(DEFAULT_UOMS.map((u) => ({ ...u, companyId: company.id })));

    const warehouse = one(
      await tx
        .insert(warehouses)
        .values({ companyId: company.id, code: "MAIN", name: "Main warehouse", stateCode })
        .returning(),
      "warehouse",
    );
    await tx.insert(locations).values([
      {
        companyId: company.id,
        warehouseId: warehouse.id,
        name: "Main / Stock",
        kind: "internal" as const,
        isPrimary: true,
      },
      ...VIRTUAL_LOCATIONS.map((l) => ({ companyId: company.id, warehouseId: null, ...l })),
    ]);

    await recordAudit(tx, {
      companyId: company.id,
      actorUserId: owner.id,
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      after: { legalName: company.legalName, gstin, state: state.name },
    });

    return { company, owner, warehouse };
  });
}
