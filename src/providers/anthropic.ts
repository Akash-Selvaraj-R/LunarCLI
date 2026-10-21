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

/**
 * Normalized → Anthropic wire format.
 *
 * - System turns are extracted (top-level `system` parameter).
 * - Assistant tool calls become `tool_use` content blocks.
 * - Tool results become `tool_result` blocks inside a user turn
 *   (consecutive results are merged into a single user message, as the
 *   API requires them to follow the assistant message together).
 *
 * Provider-specific shapes stay inside this adapter.
 */
interface AnthropicTurn {
  role: 'user' | 'assistant'
  content: unknown[]
  /** Marker: this user turn exists only to carry tool_result blocks. */
  toolResults?: boolean
}

function toAnthropicMessages(messages: readonly Message[]): AnthropicTurn[] {
  const turns: AnthropicTurn[] = []
  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
        // Serialized failures start with "ERROR (" — flagged so Claude
        // can react to the failure instead of treating it as data.
        is_error: message.content.startsWith('ERROR ('),
      }
      const last = turns[turns.length - 1]
      if (last !== undefined && last.toolResults === true) {
        last.content.push(block)
      } else {
        turns.push({ role: 'user', content: [block], toolResults: true })
      }
      continue
    }

    if (
      message.role === 'assistant' &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0
    ) {
      const blocks: unknown[] = []
      if (message.content !== '') blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
      }
      turns.push({ role: 'assistant', content: blocks })
      continue
    }

    turns.push({
      role: message.role as 'user' | 'assistant',
      content: [{ type: 'text', text: message.content }],
    })
  }
  // Strip the internal marker before sending.
  return turns.map(({ role, content }) => ({ role, content }))
}

type AnthropicEvent = {
  type?: string
  index?: number
  message?: { usage?: { input_tokens?: number } }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

function toFinishReason(reason: string | null | undefined): LLMResponse['finishReason'] {
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'max_tokens') return 'length'
  return 'stop'
}

/** Parse streamed tool_use input JSON; tolerate empty/unparseable input. */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw === '') return {}
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
    const conversation = toAnthropicMessages(request.messages)

    const response = await postJson({
      url: API_URL,
      providerId: this.id,
      providerName: this.name,
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: {
        model: request.model,
        ...(system !== '' ? { system } : {}),
        messages: conversation.map((turn) => ({ role: turn.role, content: turn.content })),
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
    // Tool_use blocks stream their input as JSON fragments, keyed by index.
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>()
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
            toolBlocks.set(event.index ?? toolBlocks.size, {
              id: event.content_block.id ?? `tool-${toolBlocks.size}`,
              name: event.content_block.name ?? '',
              args: '',
            })
          }
          break
        }
        case 'content_block_delta': {
          if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
            content += event.delta.text
            callbacks.onText(event.delta.text)
          }
          if (
            event.delta?.type === 'input_json_delta' &&
            typeof event.delta.partial_json === 'string'
          ) {
            const block = toolBlocks.get(event.index ?? -1)
            if (block !== undefined) block.args += event.delta.partial_json
          }
          break
        }
        case 'content_block_stop': {
          const block = toolBlocks.get(event.index ?? -1)
          if (block !== undefined) {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: parseArguments(block.args),
            })
            toolBlocks.delete(event.index ?? -1)
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
