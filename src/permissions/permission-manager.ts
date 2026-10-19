import { NotImplementedError } from '../domain/errors/index.js'

/**
 * Placeholder for the future permission engine (Phase 4).
 *
 * Security baseline: in Phase 0 no autonomous execution exists, so every
 * request is denied. Phase 1+ will add risk classification, approval
 * flows, and sandboxed execution — all funneled through this interface so
 * no tool can ever bypass a permission check.
 */

export type PermissionDecision = 'allow' | 'deny' | 'ask'

export interface PermissionRequest {
  /** Tool that wants to run, e.g. "shell", "edit_file". */
  readonly tool: string
  /** Human-readable description of what the tool would do. */
  readonly description: string
  /** Structured action details (command, path, …). */
  readonly details?: Record<string, unknown>
}

/** Central gate for every future tool invocation. */
export class PermissionManager {
  /**
   * Evaluate a permission request.
   *
   * TODO(Phase 1-4): consult policy, risk classification, and user
   * approvals. Until then, deny everything.
   */
  request(_request: PermissionRequest): PermissionDecision {
    throw new NotImplementedError('Permission evaluation is not implemented yet (Phase 4)')
  }
}
