import { ProviderError } from '../domain/errors/index.js'
import { createMessage } from '../domain/models/session.js'
import type { ToolCall } from '../domain/types/index.js'
import { BaseProvider } from './provider.js'
import type { LLMRequest, LLMResponse, ProviderCallOptions, StreamCallbacks } from './types.js'

/**
 * Deterministic fake provider for tests and keyless smoke runs.
 *
 * Supports scriptable responses, errors, delays (for cancellation tests),
 * usage reporting, tool-call simulation, and streaming deltas — without
 * ever touching the network. `LUNAR_PROVIDER=mock` runs Lunar end-to-end
 * with no API key.
 */

/** One scripted provider turn (used by `script` for multi-turn flows). */
export interface MockTurn {
  /** Text to respond with. */
  response?: string
  /** Explicit stream chunks (overrides `response` splitting). */
  deltas?: readonly string[]
  /** Tool calls for this turn (forces finishReason 'tool_calls'). */
  toolCalls?: readonly ToolCall[]
  /** When set, this turn rejects with the error. */
  error?: Error
  /** Usage to report for this turn. */
  usage?: Partial<LLMResponse['usage']>
  /** Reported finish reason for this turn (default: 'stop'). */
  finishReason?: LLMResponse['finishReason']
}

export interface MockProviderOptions {
  /** Text to respond with (default: a canned mock notice). */
  response?: string
  /** When set, `generate`/`stream` reject with this error. */
  error?: Error
  /** Simulated latency in milliseconds (honoured before each chunk). */
  delayMs?: number
  /** Usage to report. Omit to report none (like providers without usage data). */
  usage?: Partial<LLMResponse['usage']>
  /** Reported finish reason (default: 'stop'). */
  finishReason?: LLMResponse['finishReason']
  /** Simulated tool calls (forces `finishReason` to 'tool_calls'). */
  toolCalls?: readonly ToolCall[]
  /** Explicit stream chunks; defaults to splitting `response` after spaces. */
  deltas?: readonly string[]
  /**
   * Multi-turn script: each call consumes the next entry (falls back to
   * the static options above once exhausted). Lets tests simulate a
   * tool-call → result → final-answer sequence deterministically.
   */
  script?: readonly MockTurn[]
}

const DEFAULT_RESPONSE = 'Mock response from LunarCLI built-in test provider.'

/** Reject with an abort-style error when cancelled (or immediately if already aborted). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error('The operation was aborted')
  }
}

/** Cancellable sleep. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('The operation was aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted === true) {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('The operation was aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class MockProvider extends BaseProvider {
  readonly id = 'mock'
  readonly name = 'Mock'
  readonly models = ['mock-1'] as const
  readonly defaultModel = 'mock-1'
  readonly requiresApiKey = false

  /** Every request this provider received, for assertions in tests. */
  readonly calls: LLMRequest[] = []

  private readonly mock: MockProviderOptions
  private turnIndex = 0

  constructor(options: MockProviderOptions = {}) {
    super({})
    this.mock = options
  }

  /** The effective turn for this call (script entry, or static defaults). */
  private nextTurn(): MockTurn {
    const script = this.mock.script
    const scripted = script !== undefined ? script[this.turnIndex] : undefined
    this.turnIndex += 1
    return scripted ?? {}
  }

  private check(request: LLMRequest, turn: MockTurn): void {
    this.validateRequest(request)
    this.calls.push(request)
    const error = turn.error ?? this.mock.error
    if (error !== undefined) throw error
  }

  private buildResponse(turn: MockTurn): LLMResponse {
    // Keep the final text consistent with what was streamed.
    const text =
      turn.response ??
      turn.deltas?.join('') ??
      this.mock.response ??
      this.mock.deltas?.join('') ??
      DEFAULT_RESPONSE
    const toolCalls = turn.toolCalls ?? this.mock.toolCalls
    const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0
    const finishReason: LLMResponse['finishReason'] = hasToolCalls
      ? 'tool_calls'
      : (turn.finishReason ?? this.mock.finishReason ?? 'stop')
    const usage = turn.usage ?? this.mock.usage
    return {
      message: createMessage('assistant', text),
      ...(usage !== undefined
        ? {
            usage: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              totalTokens:
                usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            },
          }
        : {}),
      finishReason,
      ...(hasToolCalls ? { toolCalls: toolCalls ?? [] } : {}),
    }
  }

  async generate(request: LLMRequest, options?: ProviderCallOptions): Promise<LLMResponse> {
    const turn = this.nextTurn()
    this.check(request, turn)
    await delay(this.mock.delayMs ?? 0, options?.signal)
    throwIfAborted(options?.signal)
    return this.buildResponse(turn)
  }

  async stream(
    request: LLMRequest,
    callbacks: StreamCallbacks,
    options: ProviderCallOptions = {},
  ): Promise<LLMResponse> {
    const turn = this.nextTurn()
    this.check(request, turn)
    const baseText = turn.response ?? this.mock.response ?? DEFAULT_RESPONSE
    const deltas = turn.deltas ?? this.mock.deltas ?? baseText.split(/(?<= )/).filter(Boolean)

    for (const delta of deltas) {
      await delay(this.mock.delayMs ?? 0, options.signal)
      throwIfAborted(options.signal)
      callbacks.onText(delta)
    }
    return this.buildResponse(turn)
  }
}

/** Convenience constructor for tests: a provider that fails with a ProviderError. */
export function failingProvider(message = 'mock provider failure'): MockProvider {
  return new MockProvider({ error: new ProviderError(message) })
}
