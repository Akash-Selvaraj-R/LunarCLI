import { stdout, printError } from '../output.js'
import { theme } from '../../ui/theme.js'
import type { Logger } from '../../logging/logger.js'
import type { EngineeringLoop } from '../../engineering/loop.js'
import type { EngineeringOutcome } from '../../engineering/loop.js'
import type { EngineeringEvent } from '../../engineering/events.js'
import type { PlanStep, PlanStepStatus } from '../../engineering/plan.js'
import { changeNotation } from '../../engineering/diff.js'

/**
 * `lunar "<task>" --engineer` — the autonomous engineering loop (Phase 3).
 *
 * Rendering only: the loop produces events, this module turns them into
 * the terminal UX. The approval prompt itself is owned by the loop's
 * ApprovalHandler (readline), so piped/auto modes work identically.
 *
 * Exit codes: 0 success · 1 denied/stopped/error · 130 cancelled.
 */

export interface EngineerOptions {
  task: string
  /** Configured loop (approval mode and limits decided by the caller). */
  loop: EngineeringLoop
  version: string
  logger: Logger
}

/** Cap per-file diff display so a huge diff never floods the terminal. */
const MAX_DIFF_LINES = 120

export async function runEngineer(options: EngineerOptions): Promise<number> {
  const { task, loop, version, logger } = options
  logger.debug('Engineering run requested', { characters: task.length })

  stdout('')
  stdout(theme.brand('  ╭────────────────────────────────────────────╮'))
  stdout(theme.brand('  │ LUNAR                                      │'))
  stdout(theme.brand('  │ Autonomous Engineering Loop                │'))
  stdout(theme.brand('  ╰────────────────────────────────────────────╯'))
  stdout(theme.muted(`  v${version}`))
  stdout('')

  const render = createRenderer()
  const outcome = await loop.run(task, { onEvent: render })

  stdout('')
  return exitCode(outcome)
}

/** One renderer per run — plan-progress state never leaks between runs. */
function createRenderer(): (event: EngineeringEvent) => void {
  const transitions = new Map<string, PlanStepStatus>()
  return (event: EngineeringEvent): void => renderEvent(event, transitions)
}

/** Map a loop outcome onto a process exit code. */
function exitCode(outcome: EngineeringOutcome): number {
  switch (outcome.status) {
    case 'success':
      return 0
    case 'cancelled':
      stdout(theme.warning('Cancelled.'))
      return 130
    case 'denied':
      stdout(`${theme.warning('Stopped:')} ${outcome.detail} Nothing was applied this round.`)
      stdout(theme.muted('Re-run the task to propose the changes again.'))
      return 1
    case 'stopped':
      stdout(theme.warning('LUNAR STOPPED'))
      stdout(outcome.detail)
      if (outcome.lastFailure !== undefined) {
        stdout('')
        stdout(theme.bold('Last failure:'))
        stdout(outcome.lastFailure)
      }
      stdout('')
      stdout(theme.muted('Review the diff (git diff) before continuing.'))
      return 1
    case 'error':
      printError(outcome.error.message, outcome.error.hint)
      return 1
  }
}

/** Render one loop event. Appends only — no screen rewrites. */
function renderEvent(
  event: EngineeringEvent,
  transitions: Map<string, PlanStepStatus>,
): void {
  switch (event.type) {
    case 'goal':
      stdout(theme.bold('GOAL'))
      stdout(event.text)
      stdout('')
      return

    case 'plan':
      stdout(theme.bold('PLAN'))
      event.plan.steps.forEach((step, index) => {
        stdout(`  ${index + 1}. ${step.description}`)
      })
      stdout('')
      return

    case 'plan_progress':
      // Append status lines for steps that just changed (no rewrites).
      for (const step of event.plan.steps) {
        const transitioned = transitions.get(step.id)
        if (transitioned !== undefined && transitioned !== step.status) {
          transitions.set(step.id, step.status)
          printStepTransition(step)
        } else if (transitioned === undefined) {
          transitions.set(step.id, step.status)
        }
      }
      return

    case 'tool_call':
      stdout(theme.muted(`  ◇ ${event.name}`))
      return

    case 'tool_result':
      stdout(theme.muted(`  ${event.success ? '✓' : '✗'} ${event.name}`))
      return

    case 'proposal':
      stdout('')
      if (event.diagnosis !== undefined) {
        stdout(theme.bold(`DIAGNOSIS (attempt ${event.iteration})`))
        stdout(indent(event.diagnosis))
        stdout('')
      }
      stdout(theme.bold(`PROPOSED CHANGES${event.iteration > 1 ? ` (attempt ${event.iteration})` : ''}`))
      for (const change of event.changes) {
        stdout(`  ${changeNotation(change.operation)} ${change.path}  ${theme.muted(`— ${change.reason}`)}`)
      }
      stdout('')
      stdout(
        theme.muted(
          event.changes.length === 1 ? '1 file changed' : `${event.changes.length} files changed`,
        ),
      )
      stdout('')
      stdout(theme.bold('DIFF'))
      for (const change of event.changes) {
        stdout(`  ${changeNotation(change.operation)} ${change.path}`)
        stdout(renderDiff(change.diff))
      }
      stdout('')
      return

    case 'approval':
      if (event.mode === 'auto') {
        stdout(theme.muted('  Changes auto-approved (--yes).'))
      } else if (!event.approved) {
        stdout(theme.warning('  Changes rejected.'))
      }
      return

    case 'apply_started':
      stdout(theme.bold('APPLYING CHANGES'))
      return

    case 'change_applied':
      stdout(`  ${theme.success('✓')} ${event.path} ${theme.muted(`(${event.durationMs}ms)`)}`)
      return

    case 'change_failed':
      stdout(`  ${theme.error('✗')} ${event.path} ${theme.muted(event.error)}`)
      return

    case 'verifying':
      stdout('')
      stdout(theme.bold('VERIFYING'))
      if (event.command !== undefined) stdout(`  $ ${event.command}`)
      return

    case 'verification_passed':
      printTestSummary(event.result.testSummary)
      stdout('')
      stdout(theme.success('✓ Verification passed'))
      for (const check of event.result.checks) {
        stdout(`  ${theme.success('✓')} ${check.name}`)
      }
      if (event.result.note !== undefined) stdout(theme.muted(`  ${event.result.note}`))
      stdout('')
      stdout(theme.success('LUNAR COMPLETE'))
      return

    case 'verification_failed':
      stdout('')
      stdout(theme.error('VERIFICATION FAILED'))
      for (const check of event.result.checks) {
        if (!check.ok) {
          stdout(
            `  ${theme.error('✗')} ${check.name}${check.detail !== undefined ? ` — ${check.detail}` : ''}`,
          )
        }
      }
      printTestSummary(event.result.testSummary)
      return

    case 'stopped':
      stdout('')
      stdout(theme.warning('LUNAR STOPPED'))
      stdout(event.reason)
      return

    case 'complete':
      stdout('')
      stdout(theme.success('LUNAR COMPLETE'))
      return

    case 'error':
      printError(event.error.message, event.error.hint)
      return

    case 'cancelled':
      stdout(theme.warning('Cancelled.'))
      return
  }
}

/** Print a plan step that just changed status. */
function printStepTransition(step: PlanStep): void {
  if (step.status === 'completed') {
    stdout(`  ${theme.success('✓')} ${step.description}`)
  } else if (step.status === 'failed') {
    stdout(`  ${theme.error('✗')} ${step.description}`)
  } else if (step.status === 'active') {
    stdout(`  ${theme.brand('→')} ${step.description}`)
  }
}

/** Render a unified diff with git-style indentation, bounded for display. */
function renderDiff(diff: string): string {
  const lines = diff.split('\n')
  const shown = lines.slice(0, MAX_DIFF_LINES)
  const body = shown.map((line) => `    ${line}`).join('\n')
  return lines.length > MAX_DIFF_LINES
    ? `${body}\n    ${theme.muted(`… (${lines.length - MAX_DIFF_LINES} more diff lines)`)}`
    : body
}

/** Structured test result block, when counts or an exit code exist. */
function printTestSummary(
  summary: { command: string; exitCode: number | null; passed?: number; failed?: number; timedOut: boolean; durationMs: number } | undefined,
): void {
  if (summary === undefined) return
  stdout('')
  stdout(theme.muted(`  $ ${summary.command}`))
  if (summary.passed !== undefined) stdout(`  ${theme.success('✓')} ${summary.passed} passed`)
  if (summary.failed !== undefined && summary.failed > 0) {
    stdout(`  ${theme.error('✗')} ${summary.failed} failed`)
  }
  if (summary.timedOut) stdout(`  ${theme.warning('✗')} timed out`)
  stdout(theme.muted(`  duration ${(summary.durationMs / 1000).toFixed(1)}s`))
}

/** Indent a multi-line block. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}
