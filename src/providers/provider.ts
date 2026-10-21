import { ProviderError } from '../domain/errors/index.js'

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCallOptions,
  ProviderOptions,
} from './types.js'

/**
 * Shared provider scaffolding.
 *
 * `BaseProvider` handles request validation so concrete providers only
 * need to care about their transport.
 */
export abstract class BaseProvider implements LLMProvider {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly models: readonly string[]
  abstract readonly defaultModel: string
  abstract readonly requiresApiKey: boolean

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

  abstract generate(request: LLMRequest, options?: ProviderCallOptions): Promise<LLMResponse>
}
