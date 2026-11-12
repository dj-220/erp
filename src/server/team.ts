import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor, Transactor } from "../db/client";
import { memberships, sessions, users } from "../db/schema";
import type { Role } from "../domain/approval";
import { DomainError } from "../domain/errors";
import { toPaise } from "../domain/money";
import { canManageMember } from "../domain/permissions";
import { recordAudit } from "./audit";
import { requireMember } from "./members";
import { assertPasswordStrength, hashPassword } from "./passwords";
import { one } from "./util";

const ROLES = ["owner", "admin", "accountant", "purchase", "sales", "stores", "viewer"] as const;

export interface TeamMember {
  userId: string;
  email: string;
  name: string;
  role: Role;
  limitPaise: number;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
}

/** Everyone in the company with their role and approval limit. */
export async function listTeam(db: Executor, companyId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({ m: memberships, u: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.companyId, companyId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
  return rows.map(({ m, u }) => ({
    userId: u.id,
    email: u.email,
    name: u.name,
    role: m.role,
    limitPaise: m.approvalLimitPaise,
    lastLoginAt: u.lastLoginAt,
    mustChangePassword: u.mustChangePassword,
  }));
}

/** Lock the company's memberships so two changes cannot both remove the last owner. */
async function lockMemberships(tx: Executor, companyId: string) {
  await tx.execute(sql`SELECT id FROM memberships WHERE company_id = ${companyId} ORDER BY id FOR UPDATE`);
}

async function ownerCount(tx: Executor, companyId: string): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT count(*)::int AS n FROM memberships WHERE company_id = ${companyId} AND role = 'owner'`);
  return Number((rows as { n: number }[])[0]?.n ?? 0);
}

export const AddMemberInput = z.object({
  companyId: z.uuid(),
  actorUserId: z.uuid(),
  email: z.email(),
  name: z.string().trim().min(1),
  role: z.enum(ROLES),
  /** Largest single amount they may approve, in rupees. */
  limitRupees: z.union([z.string(), z.number()]).transform(String).default("0"),
  /** Needed only for a person who has no login yet; they are asked to change it. */
  initialPassword: z.string().optional(),
});
export type AddMemberInput = z.input<typeof AddMemberInput>;

/** Add a person to the company. An existing login keeps its own password. */
export async function addTeamMember(db: Transactor, rawInput: AddMemberInput) {
  const input = AddMemberInput.parse(rawInput);
  const email = input.email.trim().toLowerCase();
  const limitPaise = toPaise(input.limitRupees);
  if (limitPaise < 0) throw new DomainError("INVALID_LIMIT", "The approval limit cannot be negative");
  const passwordHash = input.initialPassword ? (assertPasswordStrength(input.initialPassword, email), await hashPassword(input.initialPassword)) : null;

  return db.transaction(async (tx) => {
    const actor = await requireMember(tx, input.companyId, input.actorUserId);
    if (!canManageMember(actor.role, input.role, input.role)) {
      throw new DomainError("NOT_ALLOWED", input.role === "owner" ? "Only an owner can add another owner" : "You cannot manage members");
    }
    let user = (await tx.select().from(users).where(eq(users.email, email)))[0];
    const created = !user;
    if (!user) {
      if (!passwordHash) throw new DomainError("PASSWORD_REQUIRED", "A new person needs an initial password");
      user = one(
        await tx.insert(users).values({ email, name: input.name, passwordHash, mustChangePassword: true, passwordChangedAt: new Date() }).returning(),
        "user",
      );
    }
    const existing = (
      await tx.select().from(memberships).where(and(eq(memberships.companyId, input.companyId), eq(memberships.userId, user.id)))
    )[0];
    if (existing) throw new DomainError("ALREADY_MEMBER", `${user.email} already belongs to this company`);
    await tx.insert(memberships).values({ companyId: input.companyId, userId: user.id, role: input.role, approvalLimitPaise: limitPaise });
    await recordAudit(tx, {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: "member.added",
      entityType: "user",
      entityId: user.id,
      after: { email: user.email, role: input.role, limitPaise, newLogin: created },
    });
    return { userId: user.id, created };
  });
}

/** Change a member's role and / or approval limit. */
export async function updateTeamMember(
  db: Transactor,
  args: { companyId: string; actorUserId: string; userId: string; role?: Role; limitRupees?: string | number },
) {
  return db.transaction(async (tx) => {
    await lockMemberships(tx, args.companyId);
    const actor = await requireMember(tx, args.companyId, args.actorUserId);
    const target = (
      await tx.select().from(memberships).where(and(eq(memberships.companyId, args.companyId), eq(memberships.userId, args.userId)))
    )[0];
    if (!target) throw new DomainError("NOT_A_MEMBER", "That person does not belong to this company");
    if (!canManageMember(actor.role, target.role, args.role)) {
      throw new DomainError("NOT_ALLOWED", "You cannot change that member (only an owner can manage owners)");
    }
    if (args.role !== undefined && args.userId === args.actorUserId && args.role !== target.role) {
      throw new DomainError("NOT_ALLOWED", "You cannot change your own role");
    }
    if (target.role === "owner" && args.role !== undefined && args.role !== "owner" && (await ownerCount(tx, args.companyId)) <= 1) {
      throw new DomainError("LAST_OWNER", "A company must keep at least one owner");
    }
    const limitPaise = args.limitRupees === undefined ? target.approvalLimitPaise : toPaise(args.limitRupees);
    if (limitPaise < 0) throw new DomainError("INVALID_LIMIT", "The approval limit cannot be negative");
    const role = args.role ?? target.role;
    await tx
      .update(memberships)
      .set({ role, approvalLimitPaise: limitPaise })
      .where(and(eq(memberships.companyId, args.companyId), eq(memberships.userId, args.userId)));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "member.updated",
      entityType: "user",
      entityId: args.userId,
      before: { role: target.role, limitPaise: target.approvalLimitPaise },
      after: { role, limitPaise },
    });
  });
}

/** Take a person out of the company. Their history stays; their login does not work here any more. */
export async function removeTeamMember(db: Transactor, args: { companyId: string; actorUserId: string; userId: string }) {
  return db.transaction(async (tx) => {
    await lockMemberships(tx, args.companyId);
    const actor = await requireMember(tx, args.companyId, args.actorUserId);
    const target = (
      await tx.select().from(memberships).where(and(eq(memberships.companyId, args.companyId), eq(memberships.userId, args.userId)))
    )[0];
    if (!target) throw new DomainError("NOT_A_MEMBER", "That person does not belong to this company");
    if (args.userId !== args.actorUserId && !canManageMember(actor.role, target.role)) {
      throw new DomainError("NOT_ALLOWED", "You cannot remove that member (only an owner can remove owners)");
    }
    if (target.role === "owner" && (await ownerCount(tx, args.companyId)) <= 1) {
      throw new DomainError("LAST_OWNER", "A company must keep at least one owner");
    }
    await tx.delete(memberships).where(and(eq(memberships.companyId, args.companyId), eq(memberships.userId, args.userId)));
    // Anyone working in this company on a session is switched out of it.
    await tx
      .update(sessions)
      .set({ activeCompanyId: null })
      .where(and(eq(sessions.userId, args.userId), eq(sessions.activeCompanyId, args.companyId)));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "member.removed",
      entityType: "user",
      entityId: args.userId,
      before: { role: target.role },
    });
  });
}

/**
 * An owner or admin sets a temporary password for someone who is locked out or has forgotten theirs.
 * The person must choose their own at next sign-in, every session they have is ended, and any
 * lockout is cleared. Refused when the login also belongs to another company, because then the
 * password protects that company's data too and only the person can change it.
 */
export async function resetMemberPassword(
  db: Transactor,
  args: { companyId: string; actorUserId: string; userId: string; temporaryPassword: string },
) {
  return db.transaction(async (tx) => {
    const actor = await requireMember(tx, args.companyId, args.actorUserId);
    const target = (
      await tx.select().from(memberships).where(and(eq(memberships.companyId, args.companyId), eq(memberships.userId, args.userId)))
    )[0];
    if (!target) throw new DomainError("NOT_A_MEMBER", "That person does not belong to this company");
    if (args.userId === args.actorUserId) throw new DomainError("NOT_ALLOWED", "Change your own password from your account instead");
    if (!canManageMember(actor.role, target.role)) {
      throw new DomainError("NOT_ALLOWED", "You cannot reset that member's password (only an owner can manage owners)");
    }
    const elsewhere = await tx.execute(
      sql`SELECT count(*)::int AS n FROM memberships WHERE user_id = ${args.userId} AND company_id <> ${args.companyId}`,
    );
    if (Number((elsewhere.rows as { n: number }[])[0]?.n ?? 0) > 0) {
      throw new DomainError("SHARED_LOGIN", "This person also works in another company, so only they can change their password");
    }
    const user = one(await tx.select().from(users).where(eq(users.id, args.userId)), "user");
    assertPasswordStrength(args.temporaryPassword, user.email);
    const passwordHash = await hashPassword(args.temporaryPassword);
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, args.userId));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, args.userId), sql`${sessions.revokedAt} IS NULL`));
    await recordAudit(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "member.password_reset",
      entityType: "user",
      entityId: args.userId,
      after: { mustChangePassword: true },
    });
  });
}
