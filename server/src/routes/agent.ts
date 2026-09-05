import { Router, type Request } from "express";
import {
  carts,
  conversations,
  orders,
  products,
  provenance,
  tenants,
} from "../db/repo.js";
import { ensureSession } from "../agent/storefront.js";
import {
  cartPayload,
  gatedAddToCart,
  gatedCheckout,
  gatedSetAddress,
} from "../agent/gates.js";
import { priceCart, ConvoStorefront } from "../agent/storefront.js";
import { DEFAULT_AGENT_CONFIG } from "../agent/config.js";
import {
  generateMandateKeypair,
  MandateError,
  signMandate,
  verifyMandate,
  type OpenMandate,
} from "../agent/mandate.js";
import { badRequest, notFound, requireString, route } from "../lib/http.js";
import { limiters } from "../lib/ratelimit.js";
import { RateLimitError } from "../lib/security.js";
import { formatMoney } from "../lib/money.js";
import { log } from "../lib/logger.js";
import { env } from "../env.js";

/**
 * The buyer's side, for an agent rather than a person.
 *
 * Everything the conversational shop does through a chat, an outside agent does
 * here through JSON: find goods across every listed brand, put them in a cart,
 * and check out. What it cannot do is buy on nobody's authority — a checkout
 * needs a mandate a human signed, naming a budget and the brands it may be
 * spent at.
 *
 * The important part is what this route does *not* contain. There is no second
 * checkout in here: it calls the same `gatedCheckout` the shop's own agent
 * calls, so the provenance rule, the stock re-check, the server-side pricing and
 * the split into one order per brand are the identical code. A separate agent
 * path would be a second money path, and the second one always drifts.
 */

export const agentRoutes = Router();

const backend = new ConvoStorefront();

/** The agent's cart, priced by Convo. */
function agentCart(session: Parameters<typeof priceCart>[0]) {
  const cart = carts.ensureOpen(session.customerSessionId);
  return cartPayload(priceCart(session, cart.id));
}
const config = DEFAULT_AGENT_CONFIG;
const CURRENCY = "INR";

/*
 * The demo signing key.
 *
 * In production the private half belongs to the person delegating, and would
 * live on their device or in their wallet — Convo would hold only the public
 * JWK to verify against. For the demo Convo holds both, generated fresh at
 * boot, which means mandates do not survive a restart. That is a deliberate
 * shortcut in *who holds the key*, not in the verification: the code path that
 * checks a mandate below is the real one, and it does not care where the
 * signature came from.
 */
const demoKey = generateMandateKeypair();

/** The mandate's own session token; an agent has no cookies. */
function agentSession(req: Request): string {
  const header = req.header("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!bearer) {
    throw badRequest(
      "Send the session token from POST /v1/agent/mandates as a bearer token.",
      "missing_token",
    );
  }
  return bearer;
}

function positiveInt(body: unknown, field: string, fallback?: number): number {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (value === undefined && fallback !== undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw badRequest(
      `\`${field}\` must be a whole number of paise.`,
      "bad_field",
    );
  }
  return n;
}

/**
 * A human authorises an agent.
 *
 * Returns the signed mandate, the public key to verify it against, and a session
 * token the agent uses for everything else. The brands are checked here rather
 * than at checkout so a mandate can never name a shop that does not exist —
 * an allowlist full of typos would authorise nothing and say nothing about why.
 */
agentRoutes.post(
  "/v1/agent/mandates",
  route(async (req, res) => {
    const agentId = requireString(req.body, "agentId", 120);
    const budgetMinor = positiveInt(req.body, "budgetMinor");
    const perOrderMaxMinor = positiveInt(req.body, "perOrderMaxMinor", 0);
    const ttlSeconds = Math.min(
      positiveInt(req.body, "ttlSeconds", 3600),
      86_400,
    );

    const rawBrands = (req.body as Record<string, unknown>)?.allowedBrandIds;
    if (!Array.isArray(rawBrands) || rawBrands.length === 0) {
      throw badRequest(
        "Name at least one brand the agent may buy from. An empty list authorises nothing.",
        "no_brands",
      );
    }
    const allowedBrandIds = rawBrands.map(String);
    for (const brandId of allowedBrandIds) {
      const tenant = tenants.byId(brandId);
      if (!tenant || !tenant.isListed) {
        throw badRequest(
          `No listed brand with id "${brandId}".`,
          "unknown_brand",
        );
      }
    }

    /*
     * Delegate from the shopper's own session when there is one.
     *
     * A mandate issued in a browser is a person handing their own budget over,
     * so the orders that come out of it have to be theirs: in their order list,
     * on their cart, payable from the panel they already use. Minting a
     * separate session for the agent produced orders nobody could reach — the
     * run said "order placed" and there was no screen that could pay it.
     *
     * An outside agent has no cookie, and still gets a session of its own.
     */
    const cookieSession = req.cookies?.convo_customer as string | undefined;
    const customerSessionId =
      typeof cookieSession === "string" && cookieSession.length > 20
        ? cookieSession
        : `agent-${agentId}-${Date.now().toString(36)}`;
    const conversation = conversations.ensure(customerSessionId);
    const now = Math.floor(Date.now() / 1000);

    const payload: OpenMandate = {
      vct: "mandate.checkout.open.1",
      sub: customerSessionId,
      agent: agentId,
      constraints: {
        budgetMinor,
        perOrderMaxMinor,
        allowedBrandIds,
        currency: CURRENCY,
      },
      iat: now,
      exp: now + ttlSeconds,
    };

    log.info("mandate issued", {
      agentId,
      budgetMinor,
      brands: allowedBrandIds.length,
    });
    res.status(201).json({
      mandate: signMandate(payload, demoKey.privatePem),
      session_token: customerSessionId,
      conversation_id: conversation.id,
      public_key_jwk: demoKey.publicJwk,
      authorised: {
        agent: agentId,
        budget_display: formatMoney(budgetMinor, CURRENCY),
        brands: allowedBrandIds.map((id) => tenants.byId(id)?.name ?? id),
        expires_at: new Date((now + ttlSeconds) * 1000).toISOString(),
      },
    });
  }),
);

/** The shelf, across every listed brand. */
agentRoutes.get(
  "/v1/agent/catalog",
  route(async (req, res) => {
    agentSession(req);
    const query = String(req.query.q ?? "")
      .trim()
      .toLowerCase();
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 50);

    const listed = products.listedAcrossBrands();
    const matched = query
      ? listed.filter((product) =>
          `${product.name} ${product.description ?? ""} ${product.category ?? ""} ${product.brandName}`
            .toLowerCase()
            .includes(query),
        )
      : listed;

    res.json({
      products: matched.slice(0, limit).map((product) => ({
        id: product.id,
        name: product.name,
        brand_id: product.tenantId,
        brand_name: product.brandName,
        price_minor: product.priceMinor,
        price_display: formatMoney(product.priceMinor, CURRENCY),
        currency: CURRENCY,
        in_stock: product.stock > 0,
        stock: product.stock,
        category: product.category,
      })),
      count: matched.length,
    });
  }),
);

/**
 * Put something in the cart.
 *
 * Goes through `gatedAddToCart`, which is where the stock and quantity caps
 * live. The product is recorded as seen first: provenance exists to stop the
 * shop's own model inventing ids, and an outside agent that read the id from
 * the catalogue above has met the same bar honestly.
 */
agentRoutes.post(
  "/v1/agent/cart",
  route(async (req, res) => {
    const customerSessionId = agentSession(req);
    const budget = limiters.chat.take(`agent:${customerSessionId}`);
    if (!budget.allowed) {
      res.setHeader("Retry-After", String(budget.retryAfter));
      throw new RateLimitError(budget.retryAfter);
    }

    const productId = requireString(req.body, "productId", 120);
    const quantity = positiveInt(req.body, "quantity", 1);
    const session = ensureSession(customerSessionId, CURRENCY);

    const product = products.listedById(productId);
    if (!product) throw notFound("No listed product with that id.");
    provenance.remember(session.conversationId, [
      { productId: product.id, tenantId: product.tenantId },
    ]);

    const outcome = await gatedAddToCart({
      backend,
      config,
      session,
      productId,
      quantity: Math.max(1, quantity),
    });

    if (outcome.isError || outcome.heldBy) {
      res.status(409).json({
        ok: false,
        reason: outcome.text,
        gate: outcome.heldBy ?? null,
      });
      return;
    }
    res.json({ ok: true, cart: agentCart(session) });
  }),
);

/** What is in the cart, priced by Convo. */
agentRoutes.get(
  "/v1/agent/cart",
  route(async (req, res) => {
    const session = ensureSession(agentSession(req), CURRENCY);
    res.json({ cart: agentCart(session) });
  }),
);

/**
 * Check out, against a mandate.
 *
 * The mandate is verified here and the verified payload handed to the same
 * `gatedCheckout` a human's conversation uses. Convo prices the cart, splits it
 * per brand, and tests the mandate against its own figures — the agent has no
 * say in the amount it is authorised for.
 */
agentRoutes.post(
  "/v1/agent/checkout",
  route(async (req, res) => {
    const customerSessionId = agentSession(req);
    const token = requireString(req.body, "mandate", 4000);

    let payload: OpenMandate;
    try {
      payload = verifyMandate(token, demoKey.publicJwk);
    } catch (error) {
      if (error instanceof MandateError) {
        throw badRequest(error.message, error.code);
      }
      throw error;
    }

    /*
     * The mandate names whose money it is. An agent holding a valid mandate for
     * one session must not be able to spend it out of another's cart.
     */
    if (payload.sub !== customerSessionId) {
      throw badRequest(
        "That mandate was not issued for this session.",
        "mandate_session_mismatch",
      );
    }

    const session = ensureSession(customerSessionId, CURRENCY);
    const outcome = await gatedCheckout({
      session,
      config,
      reasoning: "agent checkout under a signed mandate",
      mandate: { token, payload },
    });

    const checkout = outcome.components?.find(
      (component) => component.component === "checkout",
    );

    if (outcome.isError || outcome.heldBy || !checkout) {
      res.status(409).json({
        ok: false,
        reason: outcome.text,
        // The gate that stopped it, named — so an agent can act on the reason
        // rather than parse prose written for a person.
        gate: outcome.heldBy ?? null,
      });
      return;
    }

    res.status(201).json({ ok: true, checkout: checkout.payload });
  }),
);

/**
 * Where to send it.
 *
 * No model on this path at all — the agent posts structured fields and the
 * server validates them, so the privacy question that shapes the conversational
 * tool does not arise here. An address is also the one thing an autonomous
 * buyer genuinely cannot do without: an order nobody can deliver is not a
 * purchase.
 */
agentRoutes.post(
  "/v1/agent/address",
  route(async (req, res) => {
    const session = ensureSession(agentSession(req), CURRENCY);
    const outcome = gatedSetAddress({ session, address: req.body });

    if (outcome.isError || outcome.heldBy) {
      res.status(422).json({
        ok: false,
        reason: outcome.text,
        gate: outcome.heldBy ?? null,
      });
      return;
    }
    // Confirmed, not echoed: an agent that posted it already has it.
    res.json({ ok: true, saved: true });
  }),
);

/** Where an agent learns a payment actually settled. */
agentRoutes.get(
  "/v1/agent/orders",
  route(async (req, res) => {
    const customerSessionId = agentSession(req);
    res.json({
      orders: orders.listForCustomer(customerSessionId, 20).map((order) => ({
        order_id: order.id,
        brand_name: tenants.byId(order.tenantId)?.name ?? null,
        checkout_id: order.checkoutId,
        status: order.status,
        total_minor: order.totalAmountMinor,
        total_display: formatMoney(order.totalAmountMinor, order.currency),
        mandate_id: order.mandateId ?? null,
        failure_reason: order.failureReason,
      })),
      // An agent has no browser, so the webhook is what makes these true.
      settlement: `${env.publicBaseUrl}/api/webhooks/razorpay/:connectionId`,
    });
  }),
);
