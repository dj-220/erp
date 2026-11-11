import type { Executor } from "../db/client";
import { auditLog } from "../db/schema";

export interface AuditEntry {
  companyId: string;
  actorUserId?: string | null;
  /** Verb in past tense, namespaced: "party.created", "bom.replaced". */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** Record who did what. Call it inside the same transaction as the change it describes. */
export async function recordAudit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    companyId: entry.companyId,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
