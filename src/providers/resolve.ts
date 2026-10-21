import type { LunarConfig } from '../config/schema.js'
import { ConfigurationError } from '../domain/errors/index.js'
import { createDefaultRegistry } from './registry.js'
import type { LLMProvider, ProviderOptions } from './types.js'

/**
 * Configuration → provider resolution.
 *
 * The agent never reads environment variables: it receives an already
 * resolved `{ provider, model }` pair built from the layered Phase 0
 * configuration (CLI → env → config file → defaults).
 */

export interface ResolvedProvider {
  provider: LLMProvider
  /** Model id to send (config override or the provider's default). */
  model: string
}

export interface ResolveProviderOptions {
  /** Inject a custom registry (tests). */
  registry?: ReturnType<typeof createDefaultRegistry>
}

/** Resolve the configured provider and model, or throw a LunarError. */
export function resolveProvider(
  config: LunarConfig,
  options: ResolveProviderOptions = {},
): ResolvedProvider {
  if (config.provider === undefined || config.provider === '') {
    throw new ConfigurationError('LUNAR_PROVIDER not configured', {
      hint: 'Set LUNAR_PROVIDER (openai, anthropic, gemini, or mock) in the environment or ~/.lunar/config.json.',
    })
  }

  const registry =
    options.registry ??
    createDefaultRegistry({
      providerOptions: config.apiKey !== undefined ? keyedProviderOptions(config.apiKey) : {},
    })

  // Unknown ids produce a ProviderError listing the available providers.
  const provider = registry.get(config.provider)

  if (provider.requiresApiKey && (config.apiKey === undefined || config.apiKey === '')) {
    throw new ConfigurationError(`No API key configured for ${provider.name}`, {
      hint: `Set LUNAR_API_KEY or add "apiKey" to ~/.lunar/config.json. (The "mock" provider needs no key.)`,
      details: { provider: provider.id },
    })
  }

  return { provider, model: config.model ?? provider.defaultModel }
}

/** The single configured API key is handed to every built-in provider. */
function keyedProviderOptions(apiKey: string): Record<string, ProviderOptions> {
  return {
    openai: { apiKey },
    anthropic: { apiKey },
    gemini: { apiKey },
  }
}
