/**
 * Token-bucket rate limiting.
 *
 * In-process and therefore per-instance: with several instances behind a load
 * balancer each holds its own buckets, so the effective limit multiplies by the
 * instance count. That is the right trade for now — it needs no Redis, it
 * cannot fail open on a network blip, and the numbers below are set low enough
 * that a few multiples of them is still a long way from a problem. The swap to
 * a shared store is this file and nothing else.
 *
 * The chat limiter is the one that matters: every request there runs a model
 * turn, so an unthrottled endpoint is an unbounded bill.
 */

interface Bucket {
  tokens: number
  updatedAt: number
}

export interface LimitResult {
  allowed: boolean
  /** Seconds until one more request is permitted. */
  retryAfter: number
  remaining: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly refillPerMs: number

  constructor(
    readonly name: string,
    /** Bucket size: how many requests can arrive at once. */
    private readonly capacity: number,
    /** How many refill per minute, i.e. the sustained rate. */
    perMinute: number,
  ) {
    this.refillPerMs = perMinute / 60_000
  }

  take(key: string, cost = 1): LimitResult {
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now }

    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs)
    bucket.updatedAt = now

    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket)
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((cost - bucket.tokens) / this.refillPerMs / 1000)),
        remaining: 0,
      }
    }

    bucket.tokens -= cost
    this.buckets.set(key, bucket)
    return { allowed: true, retryAfter: 0, remaining: Math.floor(bucket.tokens) }
  }

  /** Drops buckets that have refilled to full; called on a timer. */
  sweep(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs
      if (refilled >= this.capacity) this.buckets.delete(key)
    }
  }
}

/**
 * The limits. A customer having a conversation sends a message every few
 * seconds at most; a script sends thousands. These are set to be invisible to
 * the first and immediate for the second.
 */
export const limiters = {
  /** Sign-in and sign-up, per IP. Deliberately tight. */
  auth: new RateLimiter('auth', 8, 12),
  /** One model turn per request, keyed by customer session. */
  chat: new RateLimiter('chat', 8, 20),
  /** Everything else on the public chat surface, per IP. */
  publicRead: new RateLimiter('public-read', 60, 180),
  /** The dashboard, per session. Generous: it is a person clicking. */
  dashboard: new RateLimiter('dashboard', 120, 400),
  /** The public REST API, per key. A nightly sync should never notice this. */
  api: new RateLimiter('api', 120, 600),
  /** Bulk writes cost more, so they draw more tokens. */
  apiBulk: new RateLimiter('api-bulk', 10, 30),
}

const everyMinute = setInterval(() => {
  for (const limiter of Object.values(limiters)) limiter.sweep()
}, 60_000)
everyMinute.unref?.()
