/**
 * Chooses the model backend.
 *
 * Platform default from LLM_PROVIDER, overridable per tenant in the dashboard.
 * A configured provider with no API key falls back to the scripted provider
 * rather than failing the conversation, and says so in the logs.
 */
import { env } from '../env.js'
import { log } from '../lib/logger.js'
import { AnthropicModelProvider } from './anthropic.js'
import { OpenAIModelProvider } from './openai.js'
import { ScriptedModelProvider } from './scripted.js'
import type { ModelProvider } from './types.js'

const registry: Record<string, () => ModelProvider> = {
  anthropic: () => new AnthropicModelProvider(),
  openai: () => new OpenAIModelProvider(),
  scripted: () => new ScriptedModelProvider(),
}

export const AVAILABLE_PROVIDERS = Object.keys(registry)

const cache = new Map<string, ModelProvider>()

export function modelProvider(preferred?: string | null): ModelProvider {
  const requested = (preferred ?? env.llmProvider ?? 'scripted').toLowerCase()
  const cached = cache.get(requested)
  if (cached) return cached

  const build = registry[requested]
  if (!build) {
    log.warn('unknown LLM provider, using scripted', { requested })
    return modelProvider('scripted')
  }

  const provider = build()
  if (!provider.available) {
    log.warn('model provider has no credentials, using scripted', { requested })
    return modelProvider('scripted')
  }

  cache.set(requested, provider)
  return provider
}

export function providerStatus(): Array<{ name: string; model: string; available: boolean }> {
  return AVAILABLE_PROVIDERS.map((name) => {
    const provider = registry[name]!()
    return { name, model: provider.model, available: provider.available }
  })
}

export type { ModelProvider }
