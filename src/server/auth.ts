import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Executor, Transactor } from "../db/client";
import { pgErrorCode } from "../db/client";
import { companies, memberships, sessions, users } from "../db/schema";
import type { Role } from "../domain/approval";
import { DomainError } from "../domain/errors";
import { recordAudit } from "./audit";
import { type CreateCompanyInput, createCompany } from "./company";
import { assertPasswordStrength, burnPasswordCheck, hashPassword, verifyPassword } from "./passwords";
import { one } from "./util";

export const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const TOUCH_AFTER_MS = 5 * 60 * 1000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normaliseEmail = (email: string) => email.trim().toLowerCase();

export interface CompanyAccess {
  companyId: string;
  companyName: string;
  role: Role;
}

export interface SessionContext {
  sessionId: string;
  user: { id: string; email: string; name: string; mustChangePassword: boolean };
  /** The company the person is working in, or null if they belong to none. */
  companyId: string | null;
  role: Role | null;
  limitPaise: number;
  companies: CompanyAccess[];
}

async function accessFor(db: Executor, userId: string): Promise<CompanyAccess[]> {
  const rows = await db
    .select({ companyId: memberships.companyId, companyName: companies.legalName, role: memberships.role })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
  return rows;
}

async function startSession(
  tx: Executor,
  args: { userId: string; companyId: string | null; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  await tx.insert(sessions).values({
    userId: args.userId,
    tokenHash: sha256(token),
    activeCompanyId: args.companyId,
    userAgent: args.userAgent?.slice(0, 300) ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

export const RegisterInput = z.object({
  legalName: z.string().trim().min(1),
  gstin: z.string().trim().min(1).optional(),
  stateCode: z.string().length(2).optional(),
  tallyCompanyName: z.string().trim().min(1).optional(),
  owner: z.object({ email: z.email(), name: z.string().trim().min(1), password: z.string() }),
});
export type RegisterInput = z.input<typeof RegisterInput>;

/**
 * Create a company and its owner's login in one step (for the sign-up screen). The email must be
 * new: someone who already has a login adds a company from inside the app instead.
 */
export async function registerAccount(db: Transactor, rawInput: RegisterInput) {
  const input = RegisterInput.parse(rawInput);
  const email = normaliseEmail(input.owner.email);
  assertPasswordStrength(input.owner.password, email);
  const passwordHash = await hashPassword(input.owner.password);

  try {
    return await db.transaction(async (tx) => {
      const taken = (await tx.select({ id: users.id }).from(users).where(eq(users.email, email)))[0];
      if (taken) throw new DomainError("EMAIL_TAKEN", "That email already has a login");
      await tx.insert(users).values({ email, name: input.owner.name, passwordHash, passwordChangedAt: new Date() });
      const { company, owner } = await createCompany(tx, {
        legalName: input.legalName,
        gstin: input.gstin,
        stateCode: input.stateCode,
        tallyCompanyName: input.tallyCompanyName,
        owner: { email, name: input.owner.name },
      } satisfies CreateCompanyInput);
      return { companyId: company.id, userId: owner.id };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") throw new DomainError("EMAIL_TAKEN", "That email already has a login");
    throw error;
  }
}

const GENERIC_LOGIN_ERROR = "Wrong email or password, or the account is temporarily locked";

/**
 * Check an email and password and start a session. Every failure looks the same from outside, and
 * takes about the same time, so the response says nothing about which emails exist. After five wrong
 * passwords in a row the account is locked for 15 minutes.
 */
export async function login(db: Db, args: { email: string; password: string; userAgent?: string }) {
  const email = normaliseEmail(args.email);
  const user = (await db.select().from(users).where(eq(users.email, email)))[0];
  if (!user || !user.isActive || !user.passwordHash) {
    await burnPasswordCheck(args.password);
    throw new DomainError("INVALID_LOGIN", GENERIC_LOGIN_ERROR);
  }
  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    await burnPasswordCheck(args.password);
    throw new DomainError("INVALID_LOGIN", GENERIC_LOGIN_ERROR);
  }

  if (!(await verifyPassword(args.password, user.passwordHash))) {
    // Counted in SQL so that simultaneous guesses cannot all be counted as the first.
    await db
      .update(users)
      .set({
        failedLoginCount: sql`${users.failedLoginCount} + 1`,
        lockedUntil: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} THEN now() + ${`${LOCK_MINUTES} minutes`}::interval ELSE ${users.lockedUntil} END`,
      })
      .where(eq(users.id, user.id));
    throw new DomainError("INVALID_LOGIN", GENERIC_LOGIN_ERROR);
  }

  return db.transaction(async (tx) => {
    await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now }).where(eq(users.id, user.id));
    const access = await accessFor(tx, user.id);
    const first = access[0] ?? null;
    const session = await startSession(tx, { userId: user.id, companyId: first?.companyId ?? null, userAgent: args.userAgent });
    if (first) {
      await recordAudit(tx, {
        companyId: first.companyId,
        actorUserId: user.id,
        action: "user.logged_in",
        entityType: "user",
        entityId: user.id,
      });
    }
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      mustChangePassword: user.mustChangePassword,
      user: { id: user.id, email: user.email, name: user.name },
      companies: access,
      activeCompanyId: first?.companyId ?? null,
    };
  });
}

/** The person and company behind a session token, or null if it is unknown, expired or revoked. */
export async function getSessionContext(db: Db, token: string): Promise<SessionContext | null> {
  if (!token) return null;
  const now = new Date();
  const row = (
    await db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
  )[0];
  if (!row || !row.user.isActive) return null;

  if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
  }
  const access = await accessFor(db, row.user.id);
  const current = access.find((a) => a.companyId === row.session.activeCompanyId) ?? null;
  let limitPaise = 0;
  if (current) {
    const member = (
      await db
        .select({ limit: memberships.approvalLimitPaise })
        .from(memberships)
        .where(and(eq(memberships.userId, row.user.id), eq(memberships.companyId, current.companyId)))
    )[0];
    limitPaise = member?.limit ?? 0;
  }
  return {
    sessionId: row.session.id,
    user: { id: row.user.id, email: row.user.email, name: row.user.name, mustChangePassword: row.user.mustChangePassword },
    companyId: current?.companyId ?? null,
    role: current?.role ?? null,
    limitPaise,
    companies: access,
  };
}

/** End a session. Unknown or already-ended tokens are ignored. */
export async function logout(db: Db, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt)));
}

/** Work in a different company the person belongs to. */
export async function switchCompany(db: Db, args: { sessionId: string; userId: string; companyId: string }) {
  const access = await accessFor(db, args.userId);
  if (!access.some((a) => a.companyId === args.companyId)) {
    throw new DomainError("NOT_A_MEMBER", "You do not belong to that company");
  }
  await db.update(sessions).set({ activeCompanyId: args.companyId }).where(eq(sessions.id, args.sessionId));
}

/** Change your own password. Every other session of yours is ended. */
export async function changePassword(
  db: Db,
  args: { userId: string; keepSessionId: string; currentPassword: string; newPassword: string },
) {
  const user = one(await db.select().from(users).where(eq(users.id, args.userId)), "user");
  if (!user.passwordHash || !(await verifyPassword(args.currentPassword, user.passwordHash))) {
    throw new DomainError("INVALID_LOGIN", "The current password is wrong");
  }
  assertPasswordStrength(args.newPassword, user.email);
  if (args.newPassword === args.currentPassword) throw new DomainError("WEAK_PASSWORD", "Choose a different password");
  const passwordHash = await hashPassword(args.newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt), sql`${sessions.id} <> ${args.keepSessionId}`));
  });
}
