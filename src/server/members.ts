import { eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { memberships } from "../db/schema";
import type { Member } from "../domain/approval";
import { DomainError } from "../domain/errors";

/** Everyone in the company with their role and approval limit. */
export async function loadMembers(db: Executor, companyId: string): Promise<Member[]> {
  const rows = await db.select().from(memberships).where(eq(memberships.companyId, companyId));
  return rows.map((r) => ({ userId: r.userId, role: r.role, limitPaise: r.approvalLimitPaise }));
}

/** Viewers can look but not change anything. */
export function assertCanWrite(member: Member): void {
  if (member.role === "viewer") throw new DomainError("READ_ONLY", "A viewer cannot make changes");
}

/** The member for this user, or a clear error when the user does not belong to the company. */
export async function requireMember(db: Executor, companyId: string, userId: string): Promise<Member> {
  const member = (await loadMembers(db, companyId)).find((m) => m.userId === userId);
  if (!member) throw new DomainError("NOT_A_MEMBER", "That user does not belong to this company");
  return member;
}
