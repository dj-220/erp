import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/errors";

/**
 * Passwords are stored as scrypt hashes with a random salt, in the form
 * `scrypt$N$r$p$salt$hash`. The cost parameters are stored with each hash, so raising them later
 * does not lock anyone out. `ERP_SCRYPT_LOG_N` (default 15) lets tests run faster.
 */
const KEY_LENGTH = 64;
const R = 8;
const P = 1;

const logN = () => {
  const value = Number(process.env.ERP_SCRYPT_LOG_N ?? 15);
  return Number.isInteger(value) && value >= 10 && value <= 20 ? value : 15;
};

function derive(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 2 ** logN();
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** True when the password matches the stored hash. Takes the same time whether or not it does. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const N = Number(n);
  // A damaged or tampered row must fail the check, not crash it or make the server do huge work.
  const sane =
    Number.isInteger(Math.log2(N)) && N >= 2 ** 10 && N <= 2 ** 20 && Number(r) >= 1 && Number(r) <= 16 && Number(p) >= 1 && Number(p) <= 4;
  if (!sane) return false;
  try {
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(password, Buffer.from(salt, "base64"), N, Number(r), Number(p));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Spend the time of a real check when the email is unknown, so response time does not reveal which emails exist. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(password, await dummyHash);
}

const COMMON = new Set([
  "password", "password1", "password123", "passw0rd123", "1234567890", "12345678910", "qwertyuiop",
  "qwerty12345", "iloveyou123", "welcome123", "admin12345", "letmein1234", "abc1234567", "changeme123",
  "India@12345", "Password@123", "Admin@12345", "Welcome@123",
].map((p) => p.toLowerCase()));

/** Length matters more than symbols: at least 10 characters, not a well-known password, not the email. */
export function assertPasswordStrength(password: string, email?: string): void {
  if (password.length < 10) throw new DomainError("WEAK_PASSWORD", "Use at least 10 characters");
  if (password.length > 128) throw new DomainError("WEAK_PASSWORD", "Use at most 128 characters");
  if (COMMON.has(password.toLowerCase())) throw new DomainError("WEAK_PASSWORD", "That password is too common");
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    throw new DomainError("WEAK_PASSWORD", "The password must not contain your email name");
  }
  if (/^(.)\1+$/.test(password)) throw new DomainError("WEAK_PASSWORD", "Use a less repetitive password");
}
