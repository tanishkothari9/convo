import express from "express";
import cookieParser from "cookie-parser";
import { env } from "./env.js";
import { db } from "./db/index.js";
import { log } from "./lib/logger.js";
import { errorHandler } from "./lib/http.js";
import { authRoutes } from "./routes/auth.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { catalogRoutes } from "./routes/catalog.js";
import { providerRoutes } from "./routes/providers.js";
import { shopRoutes } from "./routes/shop.js";
import { apiRoutes } from "./routes/api.js";
import { modelProvider } from "./models/index.js";
import { limiters } from "./lib/ratelimit.js";
import { clientIp, rateLimit, securityHeaders } from "./lib/security.js";

const app = express();

app.disable("x-powered-by");
// One proxy hop is trusted for the client address; beyond that, X-Forwarded-For
// is attacker-controlled and rate limiting by it would be trivially evaded.
app.set("trust proxy", 1);
app.use(securityHeaders);
// Product images can be data URLs, so the JSON limit is generous but bounded.
/*
 * The raw body is kept alongside the parsed one.
 *
 * A webhook signature is an HMAC over the exact bytes the sender signed. Once
 * JSON.parse has been round-tripped through stringify the bytes are no longer
 * the same — key order and whitespace both move — and every signature fails.
 * Only the webhook routes read this.
 */
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  const provider = modelProvider();
  res.json({
    ok: true,
    service: "convo",
    model: { provider: provider.name, model: provider.model },
  });
});

// Public first, then the dashboard behind its own prefix: the dashboard
// routers apply requireAuth at the router level, so they must not sit on a
// path that public requests also travel through.
// The public REST API is versioned and authenticated by key, so it sits
// outside /api where the cookie-authenticated surfaces live.
app.use("/v1", apiRoutes);
/*
 * Unauthenticated by design: the signature is the credential.
 *
 * Under /api with everything else, not at the root. The web app and this server
 * are separate origins — nothing here serves the built frontend — so
 * PUBLIC_BASE_URL is the address of the site, and the only path that reaches
 * this process from there is /api. A webhook URL at the root would be a URL the
 * merchant pastes into their ERP that 404s forever.
 */
app.use("/api", webhookRoutes);

app.use("/api/auth", authRoutes);
app.use("/api", rateLimit(limiters.publicRead, clientIp), shopRoutes);
const dashboardLimit = rateLimit(limiters.dashboard, clientIp);
app.use("/api/dashboard", dashboardLimit, catalogRoutes);
app.use("/api/dashboard", dashboardLimit, providerRoutes);

app.use(["/api", "/v1"], (_req, res) => {
  res.status(404).json({ error: "No such endpoint." });
});

app.use(errorHandler);

db(); // open and migrate before the first request

const server = app.listen(env.port, () => {
  const provider = modelProvider();
  log.info("Convo is up", {
    port: env.port,
    model: `${provider.name}/${provider.model}`,
    publicBaseUrl: env.publicBaseUrl,
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("shutting down");
    server.close(() => process.exit(0));
  });
}
