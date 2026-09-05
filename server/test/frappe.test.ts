import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { assertPublicHttpsUrl, UnsafeUrlError } from "../src/lib/safefetch.js";
import { FrappeAdapter } from "../src/commerce/frappe.js";
import { ProviderConfigError } from "../src/commerce/types.js";

/*
 * The merchant supplies the hostname Convo's own server then calls, which makes
 * this the SSRF boundary for the whole ERP integration. Shopify can insist on a
 * `.myshopify.com` suffix; a self-hosted ERPNext can be anywhere, so the check
 * has to be on the address the name resolves to.
 */

const rejects = async (url: string, why: string) => {
  await assert.rejects(() => assertPublicHttpsUrl(url), UnsafeUrlError, why);
};

test("a merchant URL cannot point Convo at its own network", async () => {
  await rejects("https://127.0.0.1/api/resource/Item", "loopback allowed");
  await rejects("https://10.0.0.5/api/resource/Item", "private range allowed");
  await rejects(
    "https://192.168.1.10/api/resource/Item",
    "private range allowed",
  );
  await rejects(
    "https://172.16.4.4/api/resource/Item",
    "private range allowed",
  );
  await rejects(
    "https://169.254.169.254/latest/meta-data/",
    "cloud metadata allowed",
  );
  await rejects("https://[::1]/api/resource/Item", "IPv6 loopback allowed");
  // The v4-in-v6 form is the one people forget.
  await rejects(
    "https://[::ffff:127.0.0.1]/api",
    "IPv4-mapped loopback allowed",
  );
});

test("a merchant URL must be https, because the API secret rides on it", async () => {
  await rejects("http://erp.example.com/api", "plain http allowed");
  await rejects("ftp://erp.example.com", "non-http scheme allowed");
  await rejects("not a url at all", "garbage accepted");
});

test("a real public host is allowed through", async () => {
  const url = await assertPublicHttpsUrl("https://1.1.1.1/api/resource/Item");
  assert.equal(url.hostname, "1.1.1.1");
});

/*
 * The webhook's signature is the only thing standing between "ERPNext told us
 * stock moved" and "anyone who guessed a URL told us stock moved".
 */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret)
    .update(Buffer.from(body))
    .digest("base64");
}

test("a stock webhook signature is an HMAC over the exact bytes sent", () => {
  const secret = "shared-secret";
  const body = JSON.stringify({
    doctype: "Stock Ledger Entry",
    item_code: "SKU-1",
  });
  const good = sign(secret, body);

  assert.equal(
    sign(secret, body),
    good,
    "the same bytes must sign the same way",
  );
  assert.notEqual(
    sign("other-secret", body),
    good,
    "a different secret signed the same",
  );
  /*
   * The reason the raw buffer is kept on the request rather than re-deriving
   * the body with JSON.stringify(req.body): a sender is free to put whitespace
   * anywhere, and it signed the bytes it actually sent. Re-serialising throws
   * that away and every signature fails.
   */
  const withSpaces =
    '{ "doctype": "Stock Ledger Entry", "item_code": "SKU-1" }';
  assert.deepEqual(
    JSON.parse(withSpaces),
    JSON.parse(body),
    "same document either way",
  );
  assert.notEqual(
    sign(secret, withSpaces),
    sign(secret, body),
    "whitespace did not change the bytes",
  );
});

test("ERPNext is never allowed to be asked for money", async () => {
  const adapter = new FrappeAdapter();
  assert.equal(adapter.capabilities.payment, false);
  assert.equal(adapter.capabilities.catalog, true);
  await assert.rejects(
    () => adapter.createPaymentOrder({}, {} as never),
    ProviderConfigError,
    "a catalogue source accepted a payment order",
  );
});

test("a catalogue sync refuses to run without a warehouse and a price list", async () => {
  const adapter = new FrappeAdapter();
  await assert.rejects(
    () =>
      adapter.fetchCatalog({
        siteUrl: "https://erp.example.com",
        apiKey: "k",
        apiSecret: "s",
      }),
    ProviderConfigError,
    "synced with no warehouse named",
  );
  await assert.rejects(
    () =>
      adapter.fetchCatalog({
        siteUrl: "https://erp.example.com",
        apiKey: "k",
        apiSecret: "s",
        warehouse: "Stores - SC",
      }),
    ProviderConfigError,
    "synced with no price list named",
  );
});
