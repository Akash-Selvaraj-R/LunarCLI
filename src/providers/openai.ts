import { createMessage } from '../domain/models/session.js'
import { ProviderError } from '../domain/errors/index.js'
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
 * OpenAI adapter (Chat Completions API).
 *
 * Streams via SSE and accumulates into a single `LLMResponse`, so
 * `generate()` and `stream()` share one transport path.
 */

const API_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAIChunk {
  error?: { message?: string }
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
}

function toFinishReason(reason: string | null | undefined): LLMResponse['finishReason'] {
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'length') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  return 'stop'
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Unparseable arguments — surface as an empty object, never a crash.
  }
  return {}
}

export class OpenAIProvider extends BaseProvider {
  readonly id = 'openai'
  readonly name = 'OpenAI'
  readonly models = ['gpt-5', 'gpt-5-mini'] as const
  readonly defaultModel = 'gpt-5'
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

    const response = await postJson({
      url: API_URL,
      providerId: this.id,
      providerName: this.name,
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model: request.model,
        messages: request.messages.map((message: Message) => ({
          role: message.role,
          content: message.content,
        })),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_completion_tokens: request.maxTokens } : {}),
        ...(request.tools !== undefined && request.tools.length > 0
          ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) }
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
    let usage: LLMResponse['usage']
    const toolCalls: ToolCall[] = []

    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break
      const chunk = parseProviderJson(this.name, data) as OpenAIChunk

      if (chunk.error != null) {
        throw new ProviderError(`OpenAI stream error: ${chunk.error.message ?? 'unknown error'}`, {
          hint: 'Retry the request. If it persists, run with --debug.',
        })
      }

      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (typeof delta?.content === 'string' && delta.content !== '') {
        content += delta.content
        callbacks.onText(delta.content)
      }
      for (const call of delta?.tool_calls ?? []) {
        toolCalls.push({
          id: call.id ?? `tool-${toolCalls.length}`,
          name: call.function?.name ?? '',
          arguments: parseArguments(call.function?.arguments),
        })
      }
      if (choice?.finish_reason != null) finishReason = toFinishReason(choice.finish_reason)

      if (chunk.usage != null) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
        }
      }
    }

    return {
      message: createMessage('assistant', content),
      ...(usage !== undefined ? { usage } : {}),
      finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    }
  }
}
