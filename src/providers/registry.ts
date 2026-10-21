import { AnthropicProvider } from './anthropic.js'
import { GeminiProvider } from './gemini.js'
import { MockProvider } from './mock.js'
import { OpenAIProvider } from './openai.js'
import { ProviderError } from '../domain/errors/index.js'
import type { LLMProvider, ProviderOptions } from './types.js'

/**
 * Registry of available LLM providers.
 *
 *       ProviderRegistry
 *              │
 *              ├── OpenAIProvider
 *              ├── AnthropicProvider
 *              ├── GeminiProvider
 *              └── MockProvider (tests / keyless smoke runs)
 *
 * The registry is the only place that knows about concrete provider
 * classes. Application code resolves providers by id.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>()

  /** Register a provider. Throws if the id is already taken. */
  register(provider: LLMProvider): void {
    if (this.providers.has(provider.id)) {
      throw new ProviderError(`Provider already registered: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
  }

  /** Whether a provider with this id is registered. */
  has(id: string): boolean {
    return this.providers.has(id)
  }

  /** Resolve a provider by id. Throws ProviderError when unknown. */
  get(id: string): LLMProvider {
    const provider = this.providers.get(id)
    if (provider === undefined) {
      const available = this.list()
        .map((p) => p.id)
        .join(', ')
      throw new ProviderError(`Unknown provider: ${id}`, {
        hint: `Available providers: ${available || '(none)'}`,
      })
    }
    return provider
  }

  /** List all registered providers in registration order. */
  list(): readonly LLMProvider[] {
    return [...this.providers.values()]
  }
}

/** Factory options for building the default registry. */
export interface DefaultRegistryOptions {
  /** Provider-specific options (e.g. apiKey) keyed by provider id. */
  providerOptions?: Record<string, ProviderOptions>
}

/** Create a registry pre-populated with the built-in providers. */
export function createDefaultRegistry(options: DefaultRegistryOptions = {}): ProviderRegistry {
  const registry = new ProviderRegistry()
  const providerOptions = options.providerOptions ?? {}
  registry.register(new OpenAIProvider(providerOptions['openai'] ?? {}))
  registry.register(new AnthropicProvider(providerOptions['anthropic'] ?? {}))
  registry.register(new GeminiProvider(providerOptions['gemini'] ?? {}))
  registry.register(new MockProvider())
  return registry
}
