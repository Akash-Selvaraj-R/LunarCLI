import { NotImplementedError, ProviderError } from '../domain/errors/index.js'

import type { LLMProvider, LLMRequest, LLMResponse, ProviderOptions } from './types.js'

/**
 * Shared provider scaffolding.
 *
 * `BaseProvider` handles request validation so concrete providers only
 * need to care about their transport. Phase 1 replaces the stubbed
 * `generate` implementations with real SDK calls.
 */
export abstract class BaseProvider implements LLMProvider {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly models: readonly string[]

  protected readonly options: ProviderOptions

  constructor(options: ProviderOptions = {}) {
    this.options = options
  }

  /** Validate a request before sending it anywhere. */
  protected validateRequest(request: LLMRequest): void {
    if (request.model === '') {
      throw new ProviderError(`[${this.id}] model id must not be empty`)
    }
    if (request.messages.length === 0) {
      throw new ProviderError(`[${this.id}] at least one message is required`)
    }
  }

  abstract generate(request: LLMRequest): Promise<LLMResponse>
}

/** Standard Phase 0 failure for providers without a real implementation. */
export function notImplemented(providerId: string): never {
  throw new NotImplementedError(`${providerId} provider is not implemented yet (Phase 1)`, {
    hint: 'Provider integrations arrive in Phase 1. Configure a provider later with LUNAR_PROVIDER / LUNAR_MODEL.',
  })
}
