import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Public API keys.
 *
 * A key is shown once, at creation, and never again. What is stored is a
 * SHA-256 digest — not scrypt, because unlike a password this is 256 bits of
 * random and there is nothing to brute-force, and the lookup happens on every
 * API request. A dump of the table is not a set of working credentials.
 *
 * The `cvo_` prefix is deliberate: it makes a leaked key findable by secret
 * scanners in a repository or a log, which is worth more than the two
 * characters it costs.
 */

export const KEY_PREFIX = 'cvo'

export interface MintedKey {
  /** The only time the full key exists. Hand it to the merchant and forget it. */
  secret: string
  hash: string
  /** Kept in clear so a merchant can identify the key in a list. */
  prefix: string
}

export function mintApiKey(live = true): MintedKey {
  const body = randomBytes(24).toString('base64url')
  const secret = `${KEY_PREFIX}_${live ? 'live' : 'test'}_${body}`
  return { secret, hash: hashApiKey(secret), prefix: secret.slice(0, 16) }
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Compares two digests without leaking their difference through timing. */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/** Pulls the key out of an Authorization header, tolerating a bare key. */
export function readBearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const candidate = (match?.[1] ?? header).trim()
  return candidate.startsWith(`${KEY_PREFIX}_`) ? candidate : null
}
