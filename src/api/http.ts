import { ZodError } from "zod";
import { pgErrorCode } from "../db/client";
import { DomainError } from "../domain/errors";

export interface ApiError {
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500;
  body: { error: { code: string; message: string; issues?: { path: string; message: string }[] } };
}

const UNAUTHENTICATED = new Set(["UNAUTHENTICATED", "INVALID_LOGIN"]);
const FORBIDDEN = new Set([
  "FORBIDDEN",
  "NO_COMPANY",
  "NOT_A_MEMBER",
  "NOT_ALLOWED",
  "READ_ONLY",
  "INSUFFICIENT_AUTHORITY",
  "SELF_APPROVAL",
  "SELF_OVERRIDE",
  "SIGNUP_DISABLED",
  "BAD_ORIGIN",
]);
const CONFLICT_PREFIXES = ["DUPLICATE_", "ALREADY_", "HAS_", "NOT_DRAFT", "NOT_PENDING", "NOT_HELD", "NOT_MATCHED", "NOT_CONFIRMED", "NOT_CANCELLABLE", "NOT_RECEIVABLE", "NOT_PAYABLE", "NOT_SUBMITTED", "STALE_", "MATCH_CHANGED", "EMAIL_TAKEN", "LAST_OWNER", "INSUFFICIENT_STOCK", "OVER_", "NOTHING_"];

/** Turn anything thrown into an HTTP status and a safe body. Unexpected errors reveal nothing. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "INVALID_INPUT",
          message: "Some fields are missing or wrong",
          issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
    };
  }
  if (error instanceof DomainError) {
    const code = error.code;
    const status: ApiError["status"] = UNAUTHENTICATED.has(code)
      ? 401
      : FORBIDDEN.has(code)
        ? 403
        : code.startsWith("UNKNOWN_")
          ? 404
          : CONFLICT_PREFIXES.some((p) => code.startsWith(p))
            ? 409
            : code === "RATE_LIMITED"
              ? 429
              : code === "UNSUPPORTED_MEDIA_TYPE"
                ? 415
                : code === "PAYLOAD_TOO_LARGE"
                  ? 413
                  : 422;
    return { status, body: { error: { code, message: error.message } } };
  }
  const pg = pgErrorCode(error);
  if (pg === "23505") return { status: 409, body: { error: { code: "CONFLICT", message: "That already exists" } } };
  if (pg === "23503" || pg === "23514") return { status: 422, body: { error: { code: "REJECTED", message: "The data was refused by the database's integrity rules" } } };
  return { status: 500, body: { error: { code: "INTERNAL", message: "Something went wrong on our side" } } };
}

/** A fixed-window counter: at most `max` hits per key in each `windowMs`. */
export function createRateLimiter(options: { max: number; windowMs: number; now?: () => number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const now = options.now ?? Date.now;
  return {
    /** Count a hit; throws RATE_LIMITED when the key is over its limit. */
    hit(key: string): void {
      const t = now();
      if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        hits.set(key, { count: 1, resetAt: t + options.windowMs });
        return;
      }
      entry.count += 1;
      if (entry.count > options.max) throw new DomainError("RATE_LIMITED", "Too many attempts; wait a few minutes and try again");
    },
  };
}
