import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { Logger } from '../logging/logger.js'
import { createSilentLogger } from '../logging/logger.js'
import type { Workspace } from '../domain/types/workspace.js'
import { resolveWorkspacePath } from '../tools/path-security.js'
import { ToolError } from '../tools/errors.js'
import type { CommandRisk } from '../security/classifier.js'
import { resolveExecutable } from '../security/executable-resolver.js'
import { normalizeCommand } from '../security/normalizer.js'
import type { NormalizedCommand } from '../security/normalizer.js'
import type { NetworkMode } from '../security/network-policy.js'
import { DEFAULT_NETWORK_MODE, networkLabel } from '../security/network-policy.js'
import { CommandPolicy } from '../security/policy.js'
import type { CommandDecisionKind } from '../security/policy.js'
import { DEFAULT_ALLOWED_COMMANDS } from './limits.js'
import type { EngineeringLimits } from './limits.js'
import type { CommandApprovalHandler } from './approval.js'
import { denyCommand } from './approval.js'
import type { SandboxProvider } from './sandbox.js'
import { createSandbox } from './sandbox.js'

/**
 * Controlled command execution (Phase 3) with the Phase 4 security
 * pipeline. Still NOT exec(modelOutput): commands are structured
 * `executable + args[]` requests that pass every gate before anything
 * spawns:
 *
 *   normalize            canonical executable/args/cwd (NUL, paths,
 *                        reserved names rejected)
 *   hard deny            shells, transfer tools, LOLBins, git mutation,
 *                        destructive OS ops — checked before allowlist
 *   executable allowlist bare names only; no paths, no shells
 *   classification       per-command risk (executable AND arguments)
 *   policy               global + project overlay → allow/ask/deny
 *   permission           'ask' → the interactive gate (default deny)
 *   sandbox              workspace cwd, FILTERED environment, hard
 *                        timeout with process-tree termination
 *   resolve              bare name → ONE absolute path (no TOCTOU);
 *                        batch files (.cmd/.bat/.ps1) fail closed
 *   spawn                shell:false — args are never interpreted
 *
 * Every decision emits a CommandAuditEvent. Completed processes return
 * a structured CommandResult (any exit code); blocked or invalid
 * requests throw a controlled ToolError.
 */

export interface CommandRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface CommandResult {
  readonly executable: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly durationMs: number
  /** Whether stdout/stderr hit their capture caps (process killed). */
  readonly truncated: boolean
}

/** One observable step of the security pipeline (never carries secrets). */
export interface CommandAuditEvent {
  readonly type:
    | 'proposed'
    | 'normalized'
    | 'classified'
    | 'policy_evaluated'
    | 'permission_requested'
    | 'permission_granted'
    | 'permission_denied'
    | 'sandbox_prepared'
    | 'started'
    | 'completed'
    | 'timed_out'
    | 'blocked'
  /** Canonical human-readable command. */
  readonly command: string
  readonly risk?: CommandRisk
  readonly decision?: CommandDecisionKind
  readonly reason?: string
  readonly sandbox?: string
  readonly network?: boolean
  readonly exitCode?: number | null
  readonly durationMs?: number
  readonly timedOut?: boolean
  readonly truncated?: boolean
}

export interface CommandExecutorOptions {
  workspace: Workspace
  limits: EngineeringLimits
  logger?: Logger
  /** Overrides the built-in allowlist when non-empty. */
  allowedCommands?: readonly string[]
  /** Command policy (risk → decision). Defaults to the standard policy. */
  policy?: CommandPolicy
  /** Consulted when the policy says 'ask'. Defaults to denyCommand. */
  approval?: CommandApprovalHandler
  /** Sandbox backend. Defaults to the best available (restricted). */
  sandbox?: SandboxProvider
  /** Network policy mode (deny-by-default is the only Phase 4 mode). */
  networkMode?: NetworkMode
  /** Audit sink — every pipeline decision, for events and logging. */
  onAudit?: (event: CommandAuditEvent) => void
}

const KILL_GRACE_MS = 2_000

export class CommandExecutor {
  private readonly workspace: Workspace
  private readonly limits: EngineeringLimits
  private readonly logger: Logger
  private readonly allowed: Set<string>
  private readonly policy: CommandPolicy
  private readonly approval: CommandApprovalHandler
  private readonly sandbox: SandboxProvider
  private readonly networkMode: NetworkMode
  private readonly onAudit: (event: CommandAuditEvent) => void
  /** In-flight commands — enforces maxConcurrentCommands. */
  private active = 0

  constructor(options: CommandExecutorOptions) {
    this.workspace = options.workspace
    this.limits = options.limits
    this.logger = options.logger ?? createSilentLogger()
    const configured = options.allowedCommands ?? this.limits.allowedCommands
    const list = configured.length > 0 ? configured : DEFAULT_ALLOWED_COMMANDS
    this.allowed = new Set(list.map((name) => name.toLowerCase()))
    this.policy = options.policy ?? new CommandPolicy()
    this.approval = options.approval ?? denyCommand
    this.sandbox = options.sandbox ?? createSandbox('auto', { logger: this.logger })
    this.networkMode = options.networkMode ?? DEFAULT_NETWORK_MODE
    this.onAudit = options.onAudit ?? (() => {})
  }

  /** Validate an executable against the allowlist (bare names only). */
  validateExecutable(executable: string): void {
    if (
      executable === '' ||
      /[\\/]/.test(executable) ||
      path.isAbsolute(executable) ||
      executable.includes(':')
    ) {
      throw new ToolError(
        'invalid_input',
        `Command must be a bare executable name, got: ${executable}`,
        { hint: 'Paths and shell syntax are not allowed.' },
      )
    }
    if (!this.allowed.has(executable.toLowerCase())) {
      throw new ToolError(
        'permission_denied',
        `Executable not allowed: ${executable}`,
        { hint: `Allowed: ${[...this.allowed].sort().join(', ')}` },
      )
    }
  }

  /**
   * Run one command through the full security pipeline. Never uses a
   * shell. Throws a controlled ToolError when any gate refuses.
   */
  async run(request: CommandRequest, options: { signal?: AbortSignal } = {}): Promise<CommandResult> {
    const rawDisplay = `${request.executable} ${request.args.join(' ')}`.trim()
    this.audit({ type: 'proposed', command: rawDisplay })

    // ── NORMALIZE ──────────────────────────────────────────────────
    const command: NormalizedCommand = normalizeCommand(request)
    this.audit({ type: 'normalized', command: command.display })

    // ── CWD VALIDATION (before any approval — invalid input first) ─
    const cwd = resolveWorkspacePath(this.workspace.root, request.cwd ?? '.')
    const stat = fs.statSync(cwd)
    if (!stat.isDirectory()) {
      throw new ToolError('not_a_file', `Command cwd is not a directory: ${request.cwd ?? '.'}`)
    }

    // ── CLASSIFY + POLICY (hard deny included) ─────────────────────
    const decision = this.policy.evaluate(command)
    this.audit({
      type: 'classified',
      command: command.display,
      risk: decision.risk,
      reason: decision.reason,
      network: decision.network,
    })
    this.audit({
      type: 'policy_evaluated',
      command: command.display,
      risk: decision.risk,
      decision: decision.decision,
      reason: decision.reason,
    })

    // ── PERMISSION ─────────────────────────────────────────────────
    if (decision.decision === 'deny') {
      this.audit({
        type: 'blocked',
        command: command.display,
        risk: decision.risk,
        decision: 'deny',
        reason: decision.reason,
      })
      throw new ToolError('permission_denied', `Command denied: ${command.display}`, {
        hint: decision.reason,
        details: { risk: decision.risk, source: decision.source },
      })
    }

    // ── ALLOWLIST (Phase 3 gate — after deny, before any prompt) ──
    try {
      this.validateExecutable(command.executable)
    } catch (error) {
      this.audit({
        type: 'blocked',
        command: command.display,
        risk: decision.risk,
        decision: 'deny',
        reason: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    if (decision.decision === 'ask') {
      this.audit({
        type: 'permission_requested',
        command: command.display,
        risk: decision.risk,
        reason: decision.reason,
      })
      const approved = await this.approval.approveCommand(
        {
          display: command.display,
          risk: decision.risk,
          reason: decision.reason,
          sandboxLabel: this.sandbox.describe().label,
          networkModeLabel: networkLabel(this.networkMode),
        },
        { ...(options.signal !== undefined ? { signal: options.signal } : {}) },
      )
      if (!approved) {
        this.audit({
          type: 'permission_denied',
          command: command.display,
          risk: decision.risk,
          reason: 'The user declined the command.',
        })
        this.audit({
          type: 'blocked',
          command: command.display,
          risk: decision.risk,
          decision: 'deny',
          reason: 'The user declined the command.',
        })
        throw new ToolError('permission_denied', `Command not approved: ${command.display}`, {
          hint: decision.reason,
        })
      }
    }
    this.audit({
      type: 'permission_granted',
      command: command.display,
      risk: decision.risk,
      decision: decision.decision,
    })

    // ── SANDBOX (workspace cwd + filtered environment) ─────────────
    const context = await this.sandbox.prepare(this.workspace, {
      cwd: command.cwd,
      timeoutMs: this.effectiveTimeout(request),
      maxOutputBytes: this.limits.maxOutputBytes,
    })
    this.audit({
      type: 'sandbox_prepared',
      command: command.display,
      sandbox: this.sandbox.describe().label,
    })

    // ── CONCURRENCY GUARD ──────────────────────────────────────────
    if (this.active >= this.limits.maxConcurrentCommands) {
      throw new ToolError(
        'execution_error',
        `Concurrent command limit reached (${this.limits.maxConcurrentCommands}).`,
      )
    }

    // ── RESOLVE (one absolute path — classification cannot drift) ──
    const executablePath = resolveExecutable(command.executable, context.env)

    // ── EXECUTE (shell:false, filtered env, tree-kill on timeout) ──
    this.active += 1
    this.audit({
      type: 'started',
      command: command.display,
      risk: decision.risk,
      sandbox: this.sandbox.describe().label,
      network: decision.network,
    })
    try {
      return await this.spawnIsolated(command, executablePath, context, options)
    } finally {
      this.active -= 1
      await this.sandbox.cleanup(context).catch(() => {})
    }
  }

  /** Effective timeout: request-bounded by the configured hard cap. */
  private effectiveTimeout(request: CommandRequest): number {
    return Math.min(
      Math.max(request.timeoutMs ?? this.limits.commandTimeoutMs, 100),
      this.limits.commandTimeoutMs,
    )
  }

  /** The spawn itself — isolated in one place, always shell:false. */
  private spawnIsolated(
    command: NormalizedCommand,
    executablePath: string,
    context: { cwd: string; env: Record<string, string>; timeoutMs: number; maxOutputBytes: number },
    options: { signal?: AbortSignal },
  ): Promise<CommandResult> {
    const startedAt = Date.now()
    return new Promise<CommandResult>((resolve, reject) => {
      let child
      try {
        child = spawn(executablePath, [...command.args], {
          cwd: context.cwd,
          env: context.env, // filtered — nothing else is inherited
          shell: false, // critical: arguments are never interpreted
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // POSIX: own process group, so the whole tree can be killed.
          ...(process.platform === 'win32' ? {} : { detached: true }),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
      } catch (error) {
        reject(
          new ToolError('execution_error', `Failed to spawn ${command.executable}: ${String(error)}`, {
            cause: error,
          }),
        )
        return
      }

      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let timedOut = false
      let truncated = false
      let settled = false

      const killTree = (): void => {
        // Kill the whole tree — a timed-out parent must not leave an
        // uncontrolled child running (best-effort, platform-aware).
        void this.sandbox.terminateTree(child.pid)
        child.kill()
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL')
        }, KILL_GRACE_MS).unref?.()
      }
      const timer = setTimeout(() => {
        timedOut = true
        this.audit({ type: 'timed_out', command: command.display })
        killTree()
      }, context.timeoutMs)

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk)
        if (stdoutBytes > context.maxOutputBytes) {
          truncated = true
          killTree()
          return
        }
        stdout += chunk
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > context.maxOutputBytes) {
          truncated = true
          killTree()
          return
        }
        stderr += chunk
      })

      child.once('error', (error: NodeJS.ErrnoException) => {
        settle(() => {
          if (error.code === 'ENOENT') {
            reject(
              new ToolError('execution_error', `Executable not found on PATH: ${command.executable}`, {
                hint: 'Install it or choose a different verification command.',
              }),
            )
          } else {
            reject(
              new ToolError('execution_error', `${command.executable} failed to start: ${error.message}`, {
                cause: error,
              }),
            )
          }
        })
      })

      child.once('close', (code: number | null) => {
        settle(() => {
          if (options.signal?.aborted === true) {
            reject(new ToolError('cancelled', 'Command was cancelled.'))
            return
          }
          const durationMs = Date.now() - startedAt
          this.audit({
            type: 'completed',
            command: command.display,
            exitCode: code,
            durationMs,
            timedOut,
            truncated,
          })
          this.logger.debug('Command finished', {
            command: command.display,
            exitCode: code,
            timedOut,
            truncated,
            durationMs,
          })
          resolve({
            // The ORIGINAL request identity is preserved in the result
            // for display; execution used the resolved absolute path.
            executable: command.executable,
            args: command.args,
            exitCode: code,
            stdout,
            stderr,
            timedOut,
            durationMs,
            truncated,
          })
        })
      })
    })
  }

  /** Emit one audit event to the sink and the debug log. */
  private audit(event: CommandAuditEvent): void {
    this.onAudit(event)
    this.logger.debug('command.audit', { ...event })
  }
}
