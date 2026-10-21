import { z } from 'zod'

import type { ToolCall, ToolResult } from '../domain/types/index.js'
import type { ToolContext } from './context.js'
import { ToolError } from './errors.js'
import type { ValidatedToolCall, Tool } from './types.js'

/**
 * Deterministic mock tool for agent tests — the runtime is testable
 * without touching the real filesystem or git.
 *
 * Tests can simulate: success, failure, thrown errors, permission
 * problems, slow tools (delay), and cancellation (abort mid-delay).
 */

export interface MockToolOptions {
  name?: string
  description?: string
  inputSchema?: z.ZodType
  /** Static result, or a function of the validated input. */
  result?: (input: unknown) => ToolResult | Promise<ToolResult>
  /** Throw this error when executed. */
  throw?: () => Error
  /** Simulated latency in milliseconds (honours the abort signal). */
  delayMs?: number
}

const DEFAULT_NAME = 'mock_tool'
const DEFAULT_ID = 'mock-call'

/** Build a ToolResult quickly. */
export function toolResult(
  toolCallId: string,
  output: unknown,
  options: { success?: boolean; error?: ToolResult['error'] } = {},
): ToolResult {
  const success = options.success ?? true
  return {
    toolCallId,
    success,
    output: success ? output : null,
    ...(!success && options.error !== undefined ? { error: options.error } : {}),
  }
}

/** Cancellable sleep that rejects with a cancelled ToolError on abort. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ToolError('cancelled', 'Tool execution was cancelled.'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted === true) {
      clearTimeout(timer)
      reject(new ToolError('cancelled', 'Tool execution was cancelled.'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class MockTool implements Tool {
  readonly name: string
  readonly description: string
  readonly risk = 'safe' as const
  readonly inputSchema: z.ZodType

  /** Inputs received, for assertions. */
  readonly calls: unknown[] = []

  private readonly options: MockToolOptions

  constructor(options: MockToolOptions = {}) {
    this.options = options
    this.name = options.name ?? DEFAULT_NAME
    this.description = options.description ?? 'Deterministic mock tool for tests.'
    this.inputSchema = options.inputSchema ?? z.object({ query: z.string().optional() })
  }

  async execute(call: ValidatedToolCall, context: ToolContext): Promise<ToolResult> {
    this.calls.push(call.input)
    if (this.options.delayMs !== undefined) {
      await delay(this.options.delayMs, context.signal)
    }
    if (this.options.throw !== undefined) throw this.options.throw()
    const resolved: ToolResult =
      this.options.result !== undefined
        ? await this.options.result(call.input)
        : { toolCallId: call.id, success: true, output: { ok: true } }
    return { ...resolved, toolCallId: call.id }
  }
}

/** A mock tool that always fails with a structured error. */
export function failingMockTool(name = 'failing_tool'): MockTool {
  return new MockTool({
    name,
    result: () => ({
      toolCallId: DEFAULT_ID,
      success: false,
      output: null,
      error: { kind: 'file_not_found', message: 'Simulated missing file.' },
    }),
  })
}

/** Helper for tests: build a normalized ToolCall for a mock tool. */
export function mockCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args }
}
