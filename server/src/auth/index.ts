/**
 * Dashboard authentication.
 *
 * Email + password, an opaque session id in an httpOnly cookie, and a
 * server-side session row. Deliberately small: the interesting security in
 * Convo is the money gate and the provider-credential handling, not a bespoke
 * auth scheme.
 */
import type { NextFunction, Request, Response } from "express";
import { sessions, tenants, users } from "../db/repo.js";
import { hashPassword, verifyPassword } from "../lib/crypto.js";
import { token } from "../lib/ids.js";
import { env } from "../env.js";
import { unauthorized } from "../lib/http.js";
import type { Tenant, TenantUser } from "../domain/types.js";

export const SESSION_COOKIE = "convo_session";

export interface AuthedRequest extends Request {
  auth: { user: TenantUser; tenant: Tenant };
}

export function issueSession(
  res: Response,
  userId: string,
  tenantId: string,
): void {
  const sessionId = token();
  sessions.create(sessionId, userId, tenantId);
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: 30 * 86_400_000,
    path: "/",
  });
}

export function clearSession(req: Request, res: Response): void {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (typeof sessionId === "string") sessions.destroy(sessionId);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Resolves the session, or 401s. Every dashboard route sits behind this. */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (typeof sessionId !== "string" || sessionId === "") {
    next(unauthorized());
    return;
  }
  const resolved = sessions.resolve(sessionId);
  if (!resolved) {
    next(unauthorized("Your session has expired. Sign in again."));
    return;
  }
  const user = users.byId(resolved.userId);
  const tenant = tenants.byId(resolved.tenantId);
  if (!user || !tenant) {
    next(unauthorized());
    return;
  }
  (req as AuthedRequest).auth = { user, tenant };
  next();
}

export function passwordFields(password: string): {
  hash: string;
  salt: string;
} {
  return hashPassword(password);
}

export function passwordMatches(
  password: string,
  hash: string,
  salt: string,
): boolean {
  return verifyPassword(password, hash, salt);
}

/**
 * Burns the same work as a real password check.
 *
 * Without this, "no such email" answers measurably faster than "wrong
 * password", which turns the sign-in form into an account-enumeration oracle.
 * The salt is fixed and the result discarded; only the elapsed time matters.
 */
export function burnPasswordWork(password: string): void {
  verifyPassword(password, DUMMY_HASH, DUMMY_SALT);
}

const DUMMY_SALT = "convo-timing-equalisation-salt";
const DUMMY_HASH = hashPassword("convo-timing-equalisation").hash;
