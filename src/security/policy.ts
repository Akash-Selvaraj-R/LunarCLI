import type { Classification, CommandRisk } from './classifier.js'
import { classifyCommand } from './classifier.js'
import type { NormalizedCommand } from './normalizer.js'
import type { ProjectPolicy } from './project-policy.js'

/**
 * Command policy engine (Phase 4).
 *
 * Pipeline:  CommandRequest → normalize → classify → POLICY → permission
 *
 * This layer turns a risk classification plus the configured policies
 * into a concrete decision with a human-readable reason. Precedence
 * (highest wins — a lower layer never overrides a higher one):
 *
 *   1. hard deny          shells, transfer tools, git mutation, …
 *   2. global policy      built-in risk → decision mapping
 *   3. project policy     .lunar/policy.json (may tighten, never widen
 *                         past review, never touch denied/dangerous)
 *   4. user approval      the interactive gate ('ask' decisions)
 *
 * `--yes` (trusted) never bypasses layer 1 and never auto-approves
 * DANGEROUS commands — it only auto-approves REVIEW-class commands
 * that policy already considers auto-approvable in trusted mode.
 */

/** The permission decision for one command. */
export type CommandDecisionKind = 'allow' | 'ask' | 'deny'

export interface CommandDecision {
  readonly risk: CommandRisk
  readonly decision: CommandDecisionKind
  /** Human-readable justification — shown to the user, never a code. */
  readonly reason: string
  /** The canonical command this decision applies to. */
  readonly normalized: NormalizedCommand
  /** Whether the command is treated as network-capable. */
  readonly network: boolean
  /** Which layer produced the final decision. */
  readonly source: 'classification' | 'global-policy' | 'project-policy' | 'hard-deny'
}

export interface CommandPolicyOptions {
  /** `--yes` trusted mode: review-class commands auto-approve. */
  readonly trusted?: boolean
  /** Optional project overlay (untrusted — can only tighten). */
  readonly project?: ProjectPolicy
}

/**
 * Built-in global mapping (risk → decision). DANGEROUS is `ask` in
 * BOTH modes: `--yes` can never auto-approve it.
 */
const GLOBAL_DECISIONS: Readonly<Record<CommandRisk, CommandDecisionKind>> = {
  safe: 'allow',
  review: 'ask',
  dangerous: 'ask',
  denied: 'deny',
}

const TRUSTED_DECISIONS: Readonly<Record<CommandRisk, CommandDecisionKind>> = {
  safe: 'allow',
  review: 'allow',
  dangerous: 'ask',
  denied: 'deny',
}

export class CommandPolicy {
  private readonly trusted: boolean
  private readonly project: ProjectPolicy | undefined

  constructor(options: CommandPolicyOptions = {}) {
    this.trusted = options.trusted === true
    this.project = options.project
  }

  /** Evaluate the policy for an already-normalized command. */
  evaluate(normalized: NormalizedCommand): CommandDecision {
    const classification = classifyCommand(normalized)
    const base = {
      risk: classification.risk,
      normalized,
      network: classification.network,
    }

    // Layer 1: hard deny is absolute.
    if (classification.risk === 'denied') {
      return {
        ...base,
        decision: 'deny',
        reason: classification.reason,
        source: 'hard-deny',
      }
    }

    // Layers 2 + 3: global default, possibly tightened by project policy.
    const global = this.trusted
      ? TRUSTED_DECISIONS[classification.risk]
      : GLOBAL_DECISIONS[classification.risk]
    const globalReason = this.decorate(classification, global)

    const override = this.project?.commands.get(normalized.display)
    if (override === undefined) {
      return { ...base, decision: global, reason: globalReason, source: 'global-policy' }
    }

    const decision = this.applyProjectOverride(classification.risk, global, override)
    const projectReason =
      decision === global
        ? globalReason
        : `${classification.reason} Project policy (${this.project?.source ?? '.lunar/policy.json'}) marks "${normalized.display}" as ${override.toUpperCase()}.`
    return { ...base, decision, reason: projectReason, source: 'project-policy' }
  }

  /**
   * Project policy may TIGHTEN (allow→ask/deny, review→deny) but never
   * widen past what the global policy allows, and never touch
   * denied/dangerous classifications.
   */
  private applyProjectOverride(
    risk: CommandRisk,
    global: CommandDecisionKind,
    override: 'allow' | 'ask' | 'deny',
  ): CommandDecisionKind {
    if (risk === 'dangerous') return global // never widen or auto-allow
    const rank: Readonly<Record<CommandDecisionKind, number>> = { allow: 0, ask: 1, deny: 2 }
    if (override === 'allow') {
      // Widening (ask → allow) is only permitted for review-class
      // commands; safe commands are already allowed.
      return risk === 'review' ? 'allow' : global
    }
    // Tightening: always permitted.
    return rank[override] > rank[global] ? override : global
  }

  /** Explain the global decision in plain language. */
  private decorate(classification: Classification, decision: CommandDecisionKind): string {
    if (decision === 'allow' && this.trusted && classification.risk === 'review') {
      return `${classification.reason} Auto-approved by trusted mode (--yes).`
    }
    if (decision === 'ask' && classification.risk === 'dangerous') {
      return `${classification.reason} Requires explicit approval — trusted mode cannot bypass this.`
    }
    return classification.reason
  }
}
