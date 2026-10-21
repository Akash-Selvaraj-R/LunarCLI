import { spawn } from 'node:child_process'

import type { Workspace } from '../domain/types/workspace.js'
import type { Logger } from '../logging/logger.js'
import { createSilentLogger } from '../logging/logger.js'
import { ToolError } from '../tools/errors.js'
import { resolveWorkspacePath } from '../tools/path-security.js'
import { filterEnvironment } from '../security/environment.js'

/**
 * Sandbox abstraction (Phase 4).
 *
 * Platform-neutral on purpose: the agent and executor speak only this
 * interface, so platform-specific isolation mechanics never leak into
 * the engineering loop.
 *
 * HONEST SECURITY LEVELS — this phase never claims more than it
 * enforces:
 *
 *   full         OS-level isolation (namespaces, Job Objects with
 *                restrictions, containers). NOT available yet.
 *   restricted   what Lunar actually enforces today: workspace-bound
 *                cwd, filtered environment, hard timeout with
 *                PROCESS-TREE termination, bounded output. No
 *                OS-level filesystem or network isolation.
 *   unavailable  execution is denied (fail-closed mode).
 *
 * Network policy is enforced at the classification/policy layer (deny
 * by default); the restricted sandbox does NOT provide OS-level
 * network blocking. Doctor and the approval UX report the real level —
 * never "ENABLED" for the restricted fallback.
 */

export type SandboxLevel = 'full' | 'restricted' | 'unavailable'

export interface SandboxDescription {
  readonly level: SandboxLevel
  /** Display label, e.g. "RESTRICTED FALLBACK". */
  readonly label: string
  /** What the level actually enforces (or why it is unavailable). */
  readonly detail: string
}

export interface SandboxRequest {
  /** Workspace-relative cwd ('.' for the root). */
  readonly cwd: string
  /** Hard wall-clock limit for the command. */
  readonly timeoutMs: number
  /** Capture cap per output stream. */
  readonly maxOutputBytes: number
}

export interface SandboxContext {
  readonly level: SandboxLevel
  /** Absolute, workspace-contained working directory. */
  readonly cwd: string
  /** The exact environment handed to the child. */
  readonly env: Record<string, string>
  /** Names of dropped secret-looking variables (names only). */
  readonly removedEnvKeys: readonly string[]
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export interface SandboxProvider {
  readonly id: string
  /** The honest security posture — never overstated. */
  describe(): SandboxDescription
  /** Prepare the execution context (validates boundaries). */
  prepare(workspace: Workspace, request: SandboxRequest): Promise<SandboxContext>
  /** Kill the whole process tree — a timed-out parent leaves nothing behind. */
  terminateTree(pid: number | undefined): Promise<void>
  /** Release anything held for the context. */
  cleanup(context: SandboxContext): Promise<void>
}

const LABELS: Readonly<Record<SandboxLevel, string>> = {
  full: 'ENABLED',
  restricted: 'RESTRICTED FALLBACK',
  unavailable: 'UNAVAILABLE — execution denied',
}

/**
 * The sandbox Lunar actually provides today. Enforces what a
 * restricted child process CAN enforce without OS-specific native
 * dependencies, and is honest about the rest.
 */
export class RestrictedSandbox implements SandboxProvider {
  readonly id = 'restricted'
  private readonly logger: Logger

  constructor(options: { logger?: Logger } = {}) {
    this.logger = options.logger ?? createSilentLogger()
  }

  describe(): SandboxDescription {
    return {
      level: 'restricted',
      label: LABELS.restricted,
      detail:
        'workspace-bound cwd, filtered environment, hard timeout with process-tree ' +
        'termination, bounded output. No OS-level filesystem or network isolation.',
    }
  }

  async prepare(workspace: Workspace, request: SandboxRequest): Promise<SandboxContext> {
    // Workspace containment — same Phase 2/3 boundary as every tool path.
    const cwd = resolveWorkspacePath(workspace.root, request.cwd)
    // Only the current directory survives; a cwd that vanished fails here.
    // (resolveWorkspacePath already guarantees containment.)
    const filtered = filterEnvironment(process.env)
    this.logger.debug('Sandbox prepared', {
      level: 'restricted',
      cwd,
      droppedEnv: filtered.removedCount,
      droppedSensitive: filtered.removedSensitive,
    })
    return {
      level: 'restricted',
      cwd,
      env: filtered.env,
      removedEnvKeys: filtered.removedSensitive,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    }
  }

  /**
   * Terminate the entire process tree. Best-effort but REAL:
   * - Windows: `taskkill /T /F` (an internal OS utility, never a
   *   model-proposed command) kills the tree;
   * - POSIX: the child is spawned detached (own process group) and the
   *   whole group receives the signal.
   */
  async terminateTree(pid: number | undefined): Promise<void> {
    if (pid === undefined) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
          // Even Lunar's internal helper spawn gets the filtered env.
          env: filterEnvironment(process.env).env,
        })
        killer.once('close', () => resolve())
        killer.once('error', () => resolve()) // best effort
      })
      return
    }
    try {
      // Negative pid = process group (child was spawned detached).
      process.kill(-pid, 'SIGTERM')
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }, 2_000).unref?.()
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }

  async cleanup(_context: SandboxContext): Promise<void> {
    // Nothing to release today — kept for interface stability so future
    // sandbox backends (Job Objects, containers) fit without churn.
  }
}

/**
 * Fail-closed sandbox for `security.sandbox: "deny"`: when no FULL
 * sandbox is available (i.e. always, in Phase 4), command execution is
 * refused outright rather than pretending to be isolated.
 */
export class DenySandbox implements SandboxProvider {
  readonly id = 'deny'

  describe(): SandboxDescription {
    return {
      level: 'unavailable',
      label: LABELS.unavailable,
      detail: 'A full sandbox is not available on this platform; execution is denied.',
    }
  }

  async prepare(_workspace: Workspace, _request: SandboxRequest): Promise<SandboxContext> {
    throw new ToolError(
      'permission_denied',
      'Command execution denied: security.sandbox is "deny" and no full sandbox is available.',
      { hint: 'Set security.sandbox to "auto" to use the restricted fallback.' },
    )
  }

  async terminateTree(): Promise<void> {}
  async cleanup(): Promise<void> {}
}

/** Sandbox mode as configurable in `security.sandbox`. */
export type SandboxMode = 'auto' | 'restricted' | 'deny'

/**
 * Create the sandbox for a mode. Both 'auto' and 'restricted' resolve
 * to the restricted fallback until a full sandbox backend exists.
 */
export function createSandbox(mode: SandboxMode = 'auto', options: { logger?: Logger } = {}): SandboxProvider {
  return mode === 'deny' ? new DenySandbox() : new RestrictedSandbox(options)
}
