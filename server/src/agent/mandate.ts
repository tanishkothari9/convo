import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/**
 * Mandates: how a human authorises an agent to spend on their behalf.
 *
 * The shape follows Google's AP2 model, which is the one the agentic-payments
 * work has converged on. A person signs an **open mandate** once — a budget, the
 * brands it may be spent at, a per-order ceiling, an expiry. The agent then
 * presents a **closed mandate** for one specific basket, and Convo checks that
 * basket against the open mandate's constraints before anything is charged.
 *
 * Why this is not the same as the gates. A mandate answers "is this agent
 * allowed to spend this person's money here?" — delegated authority. The gates
 * answer "is this the right amount for what is actually in the cart?" — which
 * Convo computes itself and no mandate can influence. Both have to pass. A
 * mandate saying "up to ₹5,000 at Kalaa Studio" does not let an agent decide the
 * basket costs ₹5,000; the server still prices it from live catalogue rows.
 *
 * ES256 (P-256, SHA-256), signed as a compact JWS. Chosen because it is what
 * AP2 specifies, and because the public half is a JWK small enough to hand a
 * merchant to pin.
 */

export class MandateError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface MandateConstraints {
  /** Total the agent may spend under this mandate, in minor units. */
  budgetMinor: number;
  /** Most any single checkout may come to. Zero means no separate ceiling. */
  perOrderMaxMinor: number;
  /** Brand ids the agent may buy from. Empty means none — never "any". */
  allowedBrandIds: string[];
  currency: string;
}

export interface OpenMandate {
  /** Verifiable-credential type, as AP2 names them. */
  vct: "mandate.checkout.open.1";
  /** Who authorised it — the shopper's customer session. */
  sub: string;
  /** The agent this authority was delegated to. */
  agent: string;
  constraints: MandateConstraints;
  iat: number;
  exp: number;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/** A P-256 keypair, PEM private and JWK public. */
export function generateMandateKeypair(): {
  privatePem: string;
  publicJwk: Record<string, string>;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicJwk: { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! },
  };
}

/** Signs a mandate as a compact ES256 JWS. */
export function signMandate(payload: OpenMandate, privatePem: string): string {
  const header = { alg: "ES256", typ: "mandate+jwt", vct: payload.vct };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign(
    null,
    Buffer.from(signingInput),
    // `ieee-p1363` is the raw r||s encoding JWS wants; the default is DER,
    // which every other JWS library would then refuse.
    { key: createPrivateKey(privatePem), dsaEncoding: "ieee-p1363" },
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Verifies the signature and returns the payload.
 *
 * Everything here is refused rather than repaired. A mandate that does not
 * verify is not a mandate with a problem — it is somebody else's, or nobody's.
 */
export function verifyMandate(
  token: string,
  publicJwk: Record<string, string>,
): OpenMandate {
  const parts = token.split(".");
  if (parts.length !== 3)
    throw new MandateError("Malformed mandate.", "malformed");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ];

  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString());
  } catch {
    throw new MandateError("Malformed mandate.", "malformed");
  }

  /*
   * The algorithm is pinned, not read. Trusting the header's `alg` is the
   * classic JWS break — "none" verifies everything, and an HMAC name lets the
   * public key be used as the shared secret.
   */
  if (header.alg !== "ES256") {
    throw new MandateError("A mandate must be signed with ES256.", "bad_alg");
  }

  const ok = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    {
      key: createPublicKey({ key: publicJwk as never, format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!ok)
    throw new MandateError(
      "That mandate's signature does not verify.",
      "bad_signature",
    );

  let payload: OpenMandate;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
  } catch {
    throw new MandateError("Malformed mandate.", "malformed");
  }

  if (payload.vct !== "mandate.checkout.open.1") {
    throw new MandateError("That is not a checkout mandate.", "wrong_type");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new MandateError("That mandate has expired.", "expired");
  }
  if (typeof payload.iat !== "number" || payload.iat > now + 60) {
    throw new MandateError("That mandate is not valid yet.", "not_yet_valid");
  }
  return payload;
}

export interface Violation {
  constraint: string;
  reason: string;
  detail: Record<string, unknown>;
}

/**
 * The basket, checked against what the human actually authorised.
 *
 * Every figure passed in here is Convo's own — the brand ids come from the
 * catalogue rows, and the totals were recomputed server-side. The agent
 * contributes the mandate and nothing else, which is the point: it can prove it
 * was authorised, and it cannot influence what it is authorised *for*.
 */
export function checkMandate(input: {
  mandate: OpenMandate;
  /** Per-brand totals, as Convo priced them. */
  perBrandMinor: Array<{ tenantId: string; amountMinor: number }>;
  currency: string;
  /** Already spent under this mandate, in minor units. */
  spentMinor: number;
}): {
  passed: boolean;
  violations: Violation[];
  totalMinor: number;
  remainingMinor: number;
} {
  const { mandate, perBrandMinor, spentMinor } = input;
  const violations: Violation[] = [];
  const totalMinor = perBrandMinor.reduce(
    (sum, line) => sum + line.amountMinor,
    0,
  );

  if (input.currency !== mandate.constraints.currency) {
    violations.push({
      constraint: "currency",
      reason: "currency_mismatch",
      detail: {
        authorised: mandate.constraints.currency,
        cart: input.currency,
      },
    });
  }

  /*
   * Every brand is checked separately rather than the cart as a whole. A cart
   * spanning an authorised brand and an unauthorised one must fail on the
   * second, not pass because most of it was fine.
   */
  const allowed = new Set(mandate.constraints.allowedBrandIds);
  for (const line of perBrandMinor) {
    if (!allowed.has(line.tenantId)) {
      violations.push({
        constraint: "checkout.allowed_merchants",
        reason: "merchant_not_allowed",
        detail: { tenantId: line.tenantId, amount_minor: line.amountMinor },
      });
    }
  }

  const remainingMinor = mandate.constraints.budgetMinor - spentMinor;
  if (totalMinor > remainingMinor) {
    violations.push({
      constraint: "payment.budget",
      reason: "budget_exceeded",
      detail: {
        proposed_minor: totalMinor,
        budget_minor: mandate.constraints.budgetMinor,
        spent_minor: spentMinor,
        remaining_minor: remainingMinor,
      },
    });
  }

  const ceiling = mandate.constraints.perOrderMaxMinor;
  if (ceiling > 0 && totalMinor > ceiling) {
    violations.push({
      constraint: "checkout.amount_range",
      reason: "amount_exceeds_max",
      detail: { proposed_minor: totalMinor, max_minor: ceiling },
    });
  }

  return {
    passed: violations.length === 0,
    violations,
    totalMinor,
    remainingMinor: remainingMinor - totalMinor,
  };
}

/** A stable id for a mandate, so spend can be tallied against it. */
export function mandateId(token: string): string {
  return `mnd_${createHmac("sha256", "mandate-id").update(token).digest("hex").slice(0, 24)}`;
}

/**
 * The mandate currently in force for a shopper.
 *
 * Held in memory rather than a table, deliberately: the demo signs with a key
 * generated at boot, so a mandate cannot outlive the process that issued it
 * anyway. Persisting one would only create rows that can never verify again.
 *
 * This is what lets a mandate bound the *conversation* rather than a separate
 * API surface. A shopper signs one, then shops the way they always do, and
 * every checkout in that chat is tested against it.
 */
const active = new Map<string, { token: string; payload: OpenMandate }>();

export function holdMandate(
  customerSessionId: string,
  token: string,
  payload: OpenMandate,
): void {
  active.set(customerSessionId, { token, payload });
}

export function activeMandate(
  customerSessionId: string,
): { token: string; payload: OpenMandate } | undefined {
  const held = active.get(customerSessionId);
  if (!held) return undefined;
  // Expiry is checked here as well as at verification: a mandate that lapsed
  // mid-conversation must stop authorising, not linger until the next signature.
  if (held.payload.exp <= Math.floor(Date.now() / 1000)) {
    active.delete(customerSessionId);
    return undefined;
  }
  return held;
}

export function releaseMandate(customerSessionId: string): void {
  active.delete(customerSessionId);
}
