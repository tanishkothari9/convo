import { Router, type Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { audit, connections, products } from "../db/repo.js";
import { credentialsFor } from "../commerce/registry.js";
import { route } from "../lib/http.js";
import { limiters } from "../lib/ratelimit.js";
import { log } from "../lib/logger.js";

export const webhookRoutes = Router();

/**
 * Stock, as it moves.
 *
 * A nightly catalogue pull is a photograph: accurate when it was taken, wrong
 * by lunchtime. This is the other half — ERPNext posts here the moment a Stock
 * Ledger Entry is written, and the one item that moved is corrected in place.
 *
 * The merchant sets it up in their own Frappe with no code: one Webhook doc
 * pointed at this URL, with the secret Convo shows them on the provider page.
 *
 * Three things are deliberate:
 *
 *  - The connection id names the row; the signature is what authorises. An
 *    unguessable URL alone would be a bearer token that lives in a log file.
 *  - Only `actual_qty` is written. A stock event carrying a name or a price is
 *    not a reason to change either, or forging one becomes a way to edit a
 *    catalogue and, through it, what customers are charged.
 *  - An event for a warehouse the merchant does not sell from is accepted and
 *    ignored. It is not an error — ERPNext moves goods between warehouses all
 *    day, and answering 4xx would make their webhook log look broken.
 */

/** Frappe signs the raw body with HMAC-SHA256 and sends it base64. */
function signatureMatches(
  secret: string,
  raw: Buffer,
  provided: string,
): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // Length must be compared first: timingSafeEqual throws on a mismatch, and
  // that throw would itself leak the length through the error path.
  return a.length === b.length && timingSafeEqual(a, b);
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

webhookRoutes.post(
  "/webhooks/frappe/:connectionId",
  route(async (req, res) => {
    // Per connection, not per IP: an ERP behind one office address must not be
    // able to throttle another merchant's.
    const connectionId = req.params.connectionId!;
    const budget = limiters.chat.take(`frappe:${connectionId}`);
    if (!budget.allowed) {
      res.setHeader("Retry-After", String(budget.retryAfter));
      res.status(429).json({ ok: false });
      return;
    }

    const connection = connections.byConnectionId(connectionId);
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const provided = req.header("x-frappe-webhook-signature");

    /*
     * One shape of answer for every way this can fail authentication: unknown
     * connection, wrong provider, no secret set, bad signature. Telling them
     * apart would turn this into an oracle for which connection ids exist.
     */
    const secret =
      connection && connection.providerType === "frappe"
        ? credentialsFor(connection.tenantId, "frappe").webhookSecret
        : undefined;

    if (
      !connection ||
      !secret ||
      !raw ||
      !provided ||
      !signatureMatches(secret, raw, provided)
    ) {
      log.warn("frappe webhook rejected", {
        connectionId,
        signed: Boolean(provided),
      });
      res.status(401).json({ ok: false });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const doctype = asString(body.doctype);
    const itemCode = asString(body.item_code);
    const warehouse = asString(body.warehouse);

    if (doctype !== "Stock Ledger Entry" || !itemCode) {
      res
        .status(202)
        .json({ ok: true, applied: false, reason: "not a stock movement" });
      return;
    }

    const credentials = credentialsFor(connection.tenantId, "frappe");
    const selling = credentials.warehouse?.trim();
    if (selling && warehouse && warehouse !== selling) {
      res
        .status(202)
        .json({ ok: true, applied: false, reason: "another warehouse" });
      return;
    }

    const qty = Number(body.qty_after_transaction);
    if (!Number.isFinite(qty)) {
      res
        .status(202)
        .json({ ok: true, applied: false, reason: "no quantity on the event" });
      return;
    }

    const updated = products.setStockByExternalId(
      connection.tenantId,
      itemCode,
      qty,
    );
    if (!updated) {
      // An item ERPNext knows and Convo does not: it has never been synced, or
      // it is not for sale. The next full sync will pick it up if it should be.
      res
        .status(202)
        .json({ ok: true, applied: false, reason: "no such product here" });
      return;
    }

    audit.record({
      tenantId: connection.tenantId,
      actionType: "catalog.synced",
      outcome: "ok",
      reasoning: "stock moved in ERPNext",
      detail: {
        provider: "frappe",
        source: "webhook",
        item_code: itemCode,
        warehouse,
        stock: updated.stock,
      },
    });

    res.json({ ok: true, applied: true, stock: updated.stock });
  }),
);
