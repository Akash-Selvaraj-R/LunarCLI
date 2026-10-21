import type { Usage } from '../providers/types.js'
import type { LunarError } from '../domain/errors/index.js'
import type { AgentEventHandler } from './events.js'

/**
 * The Agent contract.
 *
 * Owns system instructions, conversation state, provider interaction,
 * response handling, iteration state, cancellation, and (in later
 * phases) tool execution. It does NOT own terminal rendering.
 */
export interface AgentRunOptions {
  /** Cancels the in-flight provider request (Ctrl+C). */
  signal?: AbortSignal
  /** Receives progress events (status, streamed deltas, final result). */
  onEvent?: AgentEventHandler
}

export interface AgentResult {
  /** completed → text, cancelled → nothing, error → structured error. */
  status: 'completed' | 'cancelled' | 'error'
  /** The complete assistant message (completed runs only). */
  text?: string
  /** Provider-reported usage, when available (completed runs only). */
  usage?: Usage
  /** Structured failure (error runs only). */
  error?: LunarError
}

export interface Agent {
  /** Provider id in use (for display and diagnostics). */
  readonly providerId: string
  /** Model id in use (for display and diagnostics). */
  readonly modelId: string
  /** Run one turn of the conversation. Never rejects — failures land in the result. */
  run(input: string, options?: AgentRunOptions): Promise<AgentResult>
}
