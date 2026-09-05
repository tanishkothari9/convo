import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkMandate,
  generateMandateKeypair,
  MandateError,
  mandateId,
  signMandate,
  verifyMandate,
  type OpenMandate,
} from "../src/agent/mandate.js";

/*
 * A mandate is the only thing an outside agent contributes to a checkout, so it
 * is the whole trust boundary for the AI-buyer path. Everything it is checked
 * against — the brand ids, the totals — is Convo's own.
 */

const now = () => Math.floor(Date.now() / 1000);

function open(overrides: Partial<OpenMandate> = {}): OpenMandate {
  return {
    vct: "mandate.checkout.open.1",
    sub: "cust-session-1",
    agent: "agent-alpha",
    constraints: {
      budgetMinor: 1_000_000,
      perOrderMaxMinor: 0,
      allowedBrandIds: ["brand-a", "brand-b"],
      currency: "INR",
    },
    iat: now() - 10,
    exp: now() + 3600,
    ...overrides,
  };
}

test("a mandate signed by the holder verifies, and a forged one does not", () => {
  const keys = generateMandateKeypair();
  const other = generateMandateKeypair();
  const token = signMandate(open(), keys.privatePem);

  const payload = verifyMandate(token, keys.publicJwk);
  assert.equal(payload.agent, "agent-alpha");

  // Signed by a different key: the shape an agent that was never authorised
  // produces.
  assert.throws(
    () => verifyMandate(token, other.publicJwk),
    (error: MandateError) => error.code === "bad_signature",
  );
});

test("the payload cannot be edited after signing", () => {
  const keys = generateMandateKeypair();
  const token = signMandate(open(), keys.privatePem);
  const [header, , signature] = token.split(".") as [string, string, string];

  // Raise the budget a hundredfold and keep the original signature.
  const greedy = open();
  greedy.constraints.budgetMinor = 100_000_000;
  const swapped = `${header}.${Buffer.from(JSON.stringify(greedy)).toString("base64url")}.${signature}`;

  assert.throws(
    () => verifyMandate(swapped, keys.publicJwk),
    (error: MandateError) => error.code === "bad_signature",
  );
});

test("the algorithm is pinned, so `alg: none` is not a way in", () => {
  const keys = generateMandateKeypair();
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "mandate+jwt" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(open())).toString("base64url");

  assert.throws(
    () => verifyMandate(`${header}.${payload}.`, keys.publicJwk),
    (error: MandateError) => error.code === "bad_alg",
    "an unsigned mandate was accepted",
  );
});

test("an expired mandate is refused even though it verifies", () => {
  const keys = generateMandateKeypair();
  const token = signMandate(
    open({ iat: now() - 7200, exp: now() - 60 }),
    keys.privatePem,
  );

  assert.throws(
    () => verifyMandate(token, keys.publicJwk),
    (error: MandateError) => error.code === "expired",
  );
});

test("a cart spanning an unauthorised brand fails on that brand", () => {
  const result = checkMandate({
    mandate: open(),
    perBrandMinor: [
      { tenantId: "brand-a", amountMinor: 120_000 },
      { tenantId: "brand-zzz", amountMinor: 40_000 },
    ],
    currency: "INR",
    spentMinor: 0,
  });

  assert.equal(result.passed, false);
  const violation = result.violations.find(
    (v) => v.reason === "merchant_not_allowed",
  );
  assert.ok(violation, "an unauthorised brand passed");
  assert.equal(
    (violation!.detail as { tenantId: string }).tenantId,
    "brand-zzz",
  );
});

test("a cart across two authorised brands passes as one budget", () => {
  const result = checkMandate({
    mandate: open(),
    perBrandMinor: [
      { tenantId: "brand-a", amountMinor: 300_000 },
      { tenantId: "brand-b", amountMinor: 200_000 },
    ],
    currency: "INR",
    spentMinor: 0,
  });

  assert.equal(
    result.passed,
    true,
    result.violations.map((v) => v.reason).join(", "),
  );
  assert.equal(result.totalMinor, 500_000);
  assert.equal(result.remainingMinor, 500_000);
});

test("the budget counts the whole cart, not each brand separately", () => {
  // Neither brand alone exceeds ₹10,000; together they do. Checking per brand
  // would let an agent spend the budget once per merchant.
  const result = checkMandate({
    mandate: open({
      constraints: {
        budgetMinor: 1_000_000,
        perOrderMaxMinor: 0,
        allowedBrandIds: ["brand-a", "brand-b"],
        currency: "INR",
      },
    }),
    perBrandMinor: [
      { tenantId: "brand-a", amountMinor: 600_000 },
      { tenantId: "brand-b", amountMinor: 600_000 },
    ],
    currency: "INR",
    spentMinor: 0,
  });

  assert.equal(result.passed, false);
  assert.ok(result.violations.some((v) => v.reason === "budget_exceeded"));
});

test("spend already made under the mandate counts against it", () => {
  const result = checkMandate({
    mandate: open(),
    perBrandMinor: [{ tenantId: "brand-a", amountMinor: 500_000 }],
    currency: "INR",
    spentMinor: 800_000,
  });

  assert.equal(result.passed, false);
  const violation = result.violations.find(
    (v) => v.reason === "budget_exceeded",
  );
  assert.equal(
    (violation!.detail as { remaining_minor: number }).remaining_minor,
    200_000,
  );
});

test("an empty allowlist authorises nothing, rather than everything", () => {
  const result = checkMandate({
    mandate: open({
      constraints: {
        budgetMinor: 1_000_000,
        perOrderMaxMinor: 0,
        allowedBrandIds: [],
        currency: "INR",
      },
    }),
    perBrandMinor: [{ tenantId: "brand-a", amountMinor: 1000 }],
    currency: "INR",
    spentMinor: 0,
  });

  assert.equal(
    result.passed,
    false,
    "an empty allowlist behaved as a wildcard",
  );
});

test("the same mandate always tallies against the same id", () => {
  const keys = generateMandateKeypair();
  const token = signMandate(open(), keys.privatePem);
  assert.equal(mandateId(token), mandateId(token));
  assert.notEqual(
    mandateId(token),
    mandateId(signMandate(open({ agent: "b" }), keys.privatePem)),
  );
});
