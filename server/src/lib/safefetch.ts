import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetching a URL the merchant supplied.
 *
 * Shopify gets away with a simple guard because its host is always
 * `*.myshopify.com` — a fixed suffix Convo can insist on. A self-hosted ERP has
 * no such shape: the merchant's instance is on a host only they know, so the
 * hostname genuinely is user input, and Convo's server is the one making the
 * call. That is a server-side request forgery hole unless the address is
 * checked, and "looks like a normal domain" is not a check — `internal.corp`
 * resolves to a private address, and so does a DNS name an attacker controls
 * and points at 169.254.169.254.
 *
 * So the name is resolved first and the resulting address is what gets vetted,
 * not the string. Redirects are re-vetted the same way rather than followed
 * blindly, because a public host is free to redirect to a private one.
 */

export class UnsafeUrlError extends Error {}

/** Loopback, private, link-local, and the cloud metadata address. */
function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    const v6 = address.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80:")) return true; // link-local
    if (/^f[cd]/.test(v6)) return true; // unique local
    /*
     * An IPv4 address wearing a v6 hat.
     *
     * Both spellings, because `new URL()` rewrites one into the other: give it
     * `[::ffff:127.0.0.1]` and `url.hostname` hands back `[::ffff:7f00:1]`.
     * Matching only the dotted form lets loopback straight through, which is
     * exactly what happened before the test for it was written.
     */
    const mapped = v6.match(/^::(?:ffff:)?(.+)$/);
    if (mapped) {
      const rest = mapped[1]!;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return isBlockedAddress(rest, 4);
      const groups = rest.split(":");
      if (groups.length === 2) {
        const hi = Number.parseInt(groups[0]!, 16);
        const lo = Number.parseInt(groups[1]!, 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return isBlockedAddress(
            `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
            4,
          );
        }
      }
    }
    return false;
  }

  const [a, b] = address.split(".").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, and AWS/GCP metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Throws unless the URL is https and resolves to a public address. */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new UnsafeUrlError(
      "The URL must start with https:// — credentials are sent with it.",
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await lookup(host, { all: true }).catch(() => {
        throw new UnsafeUrlError(`Could not resolve ${url.hostname}.`);
      });

  if (addresses.length === 0)
    throw new UnsafeUrlError(`Could not resolve ${url.hostname}.`);
  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family)) {
      // Deliberately vague: the merchant does not need to know which of their
      // addresses is private, and an attacker probing the boundary learns less.
      throw new UnsafeUrlError("That address is not reachable from Convo.");
    }
  }
  return url;
}

/**
 * `fetch`, with every hop vetted.
 *
 * Redirects are followed by hand — `redirect: 'manual'` — so each new location
 * goes back through the same check. `fetch`'s own redirect handling would take
 * a 302 from a public host to 127.0.0.1 without a word.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  maxRedirects = 3,
): Promise<Response> {
  let target = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = await assertPublicHttpsUrl(target);
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status > 399) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    target = new URL(location, url).toString();
  }
  throw new UnsafeUrlError("That URL redirected too many times.");
}
