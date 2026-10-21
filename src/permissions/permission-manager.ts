import { ToolRisk } from '../tools/risk.js'

/**
 * Permission engine (Phase 2 policy).
 *
 * Every tool execution is gated here — the executor consults the
 * PermissionManager and refuses to run anything it does not allow. The
 * LLM never talks to this layer; it can only REQUEST a tool.
 *
 * Phase 2 policy (read-only workspace inspection):
 *
 *   SAFE       → allow
 *   READ_ONLY  → allow
 *   MUTATING   → deny
 *   DANGEROUS  → deny
 *
 * The "ask" decision exists in the type for the future interactive
 * approval flow (safety phase) but is never produced by this policy.
 */

export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** Phase 2 risk → decision policy. */
export const PHASE2_POLICY: Readonly<Record<ToolRisk, PermissionDecision>> = {
  [ToolRisk.SAFE]: 'allow',
  [ToolRisk.READ_ONLY]: 'allow',
  [ToolRisk.MUTATING]: 'deny',
  [ToolRisk.DANGEROUS]: 'deny',
}

/**
 * Phase 3 policies for MUTATIONS (the engineering loop gate).
 *
 * The loop's proposals are NOT tools — they are structured changes the
 * loop validates and then takes through this same centralized risk
 * system. 'ask' is the default: nothing mutates without an explicit
 * human decision. PHASE3_AUTO_POLICY exists ONLY for an explicit
 * `--yes` trusted mode; DANGEROUS stays denied in both (Phase 3 has no
 * legitimate dangerous operation).
 */
export const PHASE3_ASK_POLICY: Readonly<Record<ToolRisk, PermissionDecision>> = {
  [ToolRisk.SAFE]: 'allow',
  [ToolRisk.READ_ONLY]: 'allow',
  [ToolRisk.MUTATING]: 'ask',
  [ToolRisk.DANGEROUS]: 'deny',
}

/** Trusted mode (`--yes`): mutations auto-approved, dangerous still denied. */
export const PHASE3_AUTO_POLICY: Readonly<Record<ToolRisk, PermissionDecision>> = {
  [ToolRisk.SAFE]: 'allow',
  [ToolRisk.READ_ONLY]: 'allow',
  [ToolRisk.MUTATING]: 'allow',
  [ToolRisk.DANGEROUS]: 'deny',
}

export interface PermissionCheck {
  /** Tool name, e.g. "read_file". */
  readonly tool: string
  /** Risk classification of the tool. */
  readonly risk: ToolRisk
}

/** Central gate for every tool invocation. */
export class PermissionManager {
  private readonly policy: Readonly<Record<ToolRisk, PermissionDecision>>

  constructor(policy: Readonly<Record<ToolRisk, PermissionDecision>> = PHASE2_POLICY) {
    this.policy = policy
  }

  /** Evaluate whether a tool with this risk may execute right now. */
  check(check: PermissionCheck): PermissionDecision {
    return this.policy[check.risk]
  }

  /** Convenience: may this tool execute? */
  isAllowed(check: PermissionCheck): boolean {
    return this.check(check) === 'allow'
  }
}
