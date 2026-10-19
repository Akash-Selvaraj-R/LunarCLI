import type { Message, ToolResult } from '../domain/types/index.js'

/**
 * Provider-independent LLM abstraction.
 *
 * Nothing outside `src/providers/` may reference a concrete provider SDK.
 * The rest of LunarCLI talks to `LLMProvider` only, which keeps swapping
 * or adding providers (OpenAI, Anthropic, Gemini, local models…) a
 * localized change.
 */

/** Token usage accounting for a completed generation. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** A tool the model may invoke, described in a provider-neutral way. */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON-schema-like parameter description. */
  parameters: Record<string, unknown>
}

/** A request to generate a model response. */
export interface LLMRequest {
  model: string
  messages: readonly Message[]
  tools?: readonly ToolDefinition[]
  temperature?: number
  maxTokens?: number
  /** Results of previously invoked tools, when continuing a tool loop. */
  toolResults?: readonly ToolResult[]
}

/** The model's response. */
export interface LLMResponse {
  message: Message
  usage: Usage
  /** Why the model stopped: end of text, tool invocation, or limit. */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
}

/** A chat-completion backend. */
export interface LLMProvider {
  /** Stable machine identifier, e.g. "openai". */
  readonly id: string
  /** Human-readable display name, e.g. "OpenAI". */
  readonly name: string
  /** Model ids this provider exposes (Phase 0: informational). */
  readonly models: readonly string[]
  /** Generate a response for a request. */
  generate(request: LLMRequest): Promise<LLMResponse>
}

/** Provider configuration passed to provider factories. */
export interface ProviderOptions {
  apiKey?: string
  /** Optional overrides like base URLs or organization ids. */
  extra?: Record<string, unknown>
}
