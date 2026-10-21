/**
 * Core domain types shared across every layer of LunarCLI.
 *
 * These types are the stable contract between the CLI, UI, and (in Phase 1)
 * the agent runtime. They intentionally carry no behavior — behavior belongs
 * in the domain models and application services.
 */

/** Who produced a message in a conversation. */
export type Role = 'user' | 'assistant' | 'system' | 'tool'

/** A single message exchanged between the user, the model, and tools. */
export interface Message {
  readonly id: string
  readonly role: Role
  readonly content: string
  readonly timestamp: number
  /** Tool invocations this assistant message requested (assistant only). */
  readonly toolCalls?: readonly ToolCall[]
  /** Id of the tool call this message reports back (tool only). */
  readonly toolCallId?: string
  /** Name of the tool this message reports back (tool only). */
  readonly toolName?: string
}

/** An identified conversation between the user and the agent. */
export interface Session {
  readonly id: string
  readonly createdAt: number
  readonly workspaceRoot: string
  readonly providerId?: string
  readonly modelId?: string
  readonly messages: readonly Message[]
}

/** High-level lifecycle state of a user-requested task. */
export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'in_progress'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** A unit of work requested by the user (e.g. "fix the auth bug"). */
export interface Task {
  readonly id: string
  readonly prompt: string
  readonly status: TaskStatus
  readonly createdAt: number
  readonly updatedAt: number
}

/** Reference to a registered LLM provider. */
export interface Provider {
  readonly id: string
  readonly name: string
}

/** Reference to a model offered by a provider. */
export interface Model {
  readonly id: string
  readonly providerId: string
  readonly displayName: string
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  readonly id: string
  /** Registered tool name, e.g. "read_file". */
  readonly name: string
  /** Raw arguments as supplied by the model (validated before execution). */
  readonly arguments: Record<string, unknown>
}

/** Structured failure of a tool execution, safe to hand back to the model. */
export interface ToolErrorInfo {
  /** Machine-readable failure kind, e.g. "file_not_found". */
  readonly kind: string
  /** Human-readable (and model-readable) description. */
  readonly message: string
  /** Actionable suggestion, when one exists. */
  readonly hint?: string
}

/** Result of invoking a tool on behalf of the agent. */
export interface ToolResult {
  readonly toolCallId: string
  readonly success: boolean
  /** Structured output (provider adapters serialize it for the model). */
  readonly output: unknown
  /** Present when success is false. */
  readonly error?: ToolErrorInfo
}
