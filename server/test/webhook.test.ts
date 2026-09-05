import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.DATABASE_PATH = `./data/test-webhook-${process.pid}.db`;
process.env.CONVO_SECRET = "test-secret-for-the-webhook-suite-0123456789";

const { db, closeDb } = await import("../src/db/index.js");
const { carts, connections, orders, products, tenants, audit, conversations } =
  await import("../src/db/repo.js");
const { settleOrder, recordPaymentFailure } =
  await import("../src/agent/settle.js");
const { razorpaySignatureMatches } = await import("../src/routes/webhooks.js");

/*
 * Razorpay's webhook is the only thing that can settle an order once the
 * customer has closed their tab — and the only way an AI buyer, which has no
 * tab at all, ever learns a payment went through. So it settles money on a
 * request Convo did not initiate, and every rule the browser path obeys has to
 * hold here too.
 */

let tenantId = "";

before(() => {
  db();
  const tenant = tenants.create({
    name: "Hook Brand",
    slug: `hook-${process.pid}`,
  });
  tenantId = tenant.id;
  connections.upsert({
    tenantId,
    providerType: "manual",
    capabilities: "catalog+payment",
    credentialsEnc: null,
    credentialsHint: null,
  });
  connections.activate(tenantId, "manual", ["catalog", "payment"]);
});

after(() => {
  closeDb();
});

/** An order sitting where a real one sits when the customer opens the widget. */
function awaitingOrder(priceMinor: number, stock = 5) {
  const conversation = conversations.create(`hook-shopper-${Math.random()}`);
  const product = products.create({
    tenantId,
    name: "Hooked good",
    priceMinor,
    stock,
  });
  const cart = carts.ensureOpen(conversation.customerSessionId);
  carts.addItem(cart.id, tenantId, product.id, 1, priceMinor);
  const order = orders.create({
    tenantId,
    cartId: cart.id,
    conversationId: conversation.id,
    checkoutId: `cko-${Math.random().toString(36).slice(2)}`,
    totalAmountMinor: priceMinor,
    currency: "INR",
    providerType: "manual",
    providerOrderId: `order_${Math.random().toString(36).slice(2)}`,
    lineItems: [
      {
        productId: product.id,
        name: "Hooked good",
        quantity: 1,
        unitPriceMinor: priceMinor,
      },
    ],
    status: "awaiting_payment",
  });
  return { order, product, conversation };
}

test("the signature check accepts Razorpay's and refuses everything else", () => {
  const secret = "whsec_example";
  const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
  const signed = createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(razorpaySignatureMatches(secret, body, signed), true);

  // Signed with the wrong secret — what an attacker without it produces.
  const forged = createHmac("sha256", "not-the-secret")
    .update(body)
    .digest("hex");
  assert.equal(razorpaySignatureMatches(secret, body, forged), false);

  // Right signature, different body: the payload changed after signing.
  const tampered = Buffer.from(JSON.stringify({ event: "order.paid" }));
  assert.equal(razorpaySignatureMatches(secret, tampered, signed), false);

  // A wrong length must be refused, not thrown out of timingSafeEqual.
  assert.equal(razorpaySignatureMatches(secret, body, "abc"), false);
  assert.equal(razorpaySignatureMatches(secret, body, ""), false);
});

test("the webhook settles an order the browser never confirmed", () => {
  const { order, product } = awaitingOrder(149_900);

  const result = settleOrder({
    order,
    providerType: "razorpay",
    providerPaymentId: "pay_hook_1",
    capturedAmountMinor: 149_900,
    source: "webhook",
    conversationId: order.conversationId,
  });

  assert.equal(result.outcome, "paid");
  assert.equal(orders.byId(tenantId, order.id)!.status, "paid");
  // Stock leaves on confirmation, exactly as it does on the browser path.
  assert.equal(products.byId(tenantId, product.id)!.stock, 4);

  const entry = audit
    .list(tenantId, 50)
    .find(
      (e) => e.orderId === order.id && e.actionType === "payment.confirmed",
    );
  assert.ok(entry, "a settled payment left no ledger entry");
  assert.equal(
    (entry!.detail as Record<string, unknown>).settled_by,
    "webhook",
    "the ledger does not record which side settled it",
  );
});

test("a second delivery of the same event does not take the stock twice", () => {
  const { order, product } = awaitingOrder(50_000);

  const first = settleOrder({
    order,
    providerType: "razorpay",
    providerPaymentId: "pay_hook_2",
    capturedAmountMinor: 50_000,
    source: "webhook",
    conversationId: order.conversationId,
  });
  assert.equal(first.outcome, "paid");
  const afterFirst = products.byId(tenantId, product.id)!.stock;

  // Razorpay retries. The browser may also confirm the same order at the same
  // moment. Either way the second one through must change nothing.
  const second = settleOrder({
    order: orders.byId(tenantId, order.id)!,
    providerType: "razorpay",
    providerPaymentId: "pay_hook_2",
    capturedAmountMinor: 50_000,
    source: "webhook",
    conversationId: order.conversationId,
  });

  assert.equal(second.outcome, "already_paid");
  assert.equal(
    products.byId(tenantId, product.id)!.stock,
    afterFirst,
    "a replayed webhook reserved the stock a second time",
  );
});

test("a webhook cannot settle an order for the wrong amount", () => {
  const { order, product } = awaitingOrder(120_000);

  const result = settleOrder({
    order,
    providerType: "razorpay",
    providerPaymentId: "pay_hook_3",
    // Razorpay says it took far less than Convo priced.
    capturedAmountMinor: 100,
    source: "webhook",
    conversationId: order.conversationId,
  });

  assert.equal(result.outcome, "amount_mismatch");
  assert.notEqual(
    orders.byId(tenantId, order.id)!.status,
    "paid",
    "an order settled for an amount Convo never priced",
  );
  assert.equal(
    products.byId(tenantId, product.id)!.stock,
    5,
    "stock left the shelf for a payment that did not match",
  );
});

test("a failure from the provider is recorded as the provider's, not the page's", () => {
  const { order } = awaitingOrder(30_000);

  recordPaymentFailure({
    order,
    providerType: "razorpay",
    reason: "Your card was declined by the issuing bank.",
    conversationId: order.conversationId,
  });

  const stored = orders.byId(tenantId, order.id)!;
  assert.equal(stored.status, "failed");
  assert.match(stored.failureReason ?? "", /declined by the issuing bank/);

  const entry = audit
    .list(tenantId, 50)
    .find((e) => e.orderId === order.id && e.actionType === "payment.failed");
  assert.ok(entry);
  assert.equal(
    (entry!.detail as Record<string, unknown>).reported_by,
    "provider_webhook",
    "a provider-reported failure is indistinguishable from a browser-reported one",
  );
});
