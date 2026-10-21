import readline from 'node:readline'

import type { ValidatedChange } from './changes.js'
import { changeNotation } from './diff.js'
import type { CommandRisk } from '../security/classifier.js'
import { theme } from '../ui/theme.js'

/**
 * Mutation approval (Phase 3).
 *
 * Nothing mutates the repository without passing this gate. The gate
 * itself is decided by the PermissionManager's risk policy ('allow' in
 * auto-approve mode, 'ask' otherwise); the handler implements the
 * actual asking. Deletes are always called out explicitly — they cannot
 * be automatically reversed.
 */

export interface ApprovalRequest {
  /** The overall task goal (for context). */
  readonly goal: string
  /** 1-based attempt number. */
  readonly iteration: number
  /** Proposal summary (why these changes). */
  readonly summary: string
  /** Diagnosis from the previous failed verification, when present. */
  readonly diagnosis?: string
  /** The validated changes about to be applied. */
  readonly changes: readonly ValidatedChange[]
}

export interface ApprovalHandler {
  /**
   * Ask whether to apply this proposal. Resolves true to apply.
   * Must honour the abort signal (resolve false when aborted).
   */
  approve(request: ApprovalRequest, options?: { signal?: AbortSignal }): Promise<boolean>
}

/** Always approve (explicit `--yes` / trusted mode only). */
export const autoApprove: ApprovalHandler = {
  approve: async () => true,
}

/** Always deny (safe default when no interactive handler is wired). */
export const denyAll: ApprovalHandler = {
  approve: async () => false,
}

/** Render the compact change list shared by prompt and events. */
export function describeChanges(changes: readonly ValidatedChange[]): string[] {
  return changes.map((change) => `  ${changeNotation(change.operation)} ${change.path}`)
}

/**
 * Interactive [y/N] approver reading from stdin. Anything except an
 * explicit "y"/"yes" is a no — the safe default.
 */
export function readlineApprover(): ApprovalHandler {
  return {
    approve: (request, options = {}) =>
      new Promise<boolean>((resolve) => {
        const hasDelete = request.changes.some(
          (change) => change.operation === 'delete',
        )
        const out = process.stdout
        out.write('\n')
        out.write(`${theme.bold('☾ Lunar wants to apply these changes.')}\n`)
        for (const line of describeChanges(request.changes)) {
          out.write(`${line}\n`)
        }
        out.write('\n')
        out.write(`${theme.bold('Reason:')}\n${request.summary}\n`)
        if (hasDelete) {
          out.write('\n')
          out.write(`${theme.warning('DELETE REQUEST')}\n`)
          for (const change of request.changes) {
            if (change.operation === 'delete') {
              out.write(`  ${change.path}\n  ${theme.muted(change.reason)}\n`)
            }
          }
          out.write(`${theme.warning('Deletions cannot be automatically reversed.')}\n`)
        }
        out.write('\n')

        const rl = readline.createInterface({ input: process.stdin, terminal: false })
        let settled = false
        const finish = (approved: boolean): void => {
          if (settled) return
          settled = true
          rl.close()
          options.signal?.removeEventListener('abort', onAbort)
          out.write('\n')
          resolve(approved)
        }
        const onAbort = (): void => finish(false)
        options.signal?.addEventListener('abort', onAbort, { once: true })
        rl.once('line', (line: string) => {
          finish(line.trim().toLowerCase() === 'y' || line.trim().toLowerCase() === 'yes')
        })
        // Closing stdin without input counts as a rejection.
        rl.once('close', () => finish(false))
        out.write(`${theme.brand('Apply changes?')} [y/N] `)
      }),
  }
}

// ─── Command approval (Phase 4) ─────────────────────────────────────

/**
 * What the user is asked to approve when the policy says 'ask' for a
 * COMMAND (Phase 4). Carries the full context: the canonical command,
 * its risk, why, and the actual sandbox/network posture.
 */
export interface CommandApprovalRequest {
  /** Canonical human-readable command, e.g. "npm install jsonwebtoken". */
  readonly display: string
  readonly risk: CommandRisk
  /** Plain-language justification from the classifier/policy. */
  readonly reason: string
  /** Honest sandbox label, e.g. "RESTRICTED FALLBACK". */
  readonly sandboxLabel: string
  /** Network posture label, e.g. "DENIED". */
  readonly networkModeLabel: string
}

export interface CommandApprovalHandler {
  /** Resolve true to run the command. Must honour the abort signal. */
  approveCommand(
    request: CommandApprovalRequest,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>
}

/** Always approve — used only where the user's trust is explicit. */
export const autoCommandApprove: CommandApprovalHandler = {
  approveCommand: async () => true,
}

/** Always deny (safe default when no interactive handler is wired). */
export const denyCommand: CommandApprovalHandler = {
  approveCommand: async () => false,
}

/**
 * Interactive command approver. SAFE defaults to yes ([Y/n]); REVIEW
 * and DANGEROUS default to no ([y/N]). Closing stdin without input is
 * a rejection — the fail-closed default for non-interactive contexts.
 */
export function readlineCommandApprover(): CommandApprovalHandler {
  return {
    approveCommand: (request, options = {}) =>
      new Promise<boolean>((resolve) => {
        const out = process.stdout
        out.write('\n')
        out.write(`${theme.bold('☾ Lunar wants to run:')}\n\n`)
        out.write(`${theme.accent(request.display)}\n\n`)
        out.write(`Risk:    ${request.risk.toUpperCase()}\n`)
        out.write(`Sandbox: ${request.sandboxLabel}\n`)
        out.write(`Network: ${request.networkModeLabel}\n`)
        out.write(`\n${theme.bold('Reason:')}\n${request.reason}\n\n`)

        const defaultYes = request.risk === 'safe'
        const rl = readline.createInterface({ input: process.stdin, terminal: false })
        let settled = false
        const finish = (approved: boolean): void => {
          if (settled) return
          settled = true
          rl.close()
          options.signal?.removeEventListener('abort', onAbort)
          out.write('\n')
          resolve(approved)
        }
        const onAbort = (): void => finish(false)
        options.signal?.addEventListener('abort', onAbort, { once: true })
        rl.once('line', (line: string) => {
          const answer = line.trim().toLowerCase()
          if (answer === '') return finish(defaultYes)
          finish(answer === 'y' || answer === 'yes')
        })
        rl.once('close', () => finish(false))
        out.write(`${theme.brand(`Allow?`)} ${defaultYes ? '[Y/n]' : '[y/N]'} `)
      }),
  }
}
