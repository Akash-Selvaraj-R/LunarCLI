import type { ToolCall, ToolResult, ToolErrorInfo } from '../domain/types/index.js'
import type { Logger } from '../logging/logger.js'
import { createSilentLogger } from '../logging/logger.js'
import { redactText } from '../utils/redact.js'
import type { PermissionManager } from '../permissions/permission-manager.js'
import type { ToolContext } from './context.js'
import { isToolError, ToolError } from './errors.js'
import { serializeToolResult, DEFAULT_RESULT_CHAR_LIMIT } from './serialize.js'
import type { ToolRegistry } from './registry.js'
import type { ValidatedToolCall } from './types.js'

/**
 * Tool executor — the single path through which a model-requested tool
 * call can run.
 *
 *   ToolCall → registry lookup → permission check → Zod validation
 *     → Tool.execute → bounded ToolResult
 *
 * Failure policy: a failing tool NEVER crashes the agent. Every problem
 * (unknown tool, denied permission, invalid input, execution error) is
 * converted into a failed ToolResult the model can reason about and act
 * on ("file not found — try another path").
 */

export interface ToolExecutorOptions {
  registry: ToolRegistry
  permissions: PermissionManager
  logger?: Logger
  /** Cap on serialized tool output handed back to the model. */
  outputCharLimit?: number
}

/** Contextual details passed to every tool in one turn. */
export interface ToolExecutionOptions {
  /** Aborts the tool (Ctrl+C during tool execution). */
  signal?: AbortSignal
}

function toErrorInfo(error: ToolError): ToolErrorInfo {
  return {
    kind: error.kind,
    message: redactText(error.message),
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
  }
}

/** Fresh read of the abort state (TS cannot see across await boundaries). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export class ToolExecutor {
  private readonly registry: ToolRegistry
  private readonly permissions: PermissionManager
  private readonly logger: Logger
  private readonly outputCharLimit: number

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry
    this.permissions = options.permissions
    this.logger = options.logger ?? createSilentLogger()
    this.outputCharLimit = options.outputCharLimit ?? DEFAULT_RESULT_CHAR_LIMIT
  }

  /** Execute one model-requested tool call. Never throws. */
  async execute(
    call: ToolCall,
    context: Omit<ToolContext, 'logger'> & { logger?: Logger },
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> {
    const startedAt = Date.now()
    const logger = context.logger ?? this.logger

    const fail = (error: ToolError): ToolResult => {
      logger.debug('Tool call failed', {
        tool: call.name,
        kind: error.kind,
        durationMs: Date.now() - startedAt,
      })
      return { toolCallId: call.id, success: false, output: null, error: toErrorInfo(error) }
    }

    // 1. Registry lookup (unknown or unregistered tools are refused).
    let tool
    try {
      tool = this.registry.require(call.name)
    } catch (error) {
      return fail(isToolError(error) ? error : new ToolError('execution_error', String(error)))
    }

    // 2. Centralized permission check — never bypassed.
    const decision = this.permissions.check({ tool: tool.name, risk: tool.risk })
    if (decision !== 'allow') {
      return fail(
        new ToolError(
          'permission_denied',
          `Tool "${tool.name}" (${tool.risk}) is not permitted in this phase.`,
          { hint: 'This tool is disabled. Lunar is read-only right now.' },
        ),
      )
    }

    // 3. Cancellation before any real work.
    if (options.signal?.aborted === true) {
      return fail(new ToolError('cancelled', 'Tool execution was cancelled.'))
    }

    // 4. Zod validation — unvalidated model JSON never reaches a tool.
    const parsed = tool.inputSchema.safeParse(call.arguments)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return fail(
        new ToolError('invalid_input', `Invalid arguments for "${tool.name}": ${issues}`, {
          details: { issues: parsed.error.issues },
        }),
      )
    }

    // 5. Execute with redacted debug diagnostics.
    const validCall: ValidatedToolCall = { id: call.id, name: tool.name, input: parsed.data }
    logger.debug('Tool executing', {
      tool: tool.name,
      arguments: redactText(JSON.stringify(call.arguments)),
    })

    try {
      const result = await tool.execute(validCall, { ...context, logger })
      const serialized = serializeToolResult(result, this.outputCharLimit)
      logger.debug('Tool finished', {
        tool: tool.name,
        durationMs: Date.now() - startedAt,
        resultBytes: serialized.length,
        success: result.success,
      })
      return result
    } catch (error) {
      if (isAborted(options.signal) || (isToolError(error) && error.kind === 'cancelled')) {
        return fail(new ToolError('cancelled', 'Tool execution was cancelled.'))
      }
      if (isToolError(error)) return fail(error)
      const message = redactText(error instanceof Error ? error.message : String(error))
      return fail(
        new ToolError('execution_error', `Tool "${tool.name}" failed: ${message}`, {
          cause: error,
        }),
      )
    }
  }
}
