import type { NextFunction, Request, Response } from "express";
import { env } from "../env.js";
import { HttpError } from "./http.js";
import type { RateLimiter } from "./ratelimit.js";

/**
 * Response headers applied to everything.
 *
 * The CSP is written for what this app actually loads: its own origin, Google
 * Fonts, product photography from anywhere over https, and Razorpay's checkout
 * script. `'unsafe-inline'` for styles is required by the inline `style`
 * attributes the tenant theming sets; scripts get no such exemption.
 */
export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=(self)",
  );
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");

  if (env.isProduction) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' https://checkout.razorpay.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
        "frame-src https://api.razorpay.com https://checkout.razorpay.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; "),
    );
  }
  next();
}

/** The client's address, trusting one proxy hop at most. */
export function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded !== "") {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export class RateLimitError extends HttpError {
  constructor(readonly retryAfter: number) {
    super(
      429,
      "Too many requests. Slow down and try again shortly.",
      "rate_limited",
    );
  }
}

/** Applies a limiter, keyed by whatever identifies the caller on that surface. */
export function rateLimit(
  limiter: RateLimiter,
  keyOf: (req: Request) => string,
  cost = 1,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = limiter.take(keyOf(req), cost);
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfter));
      next(new RateLimitError(result.retryAfter));
      return;
    }
    next();
  };
}
