import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { Logger } from '../logging/logger.js'
import { createSilentLogger } from '../logging/logger.js'
import type { Workspace } from '../domain/types/workspace.js'
import { resolveWorkspacePath } from '../tools/path-security.js'
import { ToolError } from '../tools/errors.js'
import { DEFAULT_ALLOWED_COMMANDS } from './limits.js'
import type { EngineeringLimits } from './limits.js'

/**
 * Controlled command execution (Phase 3).
 *
 * This is NOT exec(modelOutput). Commands are structured
 * `executable + args[]` requests that pass every gate before anything
 * spawns:
 *
 *   executable allowlist   bare names only; no paths, no shells
 *   argument bounds        count and size caps
 *   workspace cwd          resolved through the Phase 2 boundary
 *   timeout                hard kill after the configured duration
 *   output caps            stdout/stderr bounded; overflow kills
 *   no shell               spawn with shell:false — args are never
 *                          interpreted, so injection is impossible
 *
 * Completed processes return a structured CommandResult (any exit
 * code). Infrastructure problems throw a controlled ToolError.
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

export interface CommandExecutorOptions {
  workspace: Workspace
  limits: EngineeringLimits
  logger?: Logger
  /** Overrides the built-in allowlist when non-empty. */
  allowedCommands?: readonly string[]
}

const MAX_ARGS = 32
const MAX_ARG_CHARS = 4096
const KILL_GRACE_MS = 2_000

export class CommandExecutor {
  private readonly workspace: Workspace
  private readonly limits: EngineeringLimits
  private readonly logger: Logger
  private readonly allowed: Set<string>

  constructor(options: CommandExecutorOptions) {
    this.workspace = options.workspace
    this.limits = options.limits
    this.logger = options.logger ?? createSilentLogger()
    const configured = options.allowedCommands ?? this.limits.allowedCommands
    const list = configured.length > 0 ? configured : DEFAULT_ALLOWED_COMMANDS
    this.allowed = new Set(list.map((name) => name.toLowerCase()))
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

  /** Run one command. Never uses a shell. */
  async run(request: CommandRequest, options: { signal?: AbortSignal } = {}): Promise<CommandResult> {
    this.validateExecutable(request.executable)

    if (request.args.length > MAX_ARGS) {
      throw new ToolError('invalid_input', `Too many arguments (limit ${MAX_ARGS}).`)
    }
    for (const arg of request.args) {
      if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS) {
        throw new ToolError('invalid_input', `Argument exceeds ${MAX_ARG_CHARS} characters.`)
      }
    }

    // Working directory must exist inside the workspace.
    const cwd = resolveWorkspacePath(this.workspace.root, request.cwd ?? '.')
    const stat = fs.statSync(cwd)
    if (!stat.isDirectory()) {
      throw new ToolError('not_a_file', `Command cwd is not a directory: ${request.cwd ?? '.'}`)
    }

    const timeoutMs = Math.min(
      Math.max(request.timeoutMs ?? this.limits.commandTimeoutMs, 100),
      this.limits.commandTimeoutMs,
    )

    const startedAt = Date.now()
    return new Promise<CommandResult>((resolve, reject) => {
      let child
      try {
        child = spawn(request.executable, [...request.args], {
          cwd,
          shell: false, // critical: arguments are never interpreted
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
      } catch (error) {
        reject(
          new ToolError('execution_error', `Failed to spawn ${request.executable}: ${String(error)}`, {
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

      const kill = (): void => {
        child.kill()
        // Escalate if the process ignores the first signal.
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL')
        }, KILL_GRACE_MS).unref?.()
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk)
        if (stdoutBytes > this.limits.maxOutputBytes) {
          truncated = true
          kill()
          return
        }
        stdout += chunk
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > this.limits.maxOutputBytes) {
          truncated = true
          kill()
          return
        }
        stderr += chunk
      })

      child.once('error', (error: NodeJS.ErrnoException) => {
        settle(() => {
          if (error.code === 'ENOENT') {
            reject(
              new ToolError('execution_error', `Executable not found on PATH: ${request.executable}`, {
                hint: 'Install it or choose a different verification command.',
              }),
            )
          } else {
            reject(
              new ToolError('execution_error', `${request.executable} failed to start: ${error.message}`, {
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
          this.logger.debug('Command finished', {
            command: `${request.executable} ${request.args.join(' ')}`,
            exitCode: code,
            timedOut,
            truncated,
            durationMs,
          })
          resolve({
            executable: request.executable,
            args: request.args,
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
}
