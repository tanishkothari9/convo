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
import { modelProvider } from './models/index.js'

const app = express()

app.disable('x-powered-by')
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
app.use('/api/auth', authRoutes)
app.use('/api', chatRoutes)
app.use('/api/dashboard', catalogRoutes)
app.use('/api/dashboard', providerRoutes)

app.use('/api', (_req, res) => {
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
