import type { NextFunction, Request, Response } from "express";
import { log } from "./logger.js";

/** An error with an HTTP status the client is allowed to see. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code?: string) =>
  new HttpError(400, message, code);
export const unauthorized = (message = "Sign in to continue.") =>
  new HttpError(401, message);
export const forbidden = (message = "You do not have access to this.") =>
  new HttpError(403, message);
export const notFound = (message = "Not found.") => new HttpError(404, message);
export const conflict = (message: string, code?: string) =>
  new HttpError(409, message, code);

/** Wraps an async route so a rejected promise reaches the error middleware. */
export function route<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req as T, res, next).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  log.error("unhandled request error", {
    message: err instanceof Error ? err.message : String(err),
  });
  if (!env_isProduction()) console.error(err);
  res.status(500).json({ error: "Something went wrong on our end." });
}

function env_isProduction() {
  return process.env.NODE_ENV === "production";
}

/** Reads a required string field off a JSON body. */
export function requireString(body: unknown, field: string, max = 500): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`\`${field}\` is required.`, "missing_field");
  }
  if (value.length > max)
    throw badRequest(`\`${field}\` is too long.`, "field_too_long");
  return value.trim();
}

export function optionalString(
  body: unknown,
  field: string,
  max = 2000,
): string | undefined {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw badRequest(`\`${field}\` must be text.`);
  if (value.length > max) throw badRequest(`\`${field}\` is too long.`);
  return value.trim();
}

export function requireInt(
  body: unknown,
  field: string,
  min = 0,
  max = 1_000_000_000,
): number {
  const raw = (body as Record<string, unknown> | null)?.[field];
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`\`${field}\` must be a number.`);
  }
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) {
    throw badRequest(`\`${field}\` must be between ${min} and ${max}.`);
  }
  return rounded;
}
