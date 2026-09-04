import { Router } from 'express'
import { tenants, users } from '../db/repo.js'
import { badRequest, conflict, requireString, optionalString, route, unauthorized } from '../lib/http.js'
import { slugify } from '../lib/ids.js'
import { clearSession, issueSession, passwordFields, passwordMatches, requireAuth, type AuthedRequest } from '../auth/index.js'
import { transaction } from '../db/index.js'

export const authRoutes = Router()

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Sign up: creates the brand and its first user together. */
authRoutes.post(
  '/signup',
  route(async (req, res) => {
    const email = requireString(req.body, 'email', 200).toLowerCase()
    const password = requireString(req.body, 'password', 200)
    const brandName = requireString(req.body, 'brandName', 80)
    const requestedSlug = optionalString(req.body, 'slug', 60)

    if (!EMAIL.test(email)) throw badRequest('That does not look like an email address.', 'bad_email')
    if (password.length < 8) throw badRequest('Use at least 8 characters.', 'weak_password')
    if (users.emailTaken(email)) throw conflict('That email already has an account.', 'email_taken')

    const slug = uniqueSlug(slugify(requestedSlug ?? brandName) || 'brand')

    const result = transaction(() => {
      const tenant = tenants.create({ name: brandName, slug })
      const { hash, salt } = passwordFields(password)
      const user = users.create({
        tenantId: tenant.id,
        email,
        passwordHash: hash,
        passwordSalt: salt,
      })
      return { tenant, user }
    })

    issueSession(res, result.user.id, result.tenant.id)
    res.status(201).json({ user: result.user, tenant: result.tenant })
  }),
)

authRoutes.post(
  '/login',
  route(async (req, res) => {
    const email = requireString(req.body, 'email', 200).toLowerCase()
    const password = requireString(req.body, 'password', 200)

    const credentials = users.credentialsByEmail(email)
    // The same message either way, so this cannot enumerate accounts.
    if (!credentials || !passwordMatches(password, credentials.hash, credentials.salt)) {
      throw unauthorized('That email and password do not match.')
    }

    issueSession(res, credentials.id, credentials.tenantId)
    res.json({ user: users.byId(credentials.id), tenant: tenants.byId(credentials.tenantId) })
  }),
)

authRoutes.post(
  '/logout',
  route(async (req, res) => {
    clearSession(req, res)
    res.status(204).end()
  }),
)

authRoutes.get(
  '/me',
  requireAuth,
  route(async (req, res) => {
    const { auth } = req as AuthedRequest
    res.json({ user: auth.user, tenant: auth.tenant })
  }),
)

function uniqueSlug(base: string): string {
  let candidate = base
  let suffix = 2
  while (tenants.slugTaken(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}
