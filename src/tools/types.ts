import type { ToolCall, ToolResult } from '../domain/types/index.js'
import type { ToolDefinition } from '../providers/types.js'

/**
 * Tool architecture (foundation only).
 *
 * Future phases wire:
 *
 *   Agent → LLM → Tool Call → ToolRegistry → PermissionManager → Executor
 *
 * Phase 1 registers NOTHING: no shell, no filesystem, no execution of
 * any kind. The registry exists so the shape is settled and testable.
 */
export interface Tool {
  readonly definition: ToolDefinition
  /**
   * Execute a call. Never invoked in Phase 1 — the runtime rejects tool
   * calls before they reach a registry. Phase 2+ implements this behind
   * the `PermissionManager`.
   */
  execute(call: ToolCall): Promise<ToolResult>
}
