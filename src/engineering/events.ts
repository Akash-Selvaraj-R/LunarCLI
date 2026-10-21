import type { LunarError } from '../domain/errors/index.js'
import type { EngineeringPlan } from './plan.js'
import type { ValidatedChange } from './changes.js'
import type { VerificationResult } from './verification.js'

/**
 * Events emitted by the engineering loop (Phase 3).
 *
 * Every mutation, approval, and command execution is observable —
 * this is what makes debugging Lunar itself possible. A small closed
 * set, mirroring the AgentEvent approach.
 */
export type EngineeringEvent =
  /** The task, restated as the goal. */
  | { type: 'goal'; text: string }
  /** A validated plan is ready (displayed to the user). */
  | { type: 'plan'; plan: EngineeringPlan }
  /** Progress update on plan steps. */
  | { type: 'plan_progress'; plan: EngineeringPlan }
  /** The model is researching with read-only tools (forwarded). */
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; name: string; success: boolean; summary: string }
  /** A validated proposal with its diff previews. */
  | {
      type: 'proposal'
      iteration: number
      summary: string
      diagnosis?: string
      changes: ValidatedChange[]
    }
  /** The approval gate was consulted. */
  | { type: 'approval'; approved: boolean; mode: 'prompt' | 'auto' | 'deny' }
  /** Applying has started; one event per applied/failed change. */
  | { type: 'apply_started'; count: number }
  | { type: 'change_applied'; path: string; operation: string; durationMs: number }
  | { type: 'change_failed'; path: string; operation: string; error: string }
  /** Verification is running / finished. */
  | { type: 'verifying'; command?: string }
  | { type: 'verification_passed'; result: VerificationResult }
  | { type: 'verification_failed'; result: VerificationResult }
  /** Retry budget exhausted — stopping safely. */
  | { type: 'stopped'; reason: string }
  /** Terminal states. */
  | { type: 'complete'; iterations: number }
  | { type: 'error'; error: LunarError }
  | { type: 'cancelled' }

export type EngineeringEventHandler = (event: EngineeringEvent) => void
