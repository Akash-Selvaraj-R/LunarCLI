import { BaseProvider, notImplemented } from './provider.js'
import type { LLMRequest, LLMResponse, ProviderOptions } from './types.js'

/**
 * Phase 0 provider stubs.
 *
 * TODO(Phase 1): replace each stub with a real implementation backed by the
 * official SDK (openai, @anthropic-ai/sdk, @google/genai, …), streaming
 * support, retries, and error mapping to ProviderError.
 */

/** OpenAI (Chat Completions / Responses API). */
export class OpenAIProvider extends BaseProvider {
  readonly id = 'openai'
  readonly name = 'OpenAI'
  readonly models = ['gpt-5', 'gpt-5-mini'] as const

  constructor(options: ProviderOptions = {}) {
    super(options)
  }

  generate(_request: LLMRequest): Promise<LLMResponse> {
    this.validateRequest(_request)
    return notImplemented(this.id)
  }
}

/** Anthropic (Claude). */
export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic'
  readonly name = 'Anthropic'
  readonly models = ['claude-sonnet-4-5', 'claude-opus-4-1'] as const

  constructor(options: ProviderOptions = {}) {
    super(options)
  }

  generate(_request: LLMRequest): Promise<LLMResponse> {
    this.validateRequest(_request)
    return notImplemented(this.id)
  }
}

/** Google (Gemini). */
export class GeminiProvider extends BaseProvider {
  readonly id = 'gemini'
  readonly name = 'Google Gemini'
  readonly models = ['gemini-3-pro', 'gemini-3-flash'] as const

  constructor(options: ProviderOptions = {}) {
    super(options)
  }

  generate(_request: LLMRequest): Promise<LLMResponse> {
    this.validateRequest(_request)
    return notImplemented(this.id)
  }
}
