import { CLIError, LunarError, ProviderError } from '../domain/errors/index.js'
import { createMessage } from '../domain/models/session.js'
import type { Workspace } from '../domain/types/workspace.js'
import type { ToolCall, ToolResult } from '../domain/types/index.js'
import { Conversation } from '../conversation/conversation.js'
import { createSilentLogger } from '../logging/logger.js'
import type { Logger } from '../logging/logger.js'
import { PermissionManager } from '../permissions/permission-manager.js'
import type { LLMProvider, LLMRequest, LLMResponse } from '../providers/types.js'
import { ToolExecutor } from '../tools/executor.js'
import { ToolRegistry } from '../tools/registry.js'
import { serializeToolResult } from '../tools/serialize.js'
import type { ValidatedToolCall } from '../tools/types.js'
import { redactText } from '../utils/redact.js'
import type { Agent, AgentResult, AgentRunOptions } from './agent.js'
import { buildAgentContext, contextToMessages } from './context.js'
import type { AgentEventHandler } from './events.js'
import { buildSystemPrompt } from './system-prompt.js'

/**
 * AgentRuntime — the agent loop.
 *
 *   user input
 *     → add user message
 *     → build context (system prompt + workspace + history)
 *     → call provider (streaming when supported, abortable)
 *     → tool call? → registry → permission check → execute → result
 *       appended to the conversation → call the provider again
 *     → final answer → add assistant message → emit events
 *
 * The model can only REQUEST tools; every call goes through the
 * ToolExecutor, which enforces registry existence, the PermissionManager
 * policy, Zod validation, and output limits. The loop is hard-capped by
 * `maxToolIterations` so it can never run forever.
 *
 * Testable without Ink or a terminal: rendering is the UI's job, this
 * layer only produces state and events.
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
  /** Permission policy — defaults to the Phase 2 read-only policy. */
  permissions?: PermissionManager
  /** Hard cap on tool-call rounds per user request (default 20). */
  maxToolIterations?: number
  /** Cap on serialized tool output per call (default 50 000 chars). */
  toolOutputCharLimit?: number
  logger?: Logger
  /** Lunar version, embedded in the system prompt when known. */
  version?: string
}

/** Safe default: no runaway tool loops, ever. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 20

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

/** One-line human summary of a tool result for the UI. */
function toolSummary(
  registry: ToolRegistry,
  call: ToolCall,
  result: ToolResult,
  charLimit: number,
): string {
  const tool = registry.get(call.name)
  if (tool?.summarize !== undefined) {
    const validCall: ValidatedToolCall = { id: call.id, name: call.name, input: call.arguments }
    try {
      return tool.summarize(validCall, result)
    } catch {
      // fall through to the generic summary
    }
  }
  if (!result.success) return result.error?.kind ?? 'failed'
  const serialized = serializeToolResult(result, charLimit)
  return truncate(serialized, 80)
}

export class AgentRuntime implements Agent {
  readonly providerId: string
  readonly modelId: string

  private readonly provider: LLMProvider
  private readonly conversation: Conversation
  private readonly workspace: Workspace
  private readonly systemPrompt: string
  private readonly tools: ToolRegistry
  private readonly executor: ToolExecutor
  private readonly logger: Logger
  private readonly maxToolIterations: number
  private readonly toolOutputCharLimit: number

  constructor(options: AgentRuntimeOptions) {
    this.provider = options.provider
    this.modelId = options.model
    this.providerId = options.provider.id
    this.workspace = options.workspace
    this.tools = options.tools ?? new ToolRegistry()
    this.logger = options.logger ?? createSilentLogger()
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS
    this.toolOutputCharLimit = options.toolOutputCharLimit ?? 50_000
    this.executor = new ToolExecutor({
      registry: this.tools,
      permissions: options.permissions ?? new PermissionManager(),
      logger: this.logger,
      outputCharLimit: this.toolOutputCharLimit,
    })
    this.systemPrompt =
      options.systemPrompt ??
      buildSystemPrompt({
        workspace: options.workspace,
        toolNames: this.tools.list().map((definition) => definition.name),
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

  /** One provider call (streaming when available), mapped to a response. */
  private async callProvider(
    request: LLMRequest,
    emit: AgentEventHandler,
    signal: AbortSignal | undefined,
  ): Promise<LLMResponse> {
    const callOptions = signal !== undefined ? { signal } : {}
    if (this.provider.stream !== undefined) {
      let firstDelta = true
      return this.provider.stream(
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
    }
    return this.provider.generate(request, callOptions)
  }

  async run(input: string, options: AgentRunOptions = {}): Promise<AgentResult> {
    const emit: AgentEventHandler = options.onEvent ?? (() => {})
    const signal = options.signal

    const prompt = input.trim()
    if (prompt === '') {
      // Never send empty requests to the provider.
      const error = new CLIError('Empty input — nothing was sent to the model.')
      emit({ type: 'error', error })
      return { status: 'error', error }
    }

    this.conversation.addMessage(createMessage('user', prompt))
    emit({ type: 'status', status: 'thinking' })

    const toolDefinitions = this.tools.list()

    for (let iteration = 0; ; iteration++) {
      const context = buildAgentContext({
        conversation: this.conversation,
        workspace: this.workspace,
        systemPrompt: this.systemPrompt,
      })
      const request: LLMRequest = {
        model: this.modelId,
        messages: contextToMessages(context),
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
      }

      let response: LLMResponse
      try {
        response = await this.callProvider(request, emit, signal)
      } catch (error) {
        if (signal?.aborted === true) {
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

      const toolCalls = response.toolCalls ?? []
      const usage = response.usage

      // ── No tool calls: this is the final answer. ──────────────────
      if (toolCalls.length === 0) {
        const text =
          response.finishReason === 'tool_calls'
            ? 'The model requested a tool call, but no valid tool call was included in the response. Please try rephrasing.'
            : response.message.content
        this.conversation.addMessage(createMessage('assistant', text))
        this.logUsage(usage)
        emit({ type: 'response', text, ...(usage !== undefined ? { usage } : {}) })
        return { status: 'completed', text, ...(usage !== undefined ? { usage } : {}) }
      }

      // ── Hard iteration cap: stop safely, never loop forever. ──────
      if (iteration >= this.maxToolIterations) {
        const text = `Tool execution limit reached (${this.maxToolIterations} tool rounds in one request). Stopping here — ask me to continue if you want more.`
        this.logger.warn('Tool iteration limit reached', {
          provider: this.providerId,
          limit: this.maxToolIterations,
        })
        this.conversation.addMessage(createMessage('assistant', text))
        emit({ type: 'response', text })
        return { status: 'completed', text }
      }

      // ── Execute this round of tool calls. ─────────────────────────
      this.conversation.addMessage(
        createMessage('assistant', response.message.content, { toolCalls }),
      )

      for (const call of toolCalls) {
        if (signal?.aborted === true) {
          emit({ type: 'cancelled' })
          return { status: 'cancelled' }
        }
        emit({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments })

        const executionContext = {
          workspace: this.workspace,
          ...(signal !== undefined ? { signal } : {}),
        }
        const result = await this.executor.execute(call, executionContext, executionContext)

        if (result.error?.kind === 'cancelled') {
          emit({ type: 'cancelled' })
          return { status: 'cancelled' }
        }

        const summary = toolSummary(this.tools, call, result, this.toolOutputCharLimit)
        emit({
          type: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          success: result.success,
          summary,
        })

        // The serialized result becomes conversation history the model
        // reasons over on the next round.
        this.conversation.addMessage(
          createMessage('tool', serializeToolResult(result, this.toolOutputCharLimit), {
            toolCallId: call.id,
            toolName: call.name,
          }),
        )
      }

      // Round-tripping to the model — still working.
      emit({ type: 'status', status: 'thinking' })
    }
  }

  /** Token accounting, when the provider actually reported it (debug only). */
  private logUsage(usage: LLMResponse['usage']): void {
    if (usage === undefined) return
    this.logger.debug('Token usage', {
      provider: this.providerId,
      model: this.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    })
  }
}
