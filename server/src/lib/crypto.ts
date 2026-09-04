import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { env } from '../env.js'

// One key derived from CONVO_SECRET, used for provider credentials at rest.
const KEY = scryptSync(env.secret, 'convo.provider.credentials.v1', 32)

/**
 * AES-256-GCM. Provider credentials are encrypted at rest and decrypted only
 * inside a provider adapter call; they never enter a response body, a log line,
 * or the model's context.
 */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptJson<T>(packed: string): T {
  const [version, ivPart, tagPart, dataPart] = packed.split('.')
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Stored credential is not in the expected format.')
  }
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8')) as T
}

/** scrypt password hashing for dashboard accounts. */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('base64url')
  const hash = scryptSync(password, salt, 64).toString('base64url')
  return { hash, salt }
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'base64url')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

/** Razorpay signature verification: HMAC-SHA256, compared in constant time. */
export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Non-secret display hint for a stored credential: `rzp_test_••••4f2a`. */
export function credentialHint(value: string): string {
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 8)}••••${value.slice(-4)}`
}
