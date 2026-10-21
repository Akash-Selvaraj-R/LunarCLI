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
 * Google Gemini adapter (generateContent API, `?alt=sse` streaming).
 *
 * The API key travels in the `x-goog-api-key` header — never in the URL —
 * so it cannot leak through request logging.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/**
 * Normalized → Gemini wire format.
 *
 * - Assistant tool calls become `functionCall` model parts.
 * - Tool results become `functionResponse` user parts.
 *
 * Provider-specific shapes stay inside this adapter.
 */
function toGeminiContents(messages: readonly Message[]): unknown[] {
  const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = []
  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.toolName ?? 'unknown_tool',
              response: {
                success: !message.content.startsWith('ERROR ('),
                result: message.content,
              },
            },
          },
        ],
      })
      continue
    }

    if (
      message.role === 'assistant' &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0
    ) {
      const parts: unknown[] = []
      if (message.content !== '') parts.push({ text: message.content })
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.arguments } })
      }
      contents.push({ role: 'model', parts })
      continue
    }

    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })
  }
  return contents
}

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: unknown }
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
}

function toFinishReason(reason: string | undefined): LLMResponse['finishReason'] {
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKLIST')
    return 'content_filter'
  return 'stop'
}

export class GeminiProvider extends BaseProvider {
  readonly id = 'gemini'
  readonly name = 'Google Gemini'
  readonly models = ['gemini-3-pro', 'gemini-3-flash'] as const
  readonly defaultModel = 'gemini-3-pro'
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

    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')

    const url = `${API_BASE}/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`

    const response = await postJson({
      url,
      providerId: this.id,
      providerName: this.name,
      headers: { 'x-goog-api-key': apiKey },
      body: {
        contents: toGeminiContents(request.messages),
        ...(system !== '' ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
        },
        ...(request.tools !== undefined && request.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  })),
                },
              ],
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
    let usage: LLMResponse['usage']
    let sawCandidate = false
    const toolCalls: ToolCall[] = []

    for await (const data of sseData(response.body)) {
      const chunk = parseProviderJson(this.name, data) as GeminiChunk

      if (chunk.promptFeedback?.blockReason != null && !sawCandidate) {
        throw new ProviderError(`${this.name} blocked the request`, {
          hint: `Provider reason: ${chunk.promptFeedback.blockReason}. Rephrase the input.`,
        })
      }

      const candidate = chunk.candidates?.[0]
      if (candidate !== undefined) {
        sawCandidate = true
        for (const part of candidate.content?.parts ?? []) {
          if (typeof part.text === 'string' && part.text !== '') {
            content += part.text
            callbacks.onText(part.text)
          }
          if (part.functionCall !== undefined) {
            finishReason = 'tool_calls'
            const args =
              part.functionCall.args !== null &&
              typeof part.functionCall.args === 'object' &&
              !Array.isArray(part.functionCall.args)
                ? (part.functionCall.args as Record<string, unknown>)
                : {}
            toolCalls.push({
              id: `tool-${toolCalls.length}`,
              name: part.functionCall.name ?? '',
              arguments: args,
            })
          }
        }
        if (candidate.finishReason != null) finishReason = toFinishReason(candidate.finishReason)
      }

      const meta = chunk.usageMetadata
      if (meta != null && (meta.promptTokenCount != null || meta.totalTokenCount != null)) {
        const inputTokens = meta.promptTokenCount ?? 0
        const outputTokens = meta.candidatesTokenCount ?? 0
        usage = {
          inputTokens,
          outputTokens,
          totalTokens: meta.totalTokenCount ?? inputTokens + outputTokens,
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
