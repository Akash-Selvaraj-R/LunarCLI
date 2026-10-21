import { ProviderError } from '../domain/errors/index.js'
import { createMessage } from '../domain/models/session.js'
import type { Message, ToolCall } from '../domain/types/index.js'
import { parseProviderJson, postJson, requireApiKey } from './http.js'
import { BaseProvider } from './provider.js'
import { sseData } from './sse.js'
import type {
  FetchLike,
  LLMRequest,
  LLMResponse,
  ProviderCallOptions,
  ProviderOptions,
  StreamCallbacks,
} from './types.js'

/**
 * Anthropic adapter (Messages API).
 *
 * The system prompt is a top-level parameter, so it is split out of the
 * message list; only user/assistant turns form the conversation.
 */

const API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

type AnthropicEvent = {
  type?: string
  message?: { usage?: { input_tokens?: number } }
  content_block?: { type?: string; name?: string }
  delta?: { type?: string; text?: string; stop_reason?: string | null }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

function toFinishReason(reason: string | null | undefined): LLMResponse['finishReason'] {
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'max_tokens') return 'length'
  return 'stop'
}

export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic'
  readonly name = 'Anthropic'
  readonly models = ['claude-sonnet-4-5', 'claude-opus-4-1'] as const
  readonly defaultModel = 'claude-sonnet-4-5'
  readonly requiresApiKey = true

  constructor(options: ProviderOptions = {}) {
    super(options)
  }

  generate(request: LLMRequest, options?: ProviderCallOptions): Promise<LLMResponse> {
    return this.stream(request, { onText: () => {} }, options)
  }

  async stream(
    request: LLMRequest,
    callbacks: StreamCallbacks,
    options: ProviderCallOptions = {},
  ): Promise<LLMResponse> {
    this.validateRequest(request)
    const apiKey = requireApiKey(this.options.apiKey, this.name)
    const fetchImpl: FetchLike | undefined = this.options.fetch

    // System turns leave the conversation; Anthropic takes them separately.
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const conversation = request.messages.filter(
      (message): message is Message & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant',
    )

    const response = await postJson({
      url: API_URL,
      providerId: this.id,
      providerName: this.name,
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: {
        model: request.model,
        ...(system !== '' ? { system } : {}),
        messages: conversation.map((message) => ({ role: message.role, content: message.content })),
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.tools !== undefined && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
            }
          : {}),
      },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    })

    if (response.body === null) {
      throw new ProviderError(`Empty response from ${this.name}`, {
        hint: 'The provider returned no body. Try again.',
      })
    }

    let content = ''
    let finishReason: LLMResponse['finishReason'] = 'stop'
    let inputTokens = 0
    let outputTokens = 0
    let sawUsage = false
    const toolCalls: ToolCall[] = []

    for await (const data of sseData(response.body)) {
      const event = parseProviderJson(this.name, data) as AnthropicEvent

      switch (event.type) {
        case 'message_start': {
          const tokens = event.message?.usage?.input_tokens
          if (typeof tokens === 'number') {
            sawUsage = true
            inputTokens = tokens
          }
          break
        }
        case 'content_block_start': {
          if (event.content_block?.type === 'tool_use') {
            toolCalls.push({
              id: `tool-${toolCalls.length}`,
              name: event.content_block.name ?? '',
              arguments: {},
            })
          }
          break
        }
        case 'content_block_delta': {
          if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
            content += event.delta.text
            callbacks.onText(event.delta.text)
          }
          break
        }
        case 'message_delta': {
          if (event.delta?.stop_reason != null)
            finishReason = toFinishReason(event.delta.stop_reason)
          if (typeof event.usage?.output_tokens === 'number') {
            sawUsage = true
            outputTokens = event.usage.output_tokens
          }
          break
        }
        case 'error': {
          throw new ProviderError(
            `${this.name} stream error: ${event.error?.message ?? 'unknown error'}`,
            { hint: 'Retry the request. If it persists, run with --debug.' },
          )
        }
        default:
          break
      }
    }

    return {
      message: createMessage('assistant', content),
      ...(sawUsage
        ? { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
        : {}),
      finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    }
  }
}
