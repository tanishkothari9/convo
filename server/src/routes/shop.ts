/**
 * The public shop: everything a customer's browser talks to.
 *
 * One surface for every brand. No authentication — a customer is anonymous.
 * Identity is the unguessable customer session id in an httpOnly cookie,
 * minted here and never accepted from a request body, so one customer's
 * conversation, cart, and orders are not reachable from another's.
 *
 * Order routes take an order id and prove ownership with the conversation, not
 * with a brand: a shopper does not know which brand an order belongs to, and a
 * cart spanning two brands produces two orders they are equally entitled to.
 */
import { Router, type Request, type Response } from "express";
import {
  burnPasswordWork,
  passwordFields,
  passwordMatches,
} from "../auth/index.js";
import {
  audit,
  carts,
  conversations,
  messages as messageStore,
  orders,
  products,
  shoppers,
  tenants,
} from "../db/repo.js";
import {
  badRequest,
  notFound,
  optionalString,
  requireString,
  route,
} from "../lib/http.js";
import { limiters } from "../lib/ratelimit.js";
import { RateLimitError } from "../lib/security.js";
import { token } from "../lib/ids.js";
import { formatMoney } from "../lib/money.js";
import { env } from "../env.js";
import { log } from "../lib/logger.js";
import { runTurn, type TurnEvent } from "../agent/loop.js";
import { ensureSession, priceCart } from "../agent/storefront.js";
import { cartPayload, gatedConfirmPayment } from "../agent/gates.js";
import { mockRazorpay } from "../commerce/razorpay/mock.js";
import { signManualPayment } from "../commerce/manual.js";
import { resolveProvider } from "../commerce/registry.js";
import { AddressError, readAddress } from "../domain/address.js";
import type { Order, Product } from "../domain/types.js";

export const shopRoutes = Router();

const CUSTOMER_COOKIE = "convo_customer";

/** The shop's settlement currency. One marketplace, one currency, for now. */
const CURRENCY = "INR";

/** Point this browser at a customer session. Signing in and out both do this. */
function setCustomerCookie(res: Response, customerSessionId: string): void {
  res.cookie(CUSTOMER_COOKIE, customerSessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: 30 * 86_400_000,
    path: "/",
  });
}

/** The customer's session id, minted on first contact. */
function customerSession(req: Request, res: Response): string {
  const existing = req.cookies?.[CUSTOMER_COOKIE];
  if (typeof existing === "string" && existing.length >= 20) return existing;
  const fresh = token();
  setCustomerCookie(res, fresh);
  return fresh;
}

/**
 * The session for a request, in the chat it names.
 *
 * The conversation id is the only thing a client sends that points at stored
 * data, so it is proven against the cookie here rather than trusted. Unknown or
 * someone else's is a 404, not a silent fallback to a different chat — writing
 * a shopper's message into a thread they did not name would be worse than an
 * error. An archived chat still resolves: a second tab open on one the shopper
 * just tidied away should keep working rather than break.
 */
function shopperSession(req: Request, res: Response, conversationId?: unknown) {
  const customerSessionId = customerSession(req, res);
  if (typeof conversationId !== "string" || conversationId === "") {
    return ensureSession(customerSessionId, CURRENCY);
  }
  const conversation = conversations.owned(customerSessionId, conversationId);
  if (!conversation) throw notFound("No such chat.");
  conversations.touch(conversation.id);
  return ensureSession(customerSessionId, CURRENCY, conversation.id);
}

/** What the chat list shows for one thread. */
function chatSummary(conversation: {
  id: string;
  title: string | null;
  startedAt: string;
  lastActiveAt: string;
}) {
  return {
    id: conversation.id,
    title: conversation.title,
    started_at: conversation.startedAt,
    last_active_at: conversation.lastActiveAt,
  };
}

/**
 * The provider's reason for a decline, if the page sent one.
 *
 * Bounded on the way in: this is text from the customer's browser that will be
 * written into a brand's ledger, so it is length-capped and stripped of control
 * characters, and it never becomes anything but a string in a detail field.
 */
function declineReason(body: unknown): string | null {
  const value = (body as Record<string, unknown> | null)?.declineReason;
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (clean === "") return null;
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/** An order belonging to this shopper — from any of their chats — or a 404. */
function ownOrder(customerSessionId: string, orderId: string): Order {
  const order = orders.forCustomer(customerSessionId, orderId);
  if (!order) throw notFound("No such order.");
  return order;
}

/** The shop's front: what is on the shelf and who is selling it. */
shopRoutes.get(
  "/shop",
  route(async (_req, res) => {
    const catalog = products.listedAcrossBrands();
    const brands = [...new Set(catalog.map((p) => p.brandName))];
    res.json({
      shop: { name: "Convo", currency: CURRENCY },
      brands,
      brandCount: brands.length,
      catalogSize: catalog.length,
      categories: [
        ...new Set(catalog.map((p) => p.category).filter(Boolean)),
      ].slice(0, 8),
      openers: openers(catalog.length, brands.length),
      showcase: showcase(catalog),
    });
  }),
);

/** Every chat this shopper has open, most recently used first. */
shopRoutes.get(
  "/shop/conversations",
  route(async (req, res) => {
    const customerSessionId = customerSession(req, res);
    res.json({
      conversations: conversations.list(customerSessionId).map(chatSummary),
    });
  }),
);

/**
 * A new chat.
 *
 * Only the transcript is new. The cart and the orders belong to the shopper and
 * carry straight over — starting a fresh chat is not a way to lose your basket.
 * What does not carry over is provenance: the new thread has been shown nothing,
 * so the agent has to find a product again before it can put it in the cart.
 */
shopRoutes.post(
  "/shop/conversations",
  route(async (req, res) => {
    const customerSessionId = customerSession(req, res);
    const conversation = conversations.create(customerSessionId);
    res.status(201).json(chatSummary(conversation));
  }),
);

/**
 * Hide a chat.
 *
 * Archived, never deleted. Orders record the conversation they were placed in,
 * and the audit trail reads through it — a paid order must not become
 * unexplainable because somebody tidied their sidebar.
 */
shopRoutes.delete(
  "/shop/conversations/:conversationId",
  route(async (req, res) => {
    const customerSessionId = customerSession(req, res);
    if (!conversations.archive(customerSessionId, req.params.conversationId!)) {
      throw notFound("No such chat.");
    }
    // Never leave the shopper with nothing to type into.
    const remaining = conversations.list(customerSessionId);
    const next = remaining[0] ?? conversations.create(customerSessionId);
    res.json({
      conversations: (remaining.length ? remaining : [next]).map(chatSummary),
    });
  }),
);

/** The transcript so far, so a reload keeps the conversation. */
shopRoutes.get(
  "/shop/history",
  route(async (req, res) => {
    const session = shopperSession(req, res, req.query.conversationId);
    const cart = carts.ensureOpen(session.customerSessionId);

    res.json({
      conversationId: session.conversationId,
      conversations: conversations
        .list(session.customerSessionId)
        .map(chatSummary),
      messages: messageStore.list(session.conversationId).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        components: message.ui ?? [],
        createdAt: message.createdAt,
      })),
      cart: cartPayload(priceCart(session, cart.id)),
    });
  }),
);

/** One turn, streamed as server-sent events. */
shopRoutes.post(
  "/shop/message",
  route(async (req, res) => {
    const message = requireString(req.body, "message", 2000);
    // Resolved before the stream opens, so an unknown chat is still a clean
    // 404 rather than an error event inside a 200.
    const session = shopperSession(
      req,
      res,
      (req.body as Record<string, unknown>)?.conversationId,
    );
    const customerSessionId = session.customerSessionId;

    /*
     * Every request here runs a model turn, so this is the endpoint that costs
     * real money. It is limited per customer session rather than per IP:
     * customers can share an address behind carrier NAT, and throttling them
     * as one would break the product for a whole city.
     */
    const budget = limiters.chat.take(customerSessionId);
    if (!budget.allowed) {
      res.setHeader("Retry-After", String(budget.retryAfter));
      throw new RateLimitError(budget.retryAfter);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: TurnEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // The client going away, not the request body finishing. `req`'s close
    // fires as soon as the body is fully received, which is immediately.
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    try {
      for await (const event of runTurn({
        customerSessionId,
        conversationId: session.conversationId,
        message,
        currency: CURRENCY,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        send(event);
      }
    } catch (error) {
      log.error("chat stream failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
      send({
        type: "error",
        message: "Something went wrong. Try again in a moment.",
      });
    } finally {
      res.end();
    }
  }),
);

/** The cart, for the panel the chat page keeps in sync. */
shopRoutes.get(
  "/shop/cart",
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY);
    const cart = carts.ensureOpen(session.customerSessionId);
    res.json({ cart: cartPayload(priceCart(session, cart.id)) });
  }),
);

/*
 * Shopper accounts.
 *
 * A shopper is an anonymous customer session until they make one. Signing in
 * points their cookie at the account's own session, so the cart, the chats and
 * the orders that belong to that account come with them — and everything
 * downstream keeps working, because it was all keyed on the session already.
 *
 * Signing in abandons whatever was in the anonymous cart rather than merging
 * it. Merging two carts silently is how someone ends up paying for something
 * they put in the basket on a shared laptop last week.
 */
shopRoutes.post(
  "/shop/account/signup",
  route(async (req, res) => {
    const email = requireString(req.body, "email", 200).toLowerCase();
    const password = requireString(req.body, "password", 200);
    if (password.length < 8) {
      throw badRequest("Use at least 8 characters.", "weak_password");
    }
    if (shoppers.credentialsByEmail(email)) {
      throw badRequest("That email already has an account.", "email_taken");
    }
    const { hash, salt } = passwordFields(password);
    const shopper = shoppers.create({
      email,
      passwordHash: hash,
      passwordSalt: salt,
      displayName: optionalString(req.body, "name", 120),
    });
    setCustomerCookie(res, shopper.customerSessionId);
    res.status(201).json({ shopper: { email: shopper.email, name: null } });
  }),
);

shopRoutes.post(
  "/shop/account/login",
  route(async (req, res) => {
    const email = requireString(req.body, "email", 200).toLowerCase();
    const password = requireString(req.body, "password", 200);

    const credentials = shoppers.credentialsByEmail(email);
    // Same message and the same amount of work either way, so neither the
    // wording nor the timing says whether the account exists.
    if (!credentials) {
      burnPasswordWork(password);
      throw badRequest("That email and password do not match.", "bad_login");
    }
    if (!passwordMatches(password, credentials.hash, credentials.salt)) {
      throw badRequest("That email and password do not match.", "bad_login");
    }

    setCustomerCookie(res, credentials.customerSessionId);
    const shopper = shoppers.bySession(credentials.customerSessionId);
    res.json({
      shopper: { email: shopper?.email, name: shopper?.displayName ?? null },
    });
  }),
);

/** Back to being anonymous. The account keeps everything it owns. */
shopRoutes.post(
  "/shop/account/logout",
  route(async (_req, res) => {
    setCustomerCookie(res, token());
    res.json({ ok: true });
  }),
);

/** Who is shopping, if anyone signed in. */
shopRoutes.get(
  "/shop/account",
  route(async (req, res) => {
    const shopper = shoppers.bySession(customerSession(req, res));
    res.json({
      shopper: shopper
        ? { email: shopper.email, name: shopper.displayName }
        : null,
    });
  }),
);

/** Everything this shopper has bought, newest first. */
shopRoutes.get(
  "/shop/orders",
  route(async (req, res) => {
    const customerSessionId = customerSession(req, res);
    res.json({
      orders: orders.listForCustomer(customerSessionId, 50).map((order) => ({
        order_id: order.id,
        brand_name: tenants.byId(order.tenantId)?.name ?? null,
        checkout_id: order.checkoutId,
        status: order.status,
        total_display: formatMoney(order.totalAmountMinor, order.currency),
        placed_at: order.createdAt,
        line_items: order.lineItems.map((line) => ({
          name: line.name,
          quantity: line.quantity,
        })),
        failure_reason: order.failureReason,
        by_agent: Boolean(order.mandateId),
      })),
    });
  }),
);

/**
 * Change the cart from the cart, not by asking the agent to.
 *
 * Removing a line used to post "Remove X from my cart" into the chat, which
 * spent a model turn, put a sentence in the transcript nobody wrote, and left
 * the drawer showing the old contents until the reply came back. A button on a
 * line should change that line.
 *
 * It goes through the same repository call the agent's own cart tool uses, so
 * the caps and the cart lock still apply, and a locked cart is refused here
 * exactly as it is there.
 */
shopRoutes.post(
  "/shop/cart/remove",
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY);
    const productId = requireString(req.body, "productId", 120);
    const cart = carts.ensureOpen(session.customerSessionId);

    if (cart.status !== "open") {
      throw badRequest(
        "This cart is being paid for and cannot be changed.",
        "cart_locked",
      );
    }
    carts.removeItem(cart.id, productId);
    res.json({ cart: cartPayload(priceCart(session, cart.id)) });
  }),
);

// ── payment ─────────────────────────────────────────────────────────────────

/**
 * Confirms a payment.
 *
 * The body carries whatever the provider's checkout handed back. Verification
 * is server-side against the order id Convo holds; nothing here trusts a
 * status the client reports.
 */
shopRoutes.post(
  "/shop/orders/:orderId/confirm",
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY);
    const orderId = req.params.orderId!;

    const outcome = await gatedConfirmPayment({
      session,
      orderId,
      payload: (req.body ?? {}) as Record<string, unknown>,
      reasoning: "customer completed the provider checkout",
    });

    const order = orders.forCustomer(session.customerSessionId, orderId);
    res.json({
      status: order?.status ?? "failed",
      failureReason: order?.failureReason ?? null,
      components: outcome.components,
      // What is still owed in the same checkout, so a split card can move
      // straight on to the next brand without a round trip.
      checkout: order
        ? checkoutState(session.customerSessionId, order.checkoutId)
        : null,
      cart: cartPayload(
        priceCart(session, carts.ensureOpen(session.customerSessionId).id),
      ),
    });
  }),
);

/**
 * Where the order is going.
 *
 * A form rather than the conversation: a model parsing a free-text address into
 * structured fields gets it subtly wrong in ways nobody notices until a parcel
 * is lost, and this keeps a customer's home address out of the model's context
 * and out of the stored transcript.
 *
 * One submission covers every brand in the checkout. A shopper has one
 * doorstep however many labels they bought from, and asking twice for the same
 * address would be a worse bug than the one the form exists to prevent.
 */
shopRoutes.post(
  "/shop/orders/:orderId/address",
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY);
    const order = ownOrder(session.customerSessionId, req.params.orderId!);

    if (order.status === "paid") {
      throw badRequest(
        "This order is already paid; its address cannot be changed.",
        "already_paid",
      );
    }
    if (order.status === "cancelled") {
      throw badRequest(
        "This order was replaced by a newer one.",
        "order_cancelled",
      );
    }

    let address;
    try {
      address = readAddress(req.body);
    } catch (error) {
      if (error instanceof AddressError) {
        res.status(400).json({
          error: error.message,
          code: "invalid_address",
          field: error.field,
        });
        return;
      }
      throw error;
    }

    for (const sibling of orders.byCheckout(
      session.customerSessionId,
      order.checkoutId,
    )) {
      if (sibling.status === "paid" || sibling.status === "cancelled") continue;
      if (!tenants.byId(sibling.tenantId)?.requiresShipping) continue;
      orders.setShippingAddress(sibling.tenantId, sibling.id, address);
    }
    res.json({
      address,
      checkout: checkoutState(session.customerSessionId, order.checkoutId),
    });
  }),
);

/**
 * The customer cancelled at the payment panel. Nothing was charged.
 *
 * Cancels every unpaid order in the checkout, not just the one whose panel was
 * closed: backing out of a two-brand purchase halfway is not a state anyone
 * asked for.
 */
shopRoutes.post(
  "/shop/orders/:orderId/cancel",
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY);
    const order = ownOrder(session.customerSessionId, req.params.orderId!);
    const siblings = orders.byCheckout(
      session.customerSessionId,
      order.checkoutId,
    );

    /*
     * Why a declined card arrives at the endpoint called "cancel".
     *
     * Razorpay's widget reports a decline through a `payment.failed` event and
     * then closes, which is indistinguishable from the customer walking away
     * unless the page says which happened. It does now, and the difference has
     * to survive into the ledger: a brand reading its audit trail cannot tell a
     * failing card from a change of mind if both say "closed the panel", and
     * those two facts call for completely different responses.
     *
     * The text is the provider's own, relayed by the customer's browser, so it
     * is recorded as reported rather than as verified — nothing on this side
     * has confirmed it. Only the order actually being paid carries it; the
     * siblings were cancelled alongside and nobody declined those.
     */
    const declined = declineReason(req.body);

    for (const sibling of siblings) {
      if (sibling.status !== "awaiting_payment" && sibling.status !== "created")
        continue;
      const isDeclined = declined !== null && sibling.id === order.id;
      orders.setStatus(sibling.tenantId, sibling.id, "cancelled", {
        failureReason: isDeclined
          ? `Declined at the payment panel: ${declined}`
          : "The customer closed the payment panel.",
      });
      audit.record({
        tenantId: sibling.tenantId,
        conversationId: session.conversationId,
        cartId: sibling.cartId,
        orderId: sibling.id,
        actionType: "payment.failed",
        amountMinor: sibling.totalAmountMinor,
        currency: sibling.currency,
        outcome: "failed",
        reasoning: isDeclined
          ? "the payment provider declined it at the panel"
          : "customer cancelled at the payment panel",
        detail: isDeclined
          ? {
              provider: sibling.providerType,
              reason: "declined by the payment provider",
              provider_reason: declined,
              reported_by: "checkout_widget",
            }
          : {
              provider: sibling.providerType,
              reason: "cancelled by customer",
            },
      });
    }

    // Hand the cart back only if nothing in this checkout was paid for.
    if (!siblings.some((sibling) => sibling.status === "paid")) {
      carts.setStatus(order.cartId, "open");
    }
    res.json({
      status: "cancelled",
      checkout: checkoutState(session.customerSessionId, order.checkoutId),
    });
  }),
);

/**
 * Convo's own test checkout panel.
 *
 * Stands in for the provider's hosted widget when a brand is on the mock
 * Razorpay sandbox or the manual provider. It produces exactly the fields the
 * real widget returns, signed with the same HMAC construction, so the
 * verification the server then runs is the production path.
 */
shopRoutes.post(
  "/shop/orders/:orderId/test-pay",
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY);
    const order = ownOrder(session.customerSessionId, req.params.orderId!);
    if (!order.providerOrderId)
      throw badRequest("That order has no payment to complete.");

    const outcome = req.body?.outcome === "failure" ? "failure" : "success";
    const { providerType } = resolveProvider(order.tenantId);

    if (providerType === "razorpay") {
      const settled = mockRazorpay.settle(order.providerOrderId, outcome);
      if ("failure" in settled) {
        res.json({
          ok: false,
          payload: { razorpay_order_id: order.providerOrderId },
        });
        return;
      }
      res.json({
        ok: true,
        payload: {
          razorpay_order_id: order.providerOrderId,
          razorpay_payment_id: settled.paymentId,
          razorpay_signature: settled.signature,
        },
      });
      return;
    }

    if (outcome === "failure") {
      res.json({ ok: false, payload: { order_id: order.providerOrderId } });
      return;
    }
    const paymentId = `cvpay_${token().slice(0, 20)}`;
    res.json({
      ok: true,
      payload: {
        order_id: order.providerOrderId,
        payment_id: paymentId,
        signature: signManualPayment(order.providerOrderId, paymentId),
      },
    });
  }),
);

/** One order, for the confirmation card after a reload. */
shopRoutes.get(
  "/shop/orders/:orderId",
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY);
    const order = ownOrder(session.customerSessionId, req.params.orderId!);
    res.json({
      order: {
        id: order.id,
        status: order.status,
        brand_name: tenants.byId(order.tenantId)?.name ?? null,
        total_display: formatMoney(order.totalAmountMinor, order.currency),
        failureReason: order.failureReason,
        shippingAddress: order.shippingAddress,
        lines: order.lineItems,
      },
    });
  }),
);

/**
 * Every order in one checkout.
 *
 * The split card asks for this before offering a pay button, so a stale card
 * further up the transcript cannot charge for something already settled.
 */
shopRoutes.get(
  "/shop/checkouts/:checkoutId",
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY);
    const state = checkoutState(
      session.customerSessionId,
      req.params.checkoutId!,
    );
    if (state.orders.length === 0) throw notFound("No such checkout.");
    res.json(state);
  }),
);

function checkoutState(customerSessionId: string, checkoutId: string) {
  const group = orders.byCheckout(customerSessionId, checkoutId);
  return {
    checkout_id: checkoutId,
    orders: group.map((order) => ({
      order_id: order.id,
      brand_name: tenants.byId(order.tenantId)?.name ?? null,
      status: order.status,
      total_display: formatMoney(order.totalAmountMinor, order.currency),
      failure_reason: order.failureReason,
      shipping_address: order.shippingAddress,
    })),
    paid: group.filter((order) => order.status === "paid").length,
    remaining: group.filter(
      (order) =>
        order.status === "awaiting_payment" || order.status === "created",
    ).length,
  };
}

function openers(catalogSize: number, brandCount: number): string[] {
  if (catalogSize === 0) return ["What can I buy here?"];
  const base = ["Show me what you have", "Something under ₹5,000"];
  return brandCount > 1
    ? [...base, "Which brands are here?"]
    : [...base, "What is popular right now"];
}

/**
 * The products the shop drifts across its opening screen.
 *
 * Photographed and in stock only — an empty tile or a sold-out item is a worse
 * first impression than a shorter row. Spread across brands and categories, so
 * the marquee shows who is here rather than twelve variations of one thing
 * from whoever happened to upload last.
 */
function showcase(catalog: (Product & { brandName: string })[]) {
  const eligible = catalog.filter((p) => p.images.length > 0 && p.stock > 0);

  const buckets = new Map<string, typeof eligible>();
  for (const product of eligible) {
    const key = `${product.tenantId} ${product.category ?? ""}`;
    buckets.set(key, [...(buckets.get(key) ?? []), product]);
  }

  // Deal the buckets out one brand at a time, so the opening row is a fair
  // sample of the shelf rather than everything from whoever has the most
  // categories followed by everything from whoever has fewer.
  const lanes = new Map<string, (typeof eligible)[]>();
  for (const [key, bucket] of buckets) {
    const brand = key.split(" ")[0]!;
    lanes.set(brand, [...(lanes.get(brand) ?? []), bucket]);
  }
  const lists: (typeof eligible)[] = [];
  for (let round = 0; ; round += 1) {
    let added = false;
    for (const lane of lanes.values()) {
      const bucket = lane[round];
      if (!bucket) continue;
      lists.push(bucket);
      added = true;
    }
    if (!added) break;
  }

  const spread: typeof eligible = [];
  for (let round = 0; spread.length < 12; round += 1) {
    let added = false;
    for (const bucket of lists) {
      const product = bucket[round];
      if (!product) continue;
      spread.push(product);
      added = true;
      if (spread.length === 12) break;
    }
    if (!added) break;
  }

  return spread.map((product) => ({
    id: product.id,
    name: product.name,
    brand_name: product.brandName,
    price_display: formatMoney(product.priceMinor, CURRENCY),
    image_url: product.images[0] ?? null,
    in_stock: product.stock > 0,
  }));
}
