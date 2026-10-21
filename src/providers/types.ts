import type { Message, ToolCall, ToolResult } from '../domain/types/index.js'

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
  /** Token accounting, only when the provider actually reported it. */
  usage?: Usage
  /** Why the model stopped: end of text, tool invocation, or limit. */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  /** Tool invocations the model asked for, when `finishReason` is `tool_calls`. */
  toolCalls?: readonly ToolCall[]
}

/** Per-call options every provider must honour. */
export interface ProviderCallOptions {
  /** Aborts the in-flight request; the promise rejects with an abort error. */
  signal?: AbortSignal
}

/** Receives incremental text while a response is streaming. */
export interface StreamCallbacks {
  onText(delta: string): void
}

/** A chat-completion backend. */
export interface LLMProvider {
  /** Stable machine identifier, e.g. "openai". */
  readonly id: string
  /** Human-readable display name, e.g. "OpenAI". */
  readonly name: string
  /** Model ids this provider exposes. */
  readonly models: readonly string[]
  /** Model used when the user did not configure one. */
  readonly defaultModel: string
  /** Whether this provider requires an API key (test providers do not). */
  readonly requiresApiKey: boolean
  /** Generate a response for a request. */
  generate(request: LLMRequest, options?: ProviderCallOptions): Promise<LLMResponse>
  /**
   * Optional streaming variant. Resolves with the complete response once
   * the stream ends; `callbacks.onText` receives incremental deltas.
   * Providers without streaming simply omit it.
   */
  stream?(
    request: LLMRequest,
    callbacks: StreamCallbacks,
    options?: ProviderCallOptions,
  ): Promise<LLMResponse>
}

/** Minimal HTTP transport signature (global `fetch` conforms). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Provider configuration passed to provider factories. */
export interface ProviderOptions {
  apiKey?: string
  /** Override the HTTP transport (used by tests). Defaults to global fetch. */
  fetch?: FetchLike
  /** Optional overrides like base URLs or organization ids. */
  extra?: Record<string, unknown>
}
