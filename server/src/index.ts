import express from 'express'
import cookieParser from 'cookie-parser'
import { env } from './env.js'
import { db } from './db/index.js'
import { log } from './lib/logger.js'
import { errorHandler } from './lib/http.js'
import { authRoutes } from './routes/auth.js'
import { catalogRoutes } from './routes/catalog.js'
import { providerRoutes } from './routes/providers.js'
import { chatRoutes } from './routes/chat.js'
import { apiRoutes } from './routes/api.js'
import { modelProvider } from './models/index.js'
import { limiters } from './lib/ratelimit.js'
import { clientIp, rateLimit, securityHeaders } from './lib/security.js'

const app = express()

app.disable('x-powered-by')
// One proxy hop is trusted for the client address; beyond that, X-Forwarded-For
// is attacker-controlled and rate limiting by it would be trivially evaded.
app.set('trust proxy', 1)
app.use(securityHeaders)
// Product images can be data URLs, so the JSON limit is generous but bounded.
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())

app.get('/api/health', (_req, res) => {
  const provider = modelProvider()
  res.json({
    ok: true,
    service: 'convo',
    model: { provider: provider.name, model: provider.model },
  })
})

// Public first, then the dashboard behind its own prefix: the dashboard
// routers apply requireAuth at the router level, so they must not sit on a
// path that public requests also travel through.
// The public REST API is versioned and authenticated by key, so it sits
// outside /api where the cookie-authenticated surfaces live.
app.use('/v1', apiRoutes)

app.use('/api/auth', authRoutes)
app.use('/api', rateLimit(limiters.publicRead, clientIp), chatRoutes)
const dashboardLimit = rateLimit(limiters.dashboard, clientIp)
app.use('/api/dashboard', dashboardLimit, catalogRoutes)
app.use('/api/dashboard', dashboardLimit, providerRoutes)

app.use(['/api', '/v1'], (_req, res) => {
  res.status(404).json({ error: 'No such endpoint.' })
})

app.use(errorHandler)

db() // open and migrate before the first request

const server = app.listen(env.port, () => {
  const provider = modelProvider()
  log.info('Convo is up', {
    port: env.port,
    model: `${provider.name}/${provider.model}`,
    publicBaseUrl: env.publicBaseUrl,
  })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutting down')
    server.close(() => process.exit(0))
  })
}
