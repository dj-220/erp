import { expect } from "vitest";
import type { Db } from "../db/client";
import { memberships, users } from "../db/schema";
import type { Role } from "../domain/approval";
import { DomainError } from "../domain/errors";
import { gstinChecksumChar } from "../domain/gstin";

/** A valid GSTIN built from its first 14 characters. */
export const gstinFrom = (body14: string) => body14 + gstinChecksumChar(body14);

let gstinSeq = 0;
/** A valid GSTIN in the given state that no other call in this test file has returned. */
export function freshGstin(state = "27"): string {
  gstinSeq += 1;
  return gstinFrom(`${state}ABCDE${String(1000 + gstinSeq)}F1Z`);
}

/** Add a person to a company with a role and an approval limit (in rupees); returns their user id. */
export async function addMember(
  db: Db,
  companyId: string,
  args: { email: string; name?: string; role: Role; limitRupees?: number },
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: args.email.toLowerCase(), name: args.name ?? args.email })
    .returning();
  if (!user) throw new Error("user was not created");
  await db.insert(memberships).values({
    companyId,
    userId: user.id,
    role: args.role,
    approvalLimitPaise: Math.round((args.limitRupees ?? 0) * 100),
  });
  return user.id;
}

/** Every message along an error's cause chain (Drizzle wraps the Postgres error). */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    parts.push(String((e as { message?: unknown }).message ?? e));
  }
  return parts.join(" | ");
}

/** Assert that a promise rejects with a DomainError carrying exactly this code. */
export async function expectDomainError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected DomainError ${code}`).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}
