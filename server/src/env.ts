import { config } from 'dotenv'
import { resolve } from 'node:path'

/*
 * The .env lives at the repo root; this file does not.
 *
 * `import 'dotenv/config'` reads from process.cwd(), and the server is started
 * by an npm workspace script, so the working directory is `server/`. There is
 * no `server/.env`, which meant the root file was never read and every value
 * quietly fell back to its default — including CONVO_SECRET, which has an
 * insecure development fallback, and the Razorpay keys, which have none. It
 * looked like it worked because most of the defaults happen to match what the
 * file says.
 *
 * Resolved from this module's own location instead, which lands on the repo
 * root from `src/` and from a built `dist/` alike. Real environment variables
 * still win: dotenv does not overwrite what is already set, so a deployment
 * that injects config properly is unaffected.
 */
const rootDir = resolve(import.meta.dirname, '../..')
config({ path: resolve(rootDir, '.env') })

function str(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function optional(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

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
  openaiModel: str('OPENAI_MODEL', 'gpt-5.6-luna'),
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com'),
  /*
   * Reasoning effort, for the models that have it.
   *
   * The gpt-5.6 family refuses function tools on Chat Completions unless this
   * is 'none' — the API says so in as many words and points at /v1/responses
   * for the alternative. Convo needs tools far more than it needs the model
   * thinking to itself, so 'none' it is, and the whole parameter is omitted
   * for models that predate it because they reject it outright.
   */
  openaiReasoningEffort: str('OPENAI_REASONING_EFFORT', 'none'),

  razorpayKeyId: optional('RAZORPAY_KEY_ID'),
  razorpayKeySecret: optional('RAZORPAY_KEY_SECRET'),
} as const

if (env.isProduction && env.secret.startsWith('dev-only')) {
  throw new Error('CONVO_SECRET must be set to a real secret in production.')
}
