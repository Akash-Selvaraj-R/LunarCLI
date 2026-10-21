import fs from 'node:fs'

import type { Workspace } from '../domain/types/workspace.js'
import type { CommandRequest } from './command.js'
import type { CommandExecutor } from './command.js'
import type { ValidatedChange } from './changes.js'
import { FileOperation } from './changes.js'
import { detectTestCommand, runTests } from './test-runner.js'
import type { TestSummary } from './test-runner.js'

/**
 * Verification layer (Phase 3).
 *
 * Success is not "the write succeeded" — it is "the engineering
 * objective holds up": every applied change is confirmed on disk, and
 * the repository's test command runs green (when one exists).
 */

export interface VerificationCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail?: string
}

export interface VerificationResult {
  readonly ok: boolean
  readonly checks: readonly VerificationCheck[]
  readonly testSummary?: TestSummary
  /** Why tests did not run, when they did not. */
  readonly note?: string
}

export interface VerificationManagerOptions {
  workspace: Workspace
  executor: CommandExecutor
  /** Explicit verification command (else detected from the repository). */
  command?: CommandRequest
}

export class VerificationManager {
  private readonly workspace: Workspace
  private readonly executor: CommandExecutor
  private readonly command: CommandRequest | undefined

  constructor(options: VerificationManagerOptions) {
    this.workspace = options.workspace
    this.executor = options.executor
    this.command = options.command
  }

  /** The verification command this manager would run, if any. */
  testCommand(): CommandRequest | undefined {
    return this.command ?? detectTestCommand(this.workspace)
  }

  /**
   * Verify applied changes: filesystem state first, then tests.
   * Test failures are results, not exceptions.
   */
  async verify(
    applied: readonly ValidatedChange[],
    options: { signal?: AbortSignal; skipTests?: boolean } = {},
  ): Promise<VerificationResult> {
    const checks: VerificationCheck[] = applied.map((change) =>
      this.checkFilesystem(change),
    )

    let testSummary: TestSummary | undefined
    let note: string | undefined
    const command = this.testCommand()
    if (options.skipTests === true || command === undefined) {
      note =
        options.skipTests === true
          ? 'Tests skipped (command budget exhausted).'
          : 'No test command detected in this repository — filesystem checks only.'
    } else {
      try {
        testSummary = await runTests(this.executor, command, {
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        checks.push({
          name: `tests: ${testSummary.command}`,
          ok: !testSummary.timedOut && testSummary.exitCode === 0,
          detail:
            testSummary.timedOut
              ? 'timed out'
              : `exit code ${testSummary.exitCode ?? 'null'}`,
        })
      } catch (error) {
        // Infrastructure failure (executable missing, cancelled, …):
        // verification cannot pass, but this is not a test failure.
        checks.push({
          name: `tests: ${command.executable}`,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      ok: checks.every((check) => check.ok),
      checks,
      ...(testSummary !== undefined ? { testSummary } : {}),
      ...(note !== undefined ? { note } : {}),
    }
  }

  private checkFilesystem(change: ValidatedChange): VerificationCheck {
    if (change.operation === FileOperation.DELETE) {
      const gone = !fs.existsSync(change.absolutePath)
      return {
        name: `deleted: ${change.path}`,
        ok: gone,
        ...(gone ? {} : { detail: 'file still exists' }),
      }
    }
    const exists = fs.existsSync(change.absolutePath)
    return {
      name: `${change.operation}: ${change.path}`,
      ok: exists,
      ...(exists ? {} : { detail: 'file missing after apply' }),
    }
  }
}
