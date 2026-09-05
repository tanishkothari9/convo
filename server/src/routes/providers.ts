/**
 * Connecting a commerce provider, and syncing a catalogue from one.
 *
 * Credentials arrive here once, are encrypted immediately, and are never
 * returned: every response carries only a non-secret hint like
 * `rzp_test_••••4f2a`.
 */
import { Router } from "express";
import { audit, connections, products } from "../db/repo.js";
import { requireAuth, type AuthedRequest } from "../auth/index.js";
import { badRequest, notFound, optionalString, route } from "../lib/http.js";
import { credentialHint, encryptJson } from "../lib/crypto.js";
import { token } from "../lib/ids.js";
import { env } from "../env.js";
import { log } from "../lib/logger.js";
import {
  adapterFor,
  credentialsFor,
  listAdapters,
} from "../commerce/registry.js";
import { ProviderApiError, ProviderConfigError } from "../commerce/types.js";
import type { ProviderRole, ProviderType } from "../domain/types.js";

export const providerRoutes = Router();
providerRoutes.use(requireAuth);

const tenantOf = (req: unknown) => (req as AuthedRequest).auth.tenant;

const KNOWN: ProviderType[] = ["manual", "razorpay", "shopify"];

/** The roles a provider can hold, from what its adapter actually supports. */
function rolesFor(providerType: ProviderType): ProviderRole[] {
  const { capabilities } = adapterFor(providerType);
  return [
    ...(capabilities.catalog ? (["catalog"] as const) : []),
    ...(capabilities.payment ? (["payment"] as const) : []),
  ];
}

function readProviderType(value: unknown): ProviderType {
  if (typeof value !== "string" || !KNOWN.includes(value as ProviderType)) {
    throw badRequest(
      "That is not a provider Convo supports.",
      "unknown_provider",
    );
  }
  return value as ProviderType;
}

providerRoutes.get(
  "/providers",
  route(async (req, res) => {
    const tenant = tenantOf(req);
    const saved = connections.listForTenant(tenant.id);
    res.json({
      available: listAdapters().map((adapter) => ({
        type: adapter.type,
        displayName: adapter.displayName,
        capabilities: adapter.capabilities,
      })),
      connections: saved,
      active: connections.active(tenant.id) ?? null,
    });
  }),
);

/** Validates credentials against the provider before saving anything. */
providerRoutes.post(
  "/providers/:providerType/test",
  route(async (req, res) => {
    const providerType = readProviderType(req.params.providerType);
    const adapter = adapterFor(providerType);
    const credentials = readCredentials(providerType, req.body);
    try {
      const result = await adapter.verifyCredentials(credentials);
      res.json({ ok: true, detail: result.detail });
    } catch (error) {
      res.status(400).json({ ok: false, detail: providerMessage(error) });
    }
  }),
);

providerRoutes.post(
  "/providers/:providerType/connect",
  route(async (req, res) => {
    const tenant = tenantOf(req);
    const providerType = readProviderType(req.params.providerType);
    const adapter = adapterFor(providerType);
    const credentials = readCredentials(providerType, req.body);

    try {
      await adapter.verifyCredentials(credentials);
    } catch (error) {
      throw badRequest(providerMessage(error), "provider_rejected");
    }

    /*
     * The webhook secret is Convo's, not the merchant's — it is generated here
     * and shown to them once so they can paste it into their Frappe. Kept
     * across reconnects: rotating it silently would break a webhook they had
     * already set up, and they would have no way to know why stock stopped
     * moving.
     */
    if (providerType === "frappe") {
      const existing = credentialsFor(tenant.id, "frappe").webhookSecret;
      credentials.webhookSecret = existing ?? token();
    }

    const secretish =
      credentials.keyId ?? credentials.shop ?? credentials.siteUrl ?? "";
    connections.upsert({
      tenantId: tenant.id,
      providerType,
      capabilities: `${adapter.capabilities.catalog ? "catalog" : ""}${
        adapter.capabilities.catalog && adapter.capabilities.payment ? "+" : ""
      }${adapter.capabilities.payment ? "payment" : ""}`,
      credentialsEnc:
        Object.keys(credentials).length > 0 ? encryptJson(credentials) : null,
      credentialsHint: secretish ? credentialHint(secretish) : null,
    });
    // A provider takes only the roles its adapter can actually fill, so
    // connecting Shopify does not quietly make it the payment processor.
    connections.activate(tenant.id, providerType, rolesFor(providerType));

    log.info("provider connected", { tenantId: tenant.id, providerType });
    /*
     * The webhook secret goes back exactly here and nowhere else — it is the
     * one time a credential leaves the server, because the merchant has to
     * paste it into their own Frappe and cannot read it out of the ciphertext.
     * Losing it is recoverable: the secret survives a reconnect, so connecting
     * again shows the same pair rather than silently breaking a webhook they
     * already set up.
     */
    const frappeWebhook =
      providerType === "frappe"
        ? {
            url: `${env.publicBaseUrl}/api/webhooks/frappe/${connections.byType(tenant.id, "frappe")?.id}`,
            secret: credentials.webhookSecret,
          }
        : undefined;

    res.status(201).json({
      ...(frappeWebhook ? { webhook: frappeWebhook } : {}),
      connection: connections.byType(tenant.id, providerType),
      active: connections.active(tenant.id),
    });
  }),
);

providerRoutes.post(
  "/providers/:providerType/activate",
  route(async (req, res) => {
    const tenant = tenantOf(req);
    const providerType = readProviderType(req.params.providerType);
    if (!connections.byType(tenant.id, providerType))
      throw notFound("That provider is not connected.");
    connections.activate(tenant.id, providerType, rolesFor(providerType));
    res.json({ active: connections.active(tenant.id) });
  }),
);

providerRoutes.delete(
  "/providers/:providerType",
  route(async (req, res) => {
    const tenant = tenantOf(req);
    const providerType = readProviderType(req.params.providerType);
    connections.remove(tenant.id, providerType);
    // A brand always has somewhere to sell from; fall back to its own catalogue.
    if (!connections.active(tenant.id)) {
      connections.upsert({
        tenantId: tenant.id,
        providerType: "manual",
        capabilities: "catalog+payment",
        credentialsEnc: null,
        credentialsHint: null,
      });
      connections.activate(tenant.id, "manual", ["catalog", "payment"]);
    }
    res.json({ active: connections.active(tenant.id) });
  }),
);

/** Pulls the catalogue from the provider into Convo's tenant-scoped tables. */
providerRoutes.post(
  "/providers/:providerType/sync",
  route(async (req, res) => {
    const tenant = tenantOf(req);
    const providerType = readProviderType(req.params.providerType);
    const adapter = adapterFor(providerType);

    if (!adapter.capabilities.catalog)
      throw badRequest(`${adapter.displayName} has no catalogue to sync.`);
    if (providerType === "manual") {
      throw badRequest(
        "Products added in Convo are already the catalogue; there is nothing to sync.",
      );
    }
    if (!connections.byType(tenant.id, providerType))
      throw notFound("Connect that provider first.");

    connections.setSyncState(tenant.id, providerType, "syncing", null);
    try {
      const items = await adapter.fetchCatalog(
        credentialsFor(tenant.id, providerType),
      );
      const result = products.replaceSynced(tenant.id, providerType, items);
      connections.setSyncState(tenant.id, providerType, "ok", null);
      audit.record({
        tenantId: tenant.id,
        actionType: "catalog.synced",
        outcome: "ok",
        detail: { provider: providerType, ...result, fetched: items.length },
      });
      log.info("catalog synced", {
        tenantId: tenant.id,
        providerType,
        ...result,
      });
      res.json({
        result,
        connection: connections.byType(tenant.id, providerType),
        products: products.list(tenant.id, { includeInactive: true }),
      });
    } catch (error) {
      const message = providerMessage(error);
      connections.setSyncState(tenant.id, providerType, "error", message);
      audit.record({
        tenantId: tenant.id,
        actionType: "catalog.synced",
        outcome: "failed",
        detail: { provider: providerType, reason: message },
      });
      throw badRequest(message, "sync_failed");
    }
  }),
);

function readCredentials(
  providerType: ProviderType,
  body: unknown,
): Record<string, string> {
  if (providerType === "razorpay") {
    const keyId = optionalString(body, "keyId", 120);
    const keySecret = optionalString(body, "keySecret", 200);
    // Both blank is valid: it selects Convo's built-in Razorpay test sandbox.
    if (keyId && !keySecret)
      throw badRequest("A key id needs its key secret too.", "missing_secret");
    if (keySecret && !keyId)
      throw badRequest("A key secret needs its key id too.", "missing_key_id");
    return { ...(keyId ? { keyId } : {}), ...(keySecret ? { keySecret } : {}) };
  }

  if (providerType === "shopify") {
    const shop = optionalString(body, "shop", 120);
    const accessToken = optionalString(body, "accessToken", 200);
    if (!shop)
      throw badRequest("Enter your Shopify store name.", "missing_shop");
    if (!accessToken)
      throw badRequest(
        "Enter a Shopify Admin API access token.",
        "missing_token",
      );
    return { shop, accessToken };
  }

  if (providerType === "frappe") {
    const siteUrl = optionalString(body, "siteUrl", 300);
    const apiKey = optionalString(body, "apiKey", 200);
    const apiSecret = optionalString(body, "apiSecret", 200);
    const warehouse = optionalString(body, "warehouse", 200);
    const priceList = optionalString(body, "priceList", 200);
    if (!siteUrl)
      throw badRequest("Enter your ERPNext site URL.", "missing_site");
    if (!apiKey || !apiSecret)
      throw badRequest("Enter an API key and its secret.", "missing_key");
    if (!warehouse)
      throw badRequest(
        "Name the warehouse you sell from.",
        "missing_warehouse",
      );
    if (!priceList)
      throw badRequest("Name the price list to sell at.", "missing_price_list");
    return { siteUrl, apiKey, apiSecret, warehouse, priceList };
  }

  return {};
}

function providerMessage(error: unknown): string {
  if (error instanceof ProviderConfigError || error instanceof ProviderApiError)
    return error.message;
  return "Convo could not reach that provider.";
}
