import { randomBytes, randomUUID } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Short, URL-safe, non-sequential id with a type prefix: `prd_k3f9x2…`. */
export function id(prefix: string, length = 14): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Unguessable token for session cookies and customer session ids. */
export function token(): string {
  return randomBytes(32).toString("base64url");
}

export function uuid(): string {
  return randomUUID();
}

/** Lowercase, hyphenated, URL-safe. Used for the public `/chat/<slug>` link. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function nowIso(): string {
  return new Date().toISOString();
}
