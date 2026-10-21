import { spawn } from 'node:child_process'

import { ToolError } from '../tools/errors.js'

/**
 * Controlled git adapter.
 *
 * Git read-only inspection runs through the git executable with an
 * explicitly constructed argument vector — never a shell, never a
 * string the model influenced. Callers pass literal argument arrays;
 * model input only ever appears as a single, pre-validated argument
 * value (e.g. a commit count number parsed from a Zod schema), never as
 * command text.
 *
 * There is intentionally no generic runCommand export: this module
 * knows the `git` executable and nothing else.
 */

export interface GitRunOptions {
  /** Working directory (the workspace root). */
  cwd: string
  /** Literal arguments — e.g. ["status", "--porcelain=v1", "-b"]. */
  args: readonly string[]
  signal?: AbortSignal
  timeoutMs?: number
  /** Cap on captured stdout; exceeding it kills the process (default 1 MB). */
  maxBytes?: number
}

export interface GitRunResult {
  stdout: string
  /** Whether the output cap or timeout ended the process early. */
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 1024 * 1024

/** Run `git` with a fixed argument vector. Never uses a shell. */
export async function runGit(options: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  return new Promise<GitRunResult>((resolve, reject) => {
    let child
    try {
      child = spawn('git', [...options.args], {
        cwd: options.cwd,
        shell: false, // critical: arguments are never interpreted by a shell
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: options.signal,
      })
    } catch (error) {
      reject(toGitError(error, options.args))
      return
    }

    let stdout = ''
    let stderr = ''
    let bytes = 0
    let truncated = false
    let settled = false

    const timer = setTimeout(() => {
      truncated = true
      child.kill()
    }, timeoutMs)

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxBytes) {
        truncated = true
        child.kill()
        return
      }
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk
    })

    child.once('error', (error: NodeJS.ErrnoException) => {
      settle(() => {
        if (error.code === 'ENOENT') {
          reject(
            new ToolError('execution_error', 'The git executable was not found on PATH.', {
              hint: 'Install git to use the git inspection tools.',
            }),
          )
        } else {
          reject(toGitError(error, options.args))
        }
      })
    })

    child.once('close', (code: number | null) => {
      settle(() => {
        if (options.signal?.aborted === true) {
          reject(new ToolError('cancelled', 'Git command was cancelled.'))
          return
        }
        if (truncated) {
          // Killed for size/time: surface what we have as a bounded result.
          resolve({ stdout, truncated: true })
          return
        }
        if (code !== 0) {
          const detail = stderr.trim().split('\n')[0] ?? ''
          reject(
            new ToolError(
              'execution_error',
              `git ${options.args[0] ?? ''} failed${detail !== '' ? `: ${detail}` : ''}`,
              { details: { exitCode: code } },
            ),
          )
          return
        }
        resolve({ stdout, truncated: false })
      })
    })
  })
}

function toGitError(error: unknown, args: readonly string[]): ToolError {
  const message = error instanceof Error ? error.message : String(error)
  return new ToolError('execution_error', `git ${args[0] ?? ''} failed: ${message}`, {
    cause: error,
  })
}
