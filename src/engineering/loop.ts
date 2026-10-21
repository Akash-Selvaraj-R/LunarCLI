import type { AgentEvent } from '../agent/events.js'
import { AgentRuntime } from '../agent/runtime.js'
import { LunarError } from '../domain/errors/index.js'
import type { Workspace } from '../domain/types/workspace.js'
import type { Logger } from '../logging/logger.js'
import { createSilentLogger } from '../logging/logger.js'
import type { LLMProvider } from '../providers/types.js'
import { PermissionManager, PHASE3_ASK_POLICY } from '../permissions/permission-manager.js'
import { createDefaultToolRegistry } from '../tools/defaults.js'
import { ToolError } from '../tools/errors.js'
import { ToolRisk } from '../tools/risk.js'
import { redactText } from '../utils/redact.js'
import { denyAll } from './approval.js'
import type { ApprovalHandler } from './approval.js'
import { CommandExecutor } from './command.js'
import type { CommandRequest } from './command.js'
import type { ValidatedChange } from './changes.js'
import { validateChanges } from './changes.js'
import type { EngineeringEvent, EngineeringEventHandler } from './events.js'
import { parseModelJson } from './json.js'
import type { EngineeringLimits } from './limits.js'
import { resolveLimits } from './limits.js'
import { MutationManager } from './mutation.js'
import type { EngineeringPlan } from './plan.js'
import { EngineeringPlanSchema, markSteps } from './plan.js'
import { engineeringSystemPrompt, planPrompt, proposalPrompt, correctionPrompt } from './prompts.js'
import { ChangeProposalSchema } from './proposal.js'
import type { ChangeProposal } from './proposal.js'
import { RetryController } from './retry.js'
import { VerificationManager } from './verification.js'
import type { VerificationResult } from './verification.js'

/**
 * EngineeringLoop — the autonomous engineering loop (Phase 3).
 *
 *   PLAN → PROPOSE → VALIDATE → PERMISSION → APPLY → VERIFY
 *                                                    │
 *                                FAIL → DIAGNOSE → FIX┘ (bounded)
 *
 * The loop OWNS no execution of its own: research happens through the
 * Phase 2 AgentRuntime (read-only tools, permission-gated), mutations
 * happen through the MutationManager (validated changes only, after
 * approval), and verification happens through the CommandExecutor
 * (allowlisted, no shell). Every transition is bounded by
 * EngineeringLimits and observable through events.
 *
 * The model never touches the filesystem or the shell. It produces
 * structured JSON; Zod validates it; the PermissionManager gates it.
 */
export interface EngineeringLoopOptions {
  provider: LLMProvider
  model: string
  workspace: Workspace
  logger?: Logger
  version?: string
  /** Hard limits — partial overrides merge over the defaults. */
  limits?: Partial<EngineeringLimits>
  /** Mutation gate. Defaults to the Phase 3 'ask' policy (nothing happens). */
  permissions?: PermissionManager
  /** Consulted when the policy says 'ask'. Defaults to denyAll. */
  approval?: ApprovalHandler
  /** Read-only tools for research turns (defaults to the Phase 2 registry). */
  tools?: ReturnType<typeof createDefaultToolRegistry>
  /** Explicit verification command (else detected from the repository). */
  testCommand?: CommandRequest
  onEvent?: EngineeringEventHandler
}

export type StopReason = 'max_iterations' | 'max_commands' | 'max_mutations'

export type EngineeringOutcome =
  | {
      status: 'success'
      goal: string
      plan: EngineeringPlan
      iterations: number
      applied: ValidatedChange[]
      verification: VerificationResult
    }
  | {
      status: 'stopped'
      reason: StopReason
      detail: string
      goal: string
      plan: EngineeringPlan
      iterations: number
      applied: ValidatedChange[]
      lastFailure?: string
    }
  | {
      status: 'denied'
      detail: string
      goal: string
      plan: EngineeringPlan
      iterations: number
      applied: ValidatedChange[]
    }
  | { status: 'error'; error: LunarError }
  | { status: 'cancelled' }

/** Result of one bounded phase (plan / proposal) with JSON retries. */
type PhaseResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: LunarError }
  | { status: 'cancelled' }

const TAIL_CHARS = 3_000

/** Tail of a string, for failure context sent back to the model. */
function tail(text: string, max = TAIL_CHARS): string {
  const trimmed = text.trimEnd()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

/** Human-readable command, e.g. "npm test". */
function formatCommand(request: CommandRequest | undefined): string | undefined {
  return request === undefined ? undefined : `${request.executable} ${request.args.join(' ')}`.trim()
}

/** Build the failure context handed to the next corrective attempt. */
function failureContext(result: VerificationResult): string {
  const lines: string[] = []
  for (const check of result.checks) {
    if (!check.ok) {
      lines.push(`FAILED: ${check.name}${check.detail !== undefined ? ` — ${check.detail}` : ''}`)
    }
  }
  if (result.note !== undefined) lines.push(result.note)
  const summary = result.testSummary
  if (summary !== undefined) {
    lines.push(`Command: ${summary.command}`)
    lines.push(`Exit code: ${summary.exitCode}`)
    lines.push(`Timed out: ${summary.timedOut}`)
    lines.push(`Duration: ${summary.durationMs}ms`)
    const out = tail(redactText(summary.stdout))
    const err = tail(redactText(summary.stderr))
    if (out !== '') lines.push(`stdout (tail):\n${out}`)
    if (err !== '') lines.push(`stderr (tail):\n${err}`)
  }
  return lines.join('\n')
}

export class EngineeringLoop {
  private readonly workspace: Workspace
  private readonly limits: EngineeringLimits
  private readonly logger: Logger
  private readonly onEvent: EngineeringEventHandler
  private readonly permissions: PermissionManager
  private readonly approval: ApprovalHandler
  private readonly runtime: AgentRuntime
  private readonly mutation: MutationManager
  private readonly verification: VerificationManager
  /** Active event handler for the current run (constructor default). */
  private runHandler: EngineeringEventHandler

  constructor(options: EngineeringLoopOptions) {
    this.workspace = options.workspace
    this.limits = resolveLimits(options.limits)
    this.logger = options.logger ?? createSilentLogger()
    this.onEvent = options.onEvent ?? (() => {})
    this.runHandler = this.onEvent
    // Mutation gate: centralized risk policy (Phase 3), not model output.
    this.permissions = options.permissions ?? new PermissionManager(PHASE3_ASK_POLICY)
    this.approval = options.approval ?? denyAll

    // Research turns reuse the Phase 2 runtime with read-only tools and
    // the Phase 2 policy — mutating tools remain impossible there.
    const tools = options.tools ?? createDefaultToolRegistry()
    this.runtime = new AgentRuntime({
      provider: options.provider,
      model: options.model,
      workspace: options.workspace,
      logger: this.logger,
      tools,
      permissions: new PermissionManager(),
      systemPrompt: engineeringSystemPrompt({
        workspace: options.workspace,
        toolNames: tools.list().map((definition) => definition.name),
        ...(options.version !== undefined ? { version: options.version } : {}),
      }),
    })

    this.mutation = new MutationManager({ limits: this.limits, logger: this.logger })
    const executor = new CommandExecutor({
      workspace: options.workspace,
      limits: this.limits,
      logger: this.logger,
    })
    this.verification = new VerificationManager({
      workspace: options.workspace,
      executor,
      ...(options.testCommand !== undefined ? { command: options.testCommand } : {}),
    })
  }

  /** Run the full loop for one task. Bounded on every axis. */
  async run(
    task: string,
    options: { signal?: AbortSignal; onEvent?: EngineeringEventHandler } = {},
  ): Promise<EngineeringOutcome> {
    const signal = options.signal
    // Per-run handler overrides the constructor default (CLI renders
    // per invocation; tests assert per run).
    this.runHandler = options.onEvent ?? this.onEvent
    const goal = task.trim()
    this.emit({ type: 'goal', text: goal })

    // ── PLAN ────────────────────────────────────────────────────────
    const planResult = await this.runPhase<EngineeringPlan>(
      'engineering plan',
      planPrompt(goal),
      (text) => parseModelJson(text, EngineeringPlanSchema, 'engineering plan'),
      signal,
    )
    if (planResult.status === 'cancelled') return { status: 'cancelled' }
    if (planResult.status === 'error') return { status: 'error', error: planResult.error }
    let plan = planResult.value
    this.emit({ type: 'plan', plan })
    this.logger.debug('Engineering plan ready', { steps: plan.steps.length })

    const retry = new RetryController(this.limits.maxIterations)
    const applied: ValidatedChange[] = []
    let commandsRun = 0
    let lastFailure: string | undefined

    // ── BOUNDED CORRECTIVE LOOP ─────────────────────────────────────
    while (retry.consume()) {
      const iteration = retry.attempts
      if (signal?.aborted === true) return { status: 'cancelled' }

      // ── PROPOSE (research via read-only tools + structured JSON) ──
      plan = markSteps(plan, ['research'], 'active')
      this.emit({ type: 'plan_progress', plan })

      const proposalResult = await this.propose(goal, plan, iteration, lastFailure, signal)
      if (proposalResult.status === 'cancelled') return { status: 'cancelled' }
      if (proposalResult.status === 'error') {
        return { status: 'error', error: proposalResult.error }
      }
      const { proposal, changes } = proposalResult.value
      this.emit({
        type: 'proposal',
        iteration,
        summary: proposal.summary,
        ...(proposal.diagnosis !== undefined ? { diagnosis: proposal.diagnosis } : {}),
        changes,
      })

      // ── MUTATION BUDGET ───────────────────────────────────────────
      if (applied.length + changes.length > this.limits.maxMutations) {
        return this.stop(
          'max_mutations',
          `The proposal needs ${changes.length} more mutations, but the task budget ` +
            `(${this.limits.maxMutations}) is exhausted. Applied changes are left in ` +
            'the workspace for review.',
          { goal, plan, iterations: iteration, applied, lastFailure },
        )
      }

      // ── PERMISSION (centralized risk policy → approval gate) ──────
      const decision = this.permissions.check({
        tool: 'apply_file_changes',
        risk: ToolRisk.MUTATING,
      })
      let approved: boolean
      let mode: 'prompt' | 'auto' | 'deny'
      if (decision === 'allow') {
        approved = true
        mode = 'auto'
      } else if (decision === 'ask') {
        mode = 'prompt'
        approved = await this.approval.approve(
          {
            goal,
            iteration,
            summary: proposal.summary,
            ...(proposal.diagnosis !== undefined ? { diagnosis: proposal.diagnosis } : {}),
            changes,
          },
          { ...(signal !== undefined ? { signal } : {}) },
        )
      } else {
        approved = false
        mode = 'deny'
      }
      this.emit({ type: 'approval', approved, mode })
      if (!approved) {
        this.logger.debug('Mutation denied by user or policy', { iteration })
        return {
          status: 'denied',
          detail: 'The changes were not applied.',
          goal,
          plan,
          iterations: iteration,
          applied,
        }
      }

      // ── APPLY (validated changes only, atomic writes) ─────────────
      this.emit({ type: 'apply_started', count: changes.length })
      const results = await this.mutation.apply(changes, {
        ...(signal !== undefined ? { signal } : {}),
      })
      const appliedNow: ValidatedChange[] = []
      let applyFailure: string | undefined
      for (const result of results) {
        if (result.applied) {
          applied.push(result.change)
          appliedNow.push(result.change)
          this.emit({
            type: 'change_applied',
            path: result.change.path,
            operation: result.change.operation,
            durationMs: result.durationMs,
          })
        } else {
          this.emit({
            type: 'change_failed',
            path: result.change.path,
            operation: result.change.operation,
            error: result.error ?? 'unknown error',
          })
          applyFailure ??= `${result.change.path}: ${result.error ?? 'unknown error'}`
        }
      }
      plan = markSteps(plan, ['research', 'mutation'], 'completed')
      this.emit({ type: 'plan_progress', plan })

      // A partially applied proposal is an attempt failure: re-plan
      // against the current workspace state on the next iteration.
      if (applyFailure !== undefined) {
        lastFailure = `Applying the previous proposal failed:\n${applyFailure}`
        continue
      }

      // ── VERIFY (filesystem state + controlled test run) ───────────
      const runsCommand = this.verification.testCommand() !== undefined
      if (runsCommand) {
        if (commandsRun >= this.limits.maxCommands) {
          return this.stop(
            'max_commands',
            `Command budget exhausted (${this.limits.maxCommands} executions). ` +
              'Applied changes are left in the workspace for review.',
            { goal, plan, iterations: iteration, applied, lastFailure },
          )
        }
        commandsRun += 1
      }
      plan = markSteps(plan, ['verification'], 'active')
      this.emit({ type: 'plan_progress', plan })
      this.emit({
        type: 'verifying',
        ...(formatCommand(this.verification.testCommand()) !== undefined
          ? { command: formatCommand(this.verification.testCommand()) as string }
          : {}),
      })

      const verification = await this.verification.verify(appliedNow, {
        ...(signal !== undefined ? { signal } : {}),
      })

      if (verification.ok) {
        plan = markSteps(plan, ['research', 'mutation', 'verification', 'other'], 'completed')
        this.emit({ type: 'plan_progress', plan })
        this.emit({ type: 'verification_passed', result: verification })
        this.emit({ type: 'complete', iterations: iteration })
        this.logger.debug('Engineering loop complete', { iterations: iteration })
        return { status: 'success', goal, plan, iterations: iteration, applied, verification }
      }

      // ── FAIL → capture context for a bounded corrective attempt ───
      plan = markSteps(plan, ['verification'], 'failed')
      this.emit({ type: 'plan_progress', plan })
      this.emit({ type: 'verification_failed', result: verification })
      lastFailure = failureContext(verification)
      this.logger.debug('Verification failed — corrective iteration', {
        iteration,
        budget: this.limits.maxIterations,
      })
    }

    // ── BUDGET EXHAUSTED ───────────────────────────────────────────
    return this.stop(
      'max_iterations',
      'Maximum engineering iterations reached.',
      { goal, plan, iterations: retry.attempts, applied, lastFailure },
    )
  }

  /** One corrective iteration: propose (research + JSON + validate). */
  private async propose(
    goal: string,
    plan: EngineeringPlan,
    iteration: number,
    failure: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<PhaseResult<{ proposal: ChangeProposal; changes: ValidatedChange[] }>> {
    return this.runPhase(
      'change proposal',
      proposalPrompt({
        task: goal,
        plan,
        iteration,
        ...(failure !== undefined ? { failure } : {}),
      }),
      (text) => {
        const proposal = parseModelJson(text, ChangeProposalSchema, 'change proposal')
        if (iteration > 1 && proposal.diagnosis === undefined) {
          throw new ToolError(
            'invalid_input',
            'A corrective proposal must include a "diagnosis" of the failure.',
          )
        }
        // Full validation: path safety, existence, conflicts, size.
        const changes = validateChanges(this.workspace, proposal.changes, this.limits)
        return { proposal, changes }
      },
      signal,
    )
  }

  /**
   * One bounded phase: runtime turn(s) + JSON extraction + schema
   * validation, with a correction prompt on failure (bounded by
   * `jsonRetries` — the model can never talk the loop into more).
   */
  private async runPhase<T>(
    label: string,
    prompt: string,
    parse: (text: string) => T,
    signal: AbortSignal | undefined,
  ): Promise<PhaseResult<T>> {
    let currentPrompt = prompt
    let lastError: LunarError | undefined

    for (let attempt = 0; attempt <= this.limits.jsonRetries; attempt++) {
      const result = await this.runtime.run(currentPrompt, {
        ...(signal !== undefined ? { signal } : {}),
        onEvent: this.forwardAgentEvent,
      })
      if (result.status === 'cancelled') return { status: 'cancelled' }
      if (result.status === 'error') {
        return {
          status: 'error',
          error:
            result.error ??
            new ToolError('execution_error', `The ${label} phase failed unexpectedly.`),
        }
      }
      try {
        return { status: 'ok', value: parse(result.text ?? '') }
      } catch (error) {
        // ToolError (and every LunarError) passes through with its hint
        // intact; anything else becomes a controlled error.
        lastError =
          error instanceof LunarError
            ? error
            : new ToolError('invalid_input', `The ${label} could not be parsed: ${String(error)}`)
        if (attempt >= this.limits.jsonRetries) break
        currentPrompt = correctionPrompt(label, lastError.message)
      }
    }
    return {
      status: 'error',
      error:
        lastError ?? new ToolError('invalid_input', `The ${label} could not be produced.`),
    }
  }

  /** Build a 'stopped' outcome with a consistent terminal event. */
  private stop(
    reason: StopReason,
    detail: string,
    context: {
      goal: string
      plan: EngineeringPlan
      iterations: number
      applied: ValidatedChange[]
      lastFailure?: string
    },
  ): EngineeringOutcome {
    this.emit({ type: 'stopped', reason: detail })
    return { status: 'stopped', reason, detail, ...context }
  }

  /** Forward only tool activity from research turns (no raw JSON deltas). */
  private readonly forwardAgentEvent = (event: AgentEvent): void => {
    if (event.type === 'tool_call') {
      this.emit({
        type: 'tool_call',
        id: event.id,
        name: event.name,
        arguments: event.arguments,
      })
    } else if (event.type === 'tool_result') {
      this.emit({
        type: 'tool_result',
        toolCallId: event.toolCallId,
        name: event.name,
        success: event.success,
        summary: event.summary,
      })
    }
  }

  private emit(event: EngineeringEvent): void {
    this.runHandler(event)
  }
}
