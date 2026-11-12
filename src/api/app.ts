import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { Db } from "../db/client";
import type { Role } from "../domain/approval";
import { DomainError } from "../domain/errors";
import { type Action, PERMISSIONS, can } from "../domain/permissions";
import { changePassword, getSessionContext, login, logout, registerAccount, switchCompany } from "../server/auth";
import { createRateLimiter, toApiError } from "./http";
import { registerBusinessRoutes } from "./routes";

export interface ApiConfig {
  /** Let anyone create a company and an owner login. Off unless you want open sign-up. */
  allowSignup: boolean;
  /** Mark the session cookie Secure (turn on whenever the site is served over HTTPS). */
  secureCookies: boolean;
  /** Extra origins allowed to make changes, e.g. a dev server. The server's own origin is always allowed. */
  allowedOrigins: string[];
  /** Read the client address from X-Forwarded-For (only behind a proxy you control). */
  trustProxy: boolean;
}

export const DEFAULT_CONFIG: ApiConfig = { allowSignup: false, secureCookies: false, allowedOrigins: [], trustProxy: false };

export type Env = { Variables: { session: NonNullable<Awaited<ReturnType<typeof getSessionContext>>>; db: Db; now: () => Date } };
export type AppContext = Context<Env>;

export const COOKIE = "erp_session";
const SESSION_SECONDS = 12 * 3600;

/** Everything the screens need to know about the signed-in person, including what they may do. */
function describe(ctx: NonNullable<Awaited<ReturnType<typeof getSessionContext>>>) {
  const allowed = ctx.role ? (Object.keys(PERMISSIONS) as Action[]).filter((a) => can(ctx.role as Role, a)) : [];
  return {
    user: ctx.user,
    companyId: ctx.companyId,
    role: ctx.role,
    approvalLimitPaise: ctx.limitPaise,
    companies: ctx.companies,
    permissions: allowed,
  };
}

/**
 * The whole HTTP API as a Hono app. It holds no state of its own beyond a login rate limiter, so it
 * is easy to test by calling `app.request(...)` without a network.
 */
export function createApp(db: Db, partial: Partial<ApiConfig> = {}, clock: () => Date = () => new Date()) {
  const config: ApiConfig = { ...DEFAULT_CONFIG, ...partial };
  const app = new Hono<Env>();
  const loginLimiter = createRateLimiter({ max: 20, windowMs: 5 * 60 * 1000, now: () => clock().getTime() });
  const signupLimiter = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000, now: () => clock().getTime() });

  const clientKey = (c: AppContext) =>
    (config.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ??
    ((c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "local");

  app.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: "same-origin",
    xFrameOptions: "DENY",
  }));

  app.use("/api/*", async (c, next) => {
    c.set("db", db);
    c.set("now", clock);
    c.header("Cache-Control", "no-store");
    // Changes must come from this site: a browser always states where a request came from, and a
    // JSON body cannot be sent cross-site without the server's say-so.
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin && origin !== new URL(c.req.url).origin && !config.allowedOrigins.includes(origin)) {
        throw new DomainError("BAD_ORIGIN", "This request did not come from the application");
      }
      const type = c.req.header("content-type");
      const length = Number(c.req.header("content-length") ?? 0);
      if (length > 1_000_000) throw new DomainError("PAYLOAD_TOO_LARGE", "That request is too large");
      if ((length > 0 || type) && !type?.toLowerCase().startsWith("application/json")) {
        throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Send JSON");
      }
    }
    await next();
  });

  app.onError((error, c) => {
    const { status, body } = toApiError(error);
    if (status === 500) console.error(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}`, error);
    return c.json(body, status);
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "No such page" } }, 404));

  app.get("/api/health", (c) => c.json({ ok: true }));
  // The sign-in page asks this to know whether to offer "Create a company".
  app.get("/api/auth/options", (c) => c.json({ signup: config.allowSignup }));

  // ---- Who is calling
  const sessionFrom = async (c: AppContext) => {
    const ctx = await getSessionContext(db, getCookie(c, COOKIE) ?? "");
    if (!ctx) throw new DomainError("UNAUTHENTICATED", "Please sign in");
    return ctx;
  };
  const setSessionCookie = (c: AppContext, token: string) =>
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: config.secureCookies, path: "/", maxAge: SESSION_SECONDS });

  // ---- Public routes
  app.post("/api/auth/login", async (c) => {
    loginLimiter.hit(clientKey(c));
    const body = z.object({ email: z.string().min(1), password: z.string().min(1) }).parse(await c.req.json().catch(() => ({})));
    const result = await login(db, { ...body, userAgent: c.req.header("user-agent") });
    setSessionCookie(c, result.token);
    const ctx = (await getSessionContext(db, result.token)) as NonNullable<Awaited<ReturnType<typeof getSessionContext>>>;
    return c.json({ ...describe(ctx), mustChangePassword: result.mustChangePassword });
  });

  app.post("/api/auth/register", async (c) => {
    if (!config.allowSignup) throw new DomainError("SIGNUP_DISABLED", "Sign-up is switched off; ask an administrator to add you");
    signupLimiter.hit(clientKey(c));
    const body = await c.req.json().catch(() => ({}));
    const { companyId } = await registerAccount(db, body);
    const owner = (body as { owner: { email: string; password: string } }).owner;
    const result = await login(db, { email: owner.email, password: owner.password, userAgent: c.req.header("user-agent") });
    setSessionCookie(c, result.token);
    const ctx = (await getSessionContext(db, result.token)) as NonNullable<Awaited<ReturnType<typeof getSessionContext>>>;
    return c.json({ ...describe(ctx), companyId }, 201);
  });

  // ---- Needs a login, not a company
  app.get("/api/auth/me", async (c) => c.json(describe(await sessionFrom(c))));

  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, COOKIE);
    if (token) await logout(db, token);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.post("/api/auth/switch-company", async (c) => {
    const session = await sessionFrom(c);
    const { companyId } = z.object({ companyId: z.uuid() }).parse(await c.req.json().catch(() => ({})));
    await switchCompany(db, { sessionId: session.sessionId, userId: session.user.id, companyId });
    return c.json(describe((await getSessionContext(db, getCookie(c, COOKIE) as string)) as NonNullable<Awaited<ReturnType<typeof getSessionContext>>>));
  });

  app.post("/api/auth/change-password", async (c) => {
    const session = await sessionFrom(c);
    const body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }).parse(await c.req.json().catch(() => ({})));
    await changePassword(db, { userId: session.user.id, keepSessionId: session.sessionId, ...body });
    return c.json({ ok: true });
  });

  // ---- Everything else needs a login and a company
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
    const session = await sessionFrom(c);
    if (!session.companyId || !session.role) throw new DomainError("NO_COMPANY", "You are not working in a company");
    c.set("session", session);
    return next();
  });
  registerBusinessRoutes(app);
  return app;
}
