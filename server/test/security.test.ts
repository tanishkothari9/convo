/**
 * The security properties, asserted rather than assumed.
 *
 * Tenant isolation is enforced by convention — every query carries a tenant id
 * — and convention is exactly the kind of thing that rots. These tests fail if
 * one brand can reach another's rows, if an API key escapes its tenant, or if
 * an image URL that can carry script gets stored.
 */
process.env.DATABASE_PATH = `./data/test-sec-${process.pid}.db`
process.env.CONVO_SECRET = 'test-secret-for-the-security-suite-00000000'

import { strict as assert } from 'node:assert'
import { after, before, test } from 'node:test'
import { rmSync } from 'node:fs'

const { db, closeDb } = await import('../src/db/index.js')
const { apiKeys, audit, carts, conversations, orders, products, tenants, users } = await import(
  '../src/db/repo.js'
)
const { mintApiKey, hashApiKey, digestsMatch, readBearer } = await import('../src/lib/apikeys.js')
const { isSafeImageUrl } = await import('../src/routes/catalog.js')
const { encryptJson, decryptJson, hashPassword, verifyPassword } = await import('../src/lib/crypto.js')
const { RateLimiter } = await import('../src/lib/ratelimit.js')
const { normaliseShopDomain } = await import('../src/commerce/shopify.js')

let alpha = ''
let beta = ''

before(() => {
  db()
  alpha = tenants.create({ name: 'Alpha Brand', slug: `alpha-${process.pid}` }).id
  beta = tenants.create({ name: 'Beta Brand', slug: `beta-${process.pid}` }).id
})

after(() => {
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${process.env.DATABASE_PATH}${suffix}`)
    } catch {
      /* nothing to clean up */
    }
  }
})

// ── Tenant isolation ────────────────────────────────────────────────────────

test('one brand cannot read another brand’s products', () => {
  const secret = products.create({ tenantId: beta, name: 'Beta secret', priceMinor: 9900, stock: 1 })

  assert.equal(products.byId(alpha, secret.id), undefined, 'byId crossed tenants')
  assert.deepEqual(products.byIds(alpha, [secret.id]), [], 'byIds crossed tenants')
  assert.ok(!products.list(alpha, { includeInactive: true }).some((p) => p.id === secret.id))
})

test('one brand cannot update or delete another brand’s products', () => {
  const secret = products.create({ tenantId: beta, name: 'Beta original', priceMinor: 5000, stock: 4 })

  assert.equal(products.update(alpha, secret.id, { name: 'hijacked', priceMinor: 1 }), undefined)
  assert.equal(products.remove(alpha, secret.id), false)

  const after = products.byId(beta, secret.id)!
  assert.equal(after.name, 'Beta original')
  assert.equal(after.priceMinor, 5000)
})

test('an external_id is unique per brand, not globally', () => {
  const a = products.upsertByExternalId(alpha, 'SKU-SHARED', { name: 'Alpha item', priceMinor: 100 })
  const b = products.upsertByExternalId(beta, 'SKU-SHARED', { name: 'Beta item', priceMinor: 200 })

  assert.notEqual(a.product.id, b.product.id, 'two brands collided on one SKU')
  assert.equal(products.byExternalId(alpha, 'SKU-SHARED')!.name, 'Alpha item')
  assert.equal(products.byExternalId(beta, 'SKU-SHARED')!.name, 'Beta item')
})

test('orders, carts and audit entries do not cross tenants', () => {
  const conversation = conversations.ensure(beta, `cust-${process.pid}`)
  const cart = carts.ensureOpen(beta, conversation.id)
  const order = orders.create({
    tenantId: beta,
    cartId: cart.id,
    conversationId: conversation.id,
    totalAmountMinor: 12_300,
    currency: 'INR',
    providerType: 'manual',
    providerOrderId: 'x',
    lineItems: [],
  })
  audit.record({ tenantId: beta, orderId: order.id, actionType: 'order.created', outcome: 'ok' })

  assert.equal(orders.byId(alpha, order.id), undefined)
  assert.equal(carts.byId(alpha, cart.id), undefined)
  assert.equal(conversations.byId(alpha, conversation.id), undefined)
  assert.ok(!audit.list(alpha, 100).some((e) => e.orderId === order.id))
  assert.equal(orders.revenueMinor(alpha), 0)
})

// ── API keys ────────────────────────────────────────────────────────────────

test('an API key is not recoverable from what is stored', () => {
  const minted = mintApiKey()
  apiKeys.create({
    tenantId: alpha,
    name: 'Sync',
    keyHash: minted.hash,
    prefix: minted.prefix,
    scope: 'write',
  })

  const stored = JSON.stringify(apiKeys.list(alpha))
  assert.ok(!stored.includes(minted.secret), 'the secret is retrievable from the key list')
  assert.ok(minted.hash !== minted.secret)
  assert.equal(minted.hash.length, 64, 'stored value is a sha-256 digest')
})

test('a key resolves only to the tenant that owns it', () => {
  const minted = mintApiKey()
  apiKeys.create({
    tenantId: beta,
    name: 'Beta key',
    keyHash: minted.hash,
    prefix: minted.prefix,
    scope: 'write',
  })

  const resolved = apiKeys.byHash(hashApiKey(minted.secret))!
  assert.equal(resolved.tenantId, beta)
  assert.notEqual(resolved.tenantId, alpha)
})

test('a revoked key stops resolving', () => {
  const minted = mintApiKey()
  const record = apiKeys.create({
    tenantId: alpha,
    name: 'Temporary',
    keyHash: minted.hash,
    prefix: minted.prefix,
    scope: 'read',
  })

  assert.ok(apiKeys.byHash(hashApiKey(minted.secret)))
  assert.equal(apiKeys.revoke(alpha, record.id), true)
  assert.equal(apiKeys.byHash(hashApiKey(minted.secret)), undefined)
  // A second brand cannot revoke a key it does not own.
  assert.equal(apiKeys.revoke(beta, record.id), false)
})

test('keys are unguessable and prefixed so a leak can be scanned for', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 200; i += 1) {
    const minted = mintApiKey()
    assert.ok(minted.secret.startsWith('cvo_live_'))
    assert.ok(minted.secret.length >= 40)
    assert.ok(!seen.has(minted.secret), 'minted a duplicate key')
    seen.add(minted.secret)
  }
})

test('digest comparison rejects mismatches and malformed input', () => {
  const a = hashApiKey('one')
  assert.equal(digestsMatch(a, a), true)
  assert.equal(digestsMatch(a, hashApiKey('two')), false)
  assert.equal(digestsMatch(a, ''), false)
  assert.equal(digestsMatch('', ''), false)
})

test('a bearer header is only accepted in the expected shape', () => {
  assert.equal(readBearer('Bearer cvo_live_abc'), 'cvo_live_abc')
  assert.equal(readBearer('cvo_live_abc'), 'cvo_live_abc')
  assert.equal(readBearer('Bearer sk-openai-key'), null)
  assert.equal(readBearer(undefined), null)
  assert.equal(readBearer(''), null)
})

// ── Stored XSS through product images ───────────────────────────────────────

test('an image URL that can carry script is refused', () => {
  const hostile = [
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'javascript:alert(1)',
    'https://evil.example/payload.svg',
    'https://evil.example/payload.svgz?x=1',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    '//evil.example/x.png',
  ]
  for (const url of hostile) {
    assert.equal(isSafeImageUrl(url), false, `accepted a hostile URL: ${url}`)
  }
})

test('ordinary product imagery is still accepted', () => {
  assert.equal(isSafeImageUrl('https://images.unsplash.com/photo-123?w=800'), true)
  assert.equal(isSafeImageUrl('data:image/png;base64,iVBORw0KGgo='), true)
  assert.equal(isSafeImageUrl('data:image/webp;base64,UklGRg=='), true)
})

// ── Credentials at rest ─────────────────────────────────────────────────────

test('provider credentials are unreadable without the secret', () => {
  const packed = encryptJson({ keyId: 'rzp_test_abc', keySecret: 'super-secret' })
  assert.ok(!packed.includes('super-secret'))
  assert.ok(!packed.includes('rzp_test_abc'))
  assert.deepEqual(decryptJson(packed), { keyId: 'rzp_test_abc', keySecret: 'super-secret' })
})

test('a tampered credential blob fails rather than decoding partially', () => {
  const packed = encryptJson({ keySecret: 'original' })
  const parts = packed.split('.')
  const flipped = Buffer.from(parts[3]!, 'base64url')
  flipped[0] = flipped[0]! ^ 0xff
  const tampered = [parts[0], parts[1], parts[2], flipped.toString('base64url')].join('.')
  assert.throws(() => decryptJson(tampered))
})

test('passwords are salted, so the same password stores differently', () => {
  const a = hashPassword('the-same-password')
  const b = hashPassword('the-same-password')
  assert.notEqual(a.hash, b.hash)
  assert.notEqual(a.salt, b.salt)
  assert.equal(verifyPassword('the-same-password', a.hash, a.salt), true)
  assert.equal(verifyPassword('the-wrong-password', a.hash, a.salt), false)
})

test('a user record never carries the password material', () => {
  const { hash, salt } = hashPassword('secret-password')
  const user = users.create({
    tenantId: alpha,
    email: `owner-${process.pid}@example.test`,
    passwordHash: hash,
    passwordSalt: salt,
  })
  const serialized = JSON.stringify(user)
  assert.ok(!serialized.includes(hash))
  assert.ok(!serialized.includes(salt))
  assert.ok(!serialized.includes('secret-password'))
})

// ── SSRF through a merchant-supplied host ───────────────────────────────────

test('a Shopify store name can never become an arbitrary host', () => {
  /*
   * The property that matters is not "these inputs throw" — several of them
   * normalise perfectly safely, because a single label is always re-suffixed
   * onto myshopify.com. What must hold is that nothing reaches this function
   * that could send a server request anywhere else.
   */
  const hostile = [
    'localhost',
    '127.0.0.1',
    '169.254.169.254',
    '[::1]',
    'evil.example.com',
    'shop.myshopify.com.evil.example',
    'shop/../../admin',
    'shop:8080',
    'http://internal-service',
    'http://user:pass@evil.example',
    'shop#@evil.example',
    'shop?next=//evil.example',
    '',
    ' ',
    'a'.repeat(120),
    'shop\nHost: evil.example',
  ]

  for (const value of hostile) {
    let resolved: string | null = null
    try {
      resolved = normaliseShopDomain(value)
    } catch {
      continue // refusing is a valid outcome
    }
    // If it did not refuse, the result must be exactly one label under
    // myshopify.com — no other host is reachable from here.
    assert.match(
      resolved,
      /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]\.myshopify\.com$/,
      `"${value}" normalised to a host Convo would connect to: ${resolved}`,
    )
    assert.ok(!resolved.includes('evil.example'), `"${value}" reached an attacker host`)
  }
})

test('an ordinary Shopify store name normalises whatever the merchant pasted', () => {
  for (const input of [
    'smart-choice',
    'smart-choice.myshopify.com',
    'https://smart-choice.myshopify.com',
    'https://smart-choice.myshopify.com/admin/products',
    '  Smart-Choice  ',
  ]) {
    assert.equal(normaliseShopDomain(input), 'smart-choice.myshopify.com')
  }
})

// ── Rate limiting ───────────────────────────────────────────────────────────

test('a burst is allowed up to the bucket, then refused', () => {
  const limiter = new RateLimiter('test', 3, 60)
  const key = 'one-caller'
  assert.equal(limiter.take(key).allowed, true)
  assert.equal(limiter.take(key).allowed, true)
  assert.equal(limiter.take(key).allowed, true)

  const refused = limiter.take(key)
  assert.equal(refused.allowed, false)
  assert.ok(refused.retryAfter >= 1, 'a refusal must say when to come back')
})

test('one caller being throttled does not throttle another', () => {
  const limiter = new RateLimiter('test', 1, 60)
  assert.equal(limiter.take('caller-a').allowed, true)
  assert.equal(limiter.take('caller-a').allowed, false)
  assert.equal(limiter.take('caller-b').allowed, true, 'buckets leaked between callers')
})
