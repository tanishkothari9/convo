import 'dotenv/config'
import { resolve } from 'node:path'

function str(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

const rootDir = resolve(import.meta.dirname, '../..')

export const env = {
  port: Number(str('PORT', '8787')),
  nodeEnv: str('NODE_ENV', 'development'),
  isProduction: str('NODE_ENV', 'development') === 'production',
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:5173').replace(/\/$/, ''),
  databasePath: resolve(rootDir, str('DATABASE_PATH', './data/convo.db')),
  secret: str('CONVO_SECRET', 'dev-only-insecure-secret-change-me-0000000000000000'),

  llmProvider: str('LLM_PROVIDER', 'scripted'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  anthropicModel: str('ANTHROPIC_MODEL', 'claude-sonnet-5'),
  anthropicBaseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
  openaiApiKey: optional('OPENAI_API_KEY'),
  openaiModel: str('OPENAI_MODEL', 'gpt-4.1'),
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com'),

  razorpayKeyId: optional('RAZORPAY_KEY_ID'),
  razorpayKeySecret: optional('RAZORPAY_KEY_SECRET'),
} as const

if (env.isProduction && env.secret.startsWith('dev-only')) {
  throw new Error('CONVO_SECRET must be set to a real secret in production.')
}
