import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { auditLog, companies, memberships, sessions, users } from "../db/schema";
import { DomainError } from "../domain/errors";
import { changePassword, getSessionContext, login, logout, registerAccount, switchCompany } from "./auth";
import { createCompany } from "./company";
import { assertPasswordStrength, hashPassword, verifyPassword } from "./passwords";
import { addTeamMember, listTeam, removeTeamMember, resetMemberPassword, updateTeamMember } from "./team";
import { expectDomainError, freshGstin } from "./test-helpers";

let db: Db;
let seq = 0;
const GOOD = "correct horse battery";

beforeAll(async () => {
  ({ db } = await openDb());
});

/** A company with an owner who can log in. */
async function signUp(label = "Acme") {
  seq += 1;
  const email = `owner${seq}@auth.example`;
  const { companyId, userId } = await registerAccount(db, {
    legalName: `${label} ${seq}`,
    gstin: freshGstin("27"),
    owner: { email, name: "Owner", password: GOOD },
  });
  return { companyId, userId, email };
}

describe("passwords", () => {
  it("hashes with a random salt and verifies only the right password", async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword("wrong password!", a)).toBe(false);
    expect(await verifyPassword(GOOD, "not a hash")).toBe(false);
    expect(await verifyPassword(GOOD, "scrypt$1$1$1$AA$AA")).toBe(false);
  });

  it("treats equivalent Unicode as the same password", async () => {
    const hash = await hashPassword("café-au-lait-9");
    expect(await verifyPassword("café-au-lait-9", hash)).toBe(true);
  });

  it("insists on a decent password", () => {
    const code = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        return e instanceof DomainError ? e.code : "other";
      }
      return undefined;
    };
    expect(code(() => assertPasswordStrength("short"))).toBe("WEAK_PASSWORD");
    expect(code(() => assertPasswordStrength("password123"))).toBe("WEAK_PASSWORD");
    expect(code(() => assertPasswordStrength("aaaaaaaaaaaa"))).toBe("WEAK_PASSWORD");
    expect(code(() => assertPasswordStrength("x".repeat(129)))).toBe("WEAK_PASSWORD");
    expect(code(() => assertPasswordStrength("rajivkumar2025", "rajivkumar@acme.example"))).toBe("WEAK_PASSWORD");
    expect(code(() => assertPasswordStrength(GOOD, "someone@acme.example"))).toBeUndefined();
  });
});

describe("signing up", () => {
  it("creates the company and a login for its owner, and the password is never stored in clear", async () => {
    const { companyId, userId, email } = await signUp();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user?.passwordHash?.startsWith("scrypt$")).toBe(true);
    expect(JSON.stringify(user)).not.toContain(GOOD);
    const [member] = await db.select().from(memberships).where(eq(memberships.companyId, companyId));
    expect(member).toMatchObject({ userId, role: "owner" });
    const result = await login(db, { email: email.toUpperCase(), password: GOOD });
    expect(result.companies).toMatchObject([{ companyId, role: "owner" }]);
  });

  it("refuses a weak password, a taken email and a bad GSTIN without leaving anything behind", async () => {
    const { email } = await signUp();
    const before = (await db.select().from(companies)).length;
    await expectDomainError(registerAccount(db, { legalName: "X", stateCode: "27", owner: { email: "new@auth.example", name: "N", password: "short" } }), "WEAK_PASSWORD");
    await expectDomainError(registerAccount(db, { legalName: "X", stateCode: "27", owner: { email, name: "N", password: GOOD } }), "EMAIL_TAKEN");
    await expectDomainError(
      registerAccount(db, { legalName: "X", gstin: "27AAAAA0000A1Z0", owner: { email: "bad@auth.example", name: "N", password: GOOD } }),
      "INVALID_GSTIN",
    );
    expect((await db.select().from(companies)).length).toBe(before);
    expect(await db.select().from(users).where(eq(users.email, "bad@auth.example"))).toHaveLength(0);
  });
});

describe("logging in", () => {
  it("gives the same answer for an unknown email and a wrong password", async () => {
    const { email } = await signUp();
    const unknown = await login(db, { email: "nobody@auth.example", password: GOOD }).catch((e) => e);
    const wrong = await login(db, { email, password: "wrong password here" }).catch((e) => e);
    expect(unknown).toBeInstanceOf(DomainError);
    expect(wrong).toBeInstanceOf(DomainError);
    expect([unknown.code, unknown.message]).toEqual([wrong.code, wrong.message]);
  });

  it("locks the account after five wrong passwords, even for the right one, until the time passes", async () => {
    const { email, userId } = await signUp();
    for (let i = 0; i < 5; i++) {
      await expectDomainError(login(db, { email, password: `wrong password ${i}` }), "INVALID_LOGIN");
    }
    await expectDomainError(login(db, { email, password: GOOD }), "INVALID_LOGIN"); // locked
    const [locked] = await db.select().from(users).where(eq(users.id, userId));
    expect(locked?.lockedUntil).not.toBeNull();
    expect(locked?.failedLoginCount).toBe(5);

    await db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, userId));
    expect((await login(db, { email, password: GOOD })).user.id).toBe(userId);
    const [reset] = await db.select().from(users).where(eq(users.id, userId));
    expect(reset).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(reset?.lastLoginAt).not.toBeNull();
  });

  it("does not let a deactivated person in", async () => {
    const { email, userId } = await signUp();
    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
    await expectDomainError(login(db, { email, password: GOOD }), "INVALID_LOGIN");
  });

  it("records the login in the company's audit log", async () => {
    const { email, companyId } = await signUp();
    await login(db, { email, password: GOOD });
    const log = await db.select().from(auditLog).where(eq(auditLog.companyId, companyId));
    expect(log.map((l) => l.action)).toContain("user.logged_in");
  });
});

describe("sessions", () => {
  it("identify the person, company, role and limit, and store only a hash of the token", async () => {
    const { email, companyId, userId } = await signUp();
    const { token, expiresAt } = await login(db, { email, password: GOOD, userAgent: "vitest" });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 3600 * 1000);

    const context = await getSessionContext(db, token);
    expect(context).toMatchObject({ user: { id: userId, email }, companyId, role: "owner", limitPaise: 0 });
    const [stored] = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(stored?.tokenHash).toHaveLength(64);
    expect(stored?.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("end on logout, on expiry, and when the person is deactivated", async () => {
    const { email, userId } = await signUp();
    expect(await getSessionContext(db, "")).toBeNull();
    expect(await getSessionContext(db, "not-a-real-token")).toBeNull();

    const a = (await login(db, { email, password: GOOD })).token;
    await logout(db, a);
    expect(await getSessionContext(db, a)).toBeNull();
    await logout(db, a); // harmless twice
    await logout(db, "never existed");

    const b = (await login(db, { email, password: GOOD })).token;
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, userId));
    expect(await getSessionContext(db, b)).toBeNull();

    const c = (await login(db, { email, password: GOOD })).token;
    expect(await getSessionContext(db, c)).not.toBeNull();
    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
    expect(await getSessionContext(db, c)).toBeNull();
  });

  it("let a person with two companies switch between them, but not into a stranger's", async () => {
    const one = await signUp("First");
    const two = await signUp("Second");
    // The first owner is also invited into the second company
    await addTeamMember(db, { companyId: two.companyId, actorUserId: two.userId, email: one.email, name: "Owner", role: "accountant" });
    const { token } = await login(db, { email: one.email, password: GOOD });
    const context = (await getSessionContext(db, token))!;
    expect(context.companies.map((c) => c.role)).toEqual(["owner", "accountant"]);
    expect(context.companyId).toBe(one.companyId);

    await switchCompany(db, { sessionId: context.sessionId, userId: context.user.id, companyId: two.companyId });
    expect(await getSessionContext(db, token)).toMatchObject({ companyId: two.companyId, role: "accountant" });
    const stranger = await signUp("Stranger");
    await expectDomainError(switchCompany(db, { sessionId: context.sessionId, userId: context.user.id, companyId: stranger.companyId }), "NOT_A_MEMBER");
  });

  it("end for every other device when the password is changed", async () => {
    const { email, userId } = await signUp();
    const here = await login(db, { email, password: GOOD });
    const elsewhere = await login(db, { email, password: GOOD });
    const context = (await getSessionContext(db, here.token))!;

    await expectDomainError(changePassword(db, { userId, keepSessionId: context.sessionId, currentPassword: "wrong one!!", newPassword: "a brand new passphrase" }), "INVALID_LOGIN");
    await expectDomainError(changePassword(db, { userId, keepSessionId: context.sessionId, currentPassword: GOOD, newPassword: "short" }), "WEAK_PASSWORD");
    await expectDomainError(changePassword(db, { userId, keepSessionId: context.sessionId, currentPassword: GOOD, newPassword: GOOD }), "WEAK_PASSWORD");

    await changePassword(db, { userId, keepSessionId: context.sessionId, currentPassword: GOOD, newPassword: "a brand new passphrase" });
    expect(await getSessionContext(db, here.token)).not.toBeNull();
    expect(await getSessionContext(db, elsewhere.token)).toBeNull();
    await expectDomainError(login(db, { email, password: GOOD }), "INVALID_LOGIN");
    await expect(login(db, { email, password: "a brand new passphrase" })).resolves.toBeDefined();
  });
});

describe("managing the team", () => {
  it("adds a new person with an initial password they must replace, and keeps an existing login's password", async () => {
    const { companyId, userId } = await signUp();
    const add = (email: string, role: "admin" | "purchase" | "sales", extra: Record<string, unknown> = {}) =>
      addTeamMember(db, { companyId, actorUserId: userId, email, name: email.split("@")[0] as string, role, ...extra } as never);

    await expectDomainError(add("new@auth.example", "purchase"), "PASSWORD_REQUIRED");
    await expectDomainError(add("new@auth.example", "purchase", { initialPassword: "weak" }), "WEAK_PASSWORD");
    const created = await add("new@auth.example", "purchase", { initialPassword: "temporary passphrase", limitRupees: 10000 });
    expect(created.created).toBe(true);
    const welcome = await login(db, { email: "new@auth.example", password: "temporary passphrase" });
    expect(welcome.mustChangePassword).toBe(true);

    const other = await signUp("Other");
    const joined = await add(other.email, "admin"); // already has a login: no password needed, theirs is kept
    expect(joined.created).toBe(false);
    await expect(login(db, { email: other.email, password: GOOD })).resolves.toBeDefined();
    await expectDomainError(add("new@auth.example", "sales"), "ALREADY_MEMBER");

    const team = await listTeam(db, companyId);
    expect(team.map((m) => [m.role, m.limitPaise])).toEqual([["owner", 0], ["purchase", 1_000_000], ["admin", 0]]);
  });

  it("lets only an owner create or change an owner, and only managers manage at all", async () => {
    const { companyId, userId } = await signUp();
    const pw = "temporary passphrase";
    const admin = (await addTeamMember(db, { companyId, actorUserId: userId, email: "admin@auth.example", name: "Admin", role: "admin", initialPassword: pw })).userId;
    const sales = (await addTeamMember(db, { companyId, actorUserId: userId, email: "sales@auth.example", name: "Sales", role: "sales", initialPassword: pw })).userId;

    await expectDomainError(addTeamMember(db, { companyId, actorUserId: admin, email: "x@auth.example", name: "X", role: "owner", initialPassword: pw }), "NOT_ALLOWED");
    await expectDomainError(addTeamMember(db, { companyId, actorUserId: sales, email: "y@auth.example", name: "Y", role: "viewer", initialPassword: pw }), "NOT_ALLOWED");
    await expectDomainError(updateTeamMember(db, { companyId, actorUserId: admin, userId, limitRupees: 5 }), "NOT_ALLOWED"); // the owner
    await expectDomainError(updateTeamMember(db, { companyId, actorUserId: admin, userId: sales, role: "owner" }), "NOT_ALLOWED");
    await expectDomainError(updateTeamMember(db, { companyId, actorUserId: admin, userId: admin, role: "owner" }), "NOT_ALLOWED");
    await expectDomainError(updateTeamMember(db, { companyId, actorUserId: userId, userId, role: "viewer" }), "NOT_ALLOWED"); // own role

    await updateTeamMember(db, { companyId, actorUserId: admin, userId: sales, role: "stores", limitRupees: 2500 });
    expect((await listTeam(db, companyId)).find((m) => m.userId === sales)).toMatchObject({ role: "stores", limitPaise: 250_000 });
  });

  it("never leaves a company without an owner", async () => {
    const { companyId, userId } = await signUp();
    await expectDomainError(removeTeamMember(db, { companyId, actorUserId: userId, userId }), "LAST_OWNER");
    const second = (await addTeamMember(db, { companyId, actorUserId: userId, email: "second@auth.example", name: "Second", role: "owner", initialPassword: "temporary passphrase" })).userId;
    await expectDomainError(updateTeamMember(db, { companyId, actorUserId: second, userId: second, role: "admin" }), "NOT_ALLOWED"); // own role
    await updateTeamMember(db, { companyId, actorUserId: userId, userId: second, role: "admin" }); // one owner left
    await expectDomainError(updateTeamMember(db, { companyId, actorUserId: second, userId, role: "admin" }), "NOT_ALLOWED"); // an admin cannot demote the owner
    await expectDomainError(removeTeamMember(db, { companyId, actorUserId: userId, userId }), "LAST_OWNER");
  });

  it("takes a removed person out of the company on their next request", async () => {
    const { companyId, userId } = await signUp();
    const sales = (await addTeamMember(db, { companyId, actorUserId: userId, email: "gone@auth.example", name: "Gone", role: "sales", initialPassword: "temporary passphrase" })).userId;
    const { token } = await login(db, { email: "gone@auth.example", password: "temporary passphrase" });
    expect((await getSessionContext(db, token))?.companyId).toBe(companyId);
    await removeTeamMember(db, { companyId, actorUserId: userId, userId: sales });
    expect(await getSessionContext(db, token)).toMatchObject({ companyId: null, role: null, companies: [] });
    expect((await listTeam(db, companyId)).map((m) => m.userId)).toEqual([userId]);
    const log = await db.select().from(auditLog).where(eq(auditLog.companyId, companyId));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["member.added", "member.removed"]));
  });

  describe("resetting a password", () => {
    const TEMP = "temporary passphrase";
    const NEXT = "a brand new passphrase";

    it("lets a manager set a temporary password: old one dead, sessions ended, lockout cleared, change forced", async () => {
      const { companyId, userId } = await signUp();
      const sales = (await addTeamMember(db, { companyId, actorUserId: userId, email: "forgot@auth.example", name: "Forgot", role: "sales", initialPassword: TEMP })).userId;
      const { token } = await login(db, { email: "forgot@auth.example", password: TEMP });
      for (let i = 0; i < 5; i += 1) await login(db, { email: "forgot@auth.example", password: "wrong wrong wrong" }).catch(() => undefined);
      await expectDomainError(login(db, { email: "forgot@auth.example", password: TEMP }), "INVALID_LOGIN"); // locked: even the right password fails

      await resetMemberPassword(db, { companyId, actorUserId: userId, userId: sales, temporaryPassword: NEXT });

      expect(await getSessionContext(db, token)).toBeNull();
      await expectDomainError(login(db, { email: "forgot@auth.example", password: TEMP }), "INVALID_LOGIN");
      expect((await login(db, { email: "forgot@auth.example", password: NEXT })).mustChangePassword).toBe(true);
      const log = await db.select().from(auditLog).where(eq(auditLog.companyId, companyId));
      const entry = log.find((l) => l.action === "member.password_reset");
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry)).not.toContain(NEXT);
    });

    it("refuses yourself, a weak password, an owner (by an admin), a stranger, and a login shared with another company", async () => {
      const { companyId, userId } = await signUp();
      const admin = (await addTeamMember(db, { companyId, actorUserId: userId, email: "adm@auth.example", name: "Adm", role: "admin", initialPassword: TEMP })).userId;
      const sales = (await addTeamMember(db, { companyId, actorUserId: userId, email: "sal@auth.example", name: "Sal", role: "sales", initialPassword: TEMP })).userId;
      const reset = (actor: string, target: string, password = NEXT, company = companyId) =>
        resetMemberPassword(db, { companyId: company, actorUserId: actor, userId: target, temporaryPassword: password });

      await expectDomainError(reset(userId, userId), "NOT_ALLOWED");
      await expectDomainError(reset(admin, userId), "NOT_ALLOWED");
      await expectDomainError(reset(sales, admin), "NOT_ALLOWED");
      await expectDomainError(reset(userId, sales, "short"), "WEAK_PASSWORD");
      await expectDomainError(reset(userId, (await signUp()).userId), "NOT_A_MEMBER");

      const other = await signUp("Elsewhere");
      await addTeamMember(db, { companyId, actorUserId: userId, email: other.email, name: "Both", role: "viewer" }); // works in two companies
      await expectDomainError(reset(userId, other.userId), "SHARED_LOGIN");
      await expect(login(db, { email: other.email, password: GOOD })).resolves.toBeDefined(); // untouched
    });
  });
});

describe("company creation outside sign-up still works", () => {
  it("createCompany remains usable on its own", async () => {
    const { company } = await createCompany(db, { legalName: "Direct Co", stateCode: "27", owner: { email: "direct@auth.example", name: "D" } });
    expect(company.stateCode).toBe("27");
  });
});
