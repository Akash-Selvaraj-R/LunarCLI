import type { LunarError } from '../domain/errors/index.js'
import type { Usage } from '../providers/types.js'
import type { AgentStatus } from './state.js'

/**
 * Events emitted by the agent runtime while a turn is in flight.
 *
 * The UI subscribes to these; the agent itself never renders. Events are
 * deliberately a small closed set — no event bus.
 */
export type AgentEvent =
  /** Lifecycle transition (thinking, responding, …). */
  | { type: 'status'; status: AgentStatus }
  /** Incremental streamed text (only when the provider streams). */
  | { type: 'delta'; text: string }
  /** The runtime is about to request a tool invocation. */
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  /** A tool invocation finished (successfully or not). */
  | { type: 'tool_result'; toolCallId: string; name: string; success: boolean; summary: string }
  /** The turn finished; `text` is the complete assistant message. */
  | { type: 'response'; text: string; usage?: Usage }
  /** The provider failed; `error` is a safe, structured Lunar error. */
  | { type: 'error'; error: LunarError }
  /** The in-flight request was cancelled by the user. */
  | { type: 'cancelled' }

export type AgentEventHandler = (event: AgentEvent) => void
