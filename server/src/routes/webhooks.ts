import { Router, type Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { audit, connections, orders, products } from "../db/repo.js";
import { credentialsFor } from "../commerce/registry.js";
import { recordPaymentFailure, settleOrder } from "../agent/settle.js";
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

/**
 * Razorpay, telling Convo what happened to a payment.
 *
 * Until now the only thing that could settle an order was the customer's own
 * browser handing back a signed result. That works right up to the moment the
 * customer closes the tab — and then the money has moved, the brand has been
 * paid, and Convo's ledger still says `awaiting_payment` forever. It is also
 * the only way an AI buyer can ever learn a payment settled: an agent has no
 * tab to hand anything back from.
 *
 * Per connection, because each brand is paid on its own Razorpay account and
 * so configures its own webhook with its own secret. Razorpay signs the raw
 * body with HMAC-SHA256 and sends it hex in `X-Razorpay-Signature`.
 *
 * The settlement itself is `settleOrder`, the same function the browser path
 * calls — including the check that the captured amount matches what Convo
 * priced. A webhook that took Razorpay's figure on trust would be a way to
 * settle an order for the wrong amount.
 */

/** Razorpay signs the raw body with HMAC-SHA256, hex-encoded. Exported so the
 *  suite exercises this comparison rather than re-implementing it. */
export function razorpaySignatureMatches(
  secret: string,
  raw: Buffer,
  provided: string,
): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

webhookRoutes.post(
  "/webhooks/razorpay/:connectionId",
  route(async (req, res) => {
    const connectionId = req.params.connectionId!;
    const budget = limiters.chat.take(`razorpay:${connectionId}`);
    if (!budget.allowed) {
      res.setHeader("Retry-After", String(budget.retryAfter));
      res.status(429).json({ ok: false });
      return;
    }

    const connection = connections.byConnectionId(connectionId);
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const provided = req.header("x-razorpay-signature");

    const secret =
      connection && connection.providerType === "razorpay"
        ? credentialsFor(connection.tenantId, "razorpay").webhookSecret
        : undefined;

    if (
      !connection ||
      !secret ||
      !raw ||
      !provided ||
      !razorpaySignatureMatches(secret, raw, provided)
    ) {
      log.warn("razorpay webhook rejected", {
        connectionId,
        signed: Boolean(provided),
      });
      res.status(401).json({ ok: false });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const event = asString(body.event);
    const entity = (
      (body.payload as Record<string, unknown> | undefined)?.payment as
        Record<string, unknown> | undefined
    )?.entity as Record<string, unknown> | undefined;

    const providerOrderId = asString(entity?.order_id);
    if (!event || !providerOrderId) {
      res
        .status(202)
        .json({ ok: true, applied: false, reason: "not a payment event" });
      return;
    }

    /*
     * Matched on this brand's own account. The connection proved which tenant
     * signed, so an order id from one brand's Razorpay account can never
     * resolve to another brand's order.
     */
    const order = orders.byProviderOrderId(
      connection.tenantId,
      providerOrderId,
    );
    if (!order) {
      // Not ours — an event for an order Convo did not create. Accepted so the
      // merchant's Razorpay webhook log does not fill with failures.
      res
        .status(202)
        .json({ ok: true, applied: false, reason: "unknown order" });
      return;
    }

    if (event === "payment.captured" || event === "order.paid") {
      const settled = settleOrder({
        order,
        providerType: "razorpay",
        providerPaymentId: asString(entity?.id),
        capturedAmountMinor: asNumber(entity?.amount),
        source: "webhook",
        conversationId: order.conversationId,
      });
      log.info("razorpay webhook settled", {
        orderId: order.id,
        outcome: settled.outcome,
      });
      res.json({
        ok: true,
        applied: settled.outcome === "paid",
        outcome: settled.outcome,
      });
      return;
    }

    if (event === "payment.failed") {
      const description =
        asString((entity?.error_description as unknown) ?? null) ??
        "The payment provider declined it.";
      recordPaymentFailure({
        order,
        providerType: "razorpay",
        reason: description,
        conversationId: order.conversationId,
      });
      res.json({ ok: true, applied: true, outcome: "failed" });
      return;
    }

    res
      .status(202)
      .json({ ok: true, applied: false, reason: "event not handled" });
  }),
);
