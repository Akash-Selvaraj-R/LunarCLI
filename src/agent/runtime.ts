import { CLIError, LunarError, ProviderError } from '../domain/errors/index.js'
import { createMessage } from '../domain/models/session.js'
import type { Workspace } from '../domain/types/workspace.js'
import { Conversation } from '../conversation/conversation.js'
import { createSilentLogger } from '../logging/logger.js'
import type { Logger } from '../logging/logger.js'
import type { LLMProvider, LLMRequest, LLMResponse } from '../providers/types.js'
import { ToolRegistry } from '../tools/registry.js'
import { redactText } from '../utils/redact.js'
import type { Agent, AgentResult, AgentRunOptions } from './agent.js'
import { buildAgentContext, contextToMessages } from './context.js'
import type { AgentEventHandler } from './events.js'
import { buildSystemPrompt } from './system-prompt.js'

/**
 * AgentRuntime — the Phase 1 loop.
 *
 *   user input
 *     → add user message
 *     → build context (system prompt + workspace + history)
 *     → call provider (streaming when supported, abortable)
 *     → add assistant message
 *     → emit events for the UI
 *
 * Testable without Ink or a terminal: rendering is the UI's job, this
 * layer only produces state and events. No tools execute in Phase 1; a
 * model-emitted tool call is refused and recorded.
 */
export interface AgentRuntimeOptions {
  provider: LLMProvider
  model: string
  workspace: Workspace
  /** Reuse an existing conversation (defaults to a fresh in-memory one). */
  conversation?: Conversation
  /** Override the generated system prompt (tests). */
  systemPrompt?: string
  /** Tool registry — defaults to an EMPTY one (no executable tools). */
  tools?: ToolRegistry
  logger?: Logger
  /** Lunar version, embedded in the system prompt when known. */
  version?: string
}

/** Cap a diagnostic string so error output stays concise. */
function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Map any thrown value onto a safe, structured Lunar error. */
function toLunarError(error: unknown, providerName: string): LunarError {
  if (error instanceof LunarError) return error
  const message = redactText(error instanceof Error ? error.message : String(error))
  return new ProviderError(`Unexpected error from ${providerName}: ${truncate(message)}`, {
    hint: 'Run with --debug for diagnostics.',
    cause: error,
  })
}

export class AgentRuntime implements Agent {
  readonly providerId: string
  readonly modelId: string

  private readonly provider: LLMProvider
  private readonly conversation: Conversation
  private readonly workspace: Workspace
  private readonly systemPrompt: string
  private readonly tools: ToolRegistry
  private readonly logger: Logger

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider
    this.modelId = options.model
    this.providerId = options.provider.id
    this.workspace = options.workspace
    this.tools = options.tools ?? new ToolRegistry()
    this.logger = options.logger ?? createSilentLogger()
    this.systemPrompt =
      options.systemPrompt ??
      buildSystemPrompt({
        workspace: options.workspace,
        ...(options.version !== undefined ? { version: options.version } : {}),
      })
    this.conversation =
      options.conversation ??
      new Conversation({
        workspaceRoot: options.workspace.root,
        providerId: options.provider.id,
        modelId: options.model,
      })
  }

  /** Read-only view of the conversation history (UI/tests). */
  get messages() {
    return this.conversation.getMessages()
  }

  async run(input: string, options: AgentRunOptions = {}): Promise<AgentResult> {
    const emit: AgentEventHandler = options.onEvent ?? (() => {})

    const prompt = input.trim()
    if (prompt === '') {
      // Never send empty requests to the provider.
      const error = new CLIError('Empty input — nothing was sent to the model.')
      emit({ type: 'error', error })
      return { status: 'error', error }
    }

    this.conversation.addMessage(createMessage('user', prompt))
    emit({ type: 'status', status: 'thinking' })

    const context = buildAgentContext({
      conversation: this.conversation,
      workspace: this.workspace,
      systemPrompt: this.systemPrompt,
    })
    const toolDefinitions = this.tools.list()
    const request: LLMRequest = {
      model: this.modelId,
      messages: contextToMessages(context),
      ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
    }

    const callOptions = options.signal !== undefined ? { signal: options.signal } : {}
    let response: LLMResponse
    try {
      if (this.provider.stream !== undefined) {
        let firstDelta = true
        response = await this.provider.stream(
          request,
          {
            onText: (delta: string) => {
              if (firstDelta) {
                firstDelta = false
                emit({ type: 'status', status: 'responding' })
              }
              emit({ type: 'delta', text: delta })
            },
          },
          callOptions,
        )
      } else {
        response = await this.provider.generate(request, callOptions)
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        this.logger.debug('Request cancelled by user', { provider: this.providerId })
        emit({ type: 'cancelled' })
        return { status: 'cancelled' }
      }
      const lunarError = toLunarError(error, this.provider.name)
      this.logger.error('Provider request failed', {
        provider: this.providerId,
        code: lunarError.code,
        error: lunarError.message,
      })
      emit({ type: 'error', error: lunarError })
      return { status: 'error', error: lunarError }
    }

    // Phase 1 refuses tool calls — it never executes anything.
    if (response.finishReason === 'tool_calls') {
      const names = (response.toolCalls ?? []).map((call) => call.name).filter((n) => n !== '')
      const requested = names.length > 0 ? names.join(', ') : 'unknown tool'
      const refusal = `Tool calls are not available in Phase 1 — I cannot run [${requested}]. No commands were executed and no files were changed.`
      this.conversation.addMessage(createMessage('assistant', refusal))
      this.logger.warn('Rejected tool call(s) requested by the model', {
        provider: this.providerId,
        tools: names,
      })
      emit({
        type: 'response',
        text: refusal,
        ...(response.usage !== undefined ? { usage: response.usage } : {}),
      })
      return {
        status: 'completed',
        text: refusal,
        ...(response.usage !== undefined ? { usage: response.usage } : {}),
      }
    }

    const text = response.message.content
    this.conversation.addMessage(createMessage('assistant', text))
    if (response.usage !== undefined) {
      this.logger.debug('Token usage', {
        provider: this.providerId,
        model: this.modelId,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
      })
    }
    emit({
      type: 'response',
      text,
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
    })
    return {
      status: 'completed',
      text,
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
    }
  }
}
