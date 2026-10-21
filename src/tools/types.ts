import type { z } from 'zod'

import type { ToolResult } from '../domain/types/index.js'
import type { ToolContext } from './context.js'
import type { ToolRisk } from './risk.js'

/**
 * Tool architecture.
 *
 *   Agent → LLM → normalized ToolCall → ToolRegistry → PermissionManager
 *     → Tool (Zod-validated input) → ToolResult → LLM
 *
 * The LLM can only REQUEST a tool. Lunar decides whether it executes:
 * every call goes through the registry (existence) and the
 * PermissionManager (risk policy) inside the executor — a tool can never
 * be invoked by bypassing that path. Phase 2 registers only read-only
 * inspection tools; no shell, no file mutation, no git mutation.
 */

/** A validated tool invocation, ready for `Tool.execute`. */
export interface ValidatedToolCall {
  readonly id: string
  readonly name: string
  /** Parsed and schema-validated arguments. */
  readonly input: unknown
}

/** A read-only engineering tool. */
export interface Tool {
  readonly name: string
  /** What the model should know about this tool (provider-facing). */
  readonly description: string
  /** Risk classification — drives the permission decision. */
  readonly risk: ToolRisk
  /** Zod schema; raw model arguments are validated before `execute`. */
  readonly inputSchema: z.ZodType
  /** Execute a validated call. Must honour `context.signal`. */
  execute(call: ValidatedToolCall, context: ToolContext): Promise<ToolResult>
  /** Optional one-line human summary for the terminal UI. */
  summarize?(call: ValidatedToolCall, result: ToolResult): string
}
