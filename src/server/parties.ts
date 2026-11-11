import { z } from "zod";
import { type Db, pgErrorCode } from "../db/client";
import { parties } from "../db/schema";
import { DomainError } from "../domain/errors";
import { parseGstin } from "../domain/gstin";
import { requireState } from "../domain/states";
import { recordAudit } from "./audit";
import { one } from "./util";

const REGISTRATIONS = ["regular", "composition", "unregistered", "consumer", "sez", "overseas"] as const;
/** Registration types that must carry a GSTIN. */
const NEEDS_GSTIN = new Set<string>(["regular", "composition", "sez"]);

export const CreatePartyInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid().optional(),
  kind: z.enum(["customer", "supplier", "both"]),
  name: z.string().trim().min(1),
  legalName: z.string().trim().min(1).optional(),
  gstin: z.string().trim().min(1).optional(),
  registrationType: z.enum(REGISTRATIONS).optional(),
  /** Required only when there is no GSTIN to take the state from. */
  stateCode: z.string().length(2).optional(),
  addressLine: z.string().trim().optional(),
  city: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  email: z.email().optional(),
  phone: z.string().trim().optional(),
  creditDays: z.number().int().min(0).default(0),
  isMsme: z.boolean().default(false),
  udyamNo: z.string().trim().optional(),
  tallyLedgerName: z.string().trim().min(1).optional(),
});
export type CreatePartyInput = z.input<typeof CreatePartyInput>;

export async function createParty(db: Db, rawInput: CreatePartyInput) {
  const input = CreatePartyInput.parse(rawInput);

  const parsed = input.gstin ? parseGstin(input.gstin) : null;
  if (parsed && !parsed.valid) {
    throw new DomainError("INVALID_GSTIN", `The GSTIN is not valid (${parsed.reason.toLowerCase()})`);
  }
  const gstin = parsed?.valid ? parsed : null;

  if (gstin && input.stateCode && input.stateCode !== gstin.stateCode) {
    throw new DomainError("GSTIN_STATE_MISMATCH", "The state does not match the first two digits of the GSTIN");
  }
  const stateCode = gstin?.stateCode ?? input.stateCode;
  if (!stateCode) throw new DomainError("STATE_REQUIRED", "A state is required when there is no GSTIN");
  requireState(stateCode);

  const registrationType = input.registrationType ?? (gstin ? "regular" : "unregistered");
  if (NEEDS_GSTIN.has(registrationType) && !gstin) {
    throw new DomainError("GSTIN_REQUIRED", `A ${registrationType} party needs a GSTIN`);
  }
  if (!NEEDS_GSTIN.has(registrationType) && gstin && registrationType !== "overseas") {
    throw new DomainError("GSTIN_NOT_ALLOWED", `A ${registrationType} party cannot have a GSTIN`);
  }

  try {
    return await db.transaction(async (tx) => {
      const party = one(
        await tx
          .insert(parties)
          .values({
            companyId: input.companyId,
            kind: input.kind,
            name: input.name,
            legalName: input.legalName ?? null,
            gstin: gstin?.gstin ?? null,
            pan: gstin?.pan ?? null,
            registrationType,
            stateCode,
            addressLine: input.addressLine ?? null,
            city: input.city ?? null,
            pincode: input.pincode ?? null,
            email: input.email ?? null,
            phone: input.phone ?? null,
            creditDays: input.creditDays,
            isMsme: input.isMsme,
            udyamNo: input.udyamNo ?? null,
            tallyLedgerName: input.tallyLedgerName ?? input.name,
          })
          .returning(),
        "party",
      );
      await recordAudit(tx, {
        companyId: input.companyId,
        actorUserId: input.actorUserId,
        action: "party.created",
        entityType: "party",
        entityId: party.id,
        after: { name: party.name, gstin: party.gstin, kind: party.kind },
      });
      return party;
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new DomainError("DUPLICATE_GSTIN", `A party with GSTIN ${gstin?.gstin} already exists`);
    }
    throw error;
  }
}
