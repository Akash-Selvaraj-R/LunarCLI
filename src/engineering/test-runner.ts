import fs from 'node:fs'
import path from 'node:path'

import type { Workspace } from '../domain/types/workspace.js'
import type { CommandExecutor, CommandRequest } from './command.js'

/**
 * Controlled test runner (Phase 3).
 *
 * Verification commands are detected from the REPOSITORY (manifests),
 * never invented by the model and never shell strings. Detection is
 * best-effort across common ecosystems; when nothing is detected the
 * loop falls back to filesystem verification only.
 *
 * Results are structured (exit code, pass/fail counts when parseable,
 * duration) with raw stdout/stderr always preserved for diagnosis.
 */

export interface TestSummary {
  /** Human-readable command, e.g. "npm test". */
  readonly command: string
  readonly exitCode: number | null
  readonly passed?: number
  readonly failed?: number
  readonly timedOut: boolean
  readonly durationMs: number
  readonly truncated: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Detect the repository's test command from its manifests. */
export function detectTestCommand(workspace: Workspace): CommandRequest | undefined {
  const root = workspace.root

  // Node: package.json "test" script (skip the npm placeholder).
  const packageJson = readJson(path.join(root, 'package.json'))
  const testScript = (packageJson?.scripts as Record<string, unknown> | undefined)?.['test']
  if (typeof testScript === 'string' && !testScript.startsWith('Error: no test specified')) {
    return { executable: 'npm', args: ['test'], cwd: '.' }
  }

  // Rust
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    return { executable: 'cargo', args: ['test'], cwd: '.' }
  }

  // Go
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    return { executable: 'go', args: ['test', './...'], cwd: '.' }
  }

  // Python (pytest configuration).
  if (fs.existsSync(path.join(root, 'pytest.ini'))) {
    return { executable: 'pytest', args: [], cwd: '.' }
  }
  const pyproject = safeRead(path.join(root, 'pyproject.toml'))
  if (pyproject !== undefined && pyproject.includes('[tool.pytest')) {
    return { executable: 'pytest', args: [], cwd: '.' }
  }

  // Makefile with a test target.
  const makefile = safeRead(path.join(root, 'Makefile')) ?? safeRead(path.join(root, 'makefile'))
  if (makefile !== undefined && /^\s*test\s*:/m.test(makefile)) {
    return { executable: 'make', args: ['test'], cwd: '.' }
  }

  return undefined
}

/** Execute the verification command and summarize the result. */
export async function runTests(
  executor: CommandExecutor,
  request: CommandRequest,
  options: { signal?: AbortSignal } = {},
): Promise<TestSummary> {
  const result = await executor.run(request, options)
  const output = `${result.stdout}\n${result.stderr}`
  return {
    command: `${result.executable} ${result.args.join(' ')}`.trim(),
    exitCode: result.exitCode,
    ...parseCounts(output),
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    truncated: result.truncated,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/**
 * Basic pass/fail extraction from common runner output (vitest, jest,
 * pytest, cargo). Takes the LAST match, since summary lines come last.
 * Undetermined counts stay undefined — the exit code is always
 * authoritative.
 */
export function parseCounts(output: string): { passed?: number; failed?: number } {
  const passed = lastCount(output, /(\d+)\s+passed\b/gi)
  const failed = lastCount(output, /(\d+)\s+failed\b/gi)
  return {
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
  }
}

/** Last numeric capture of the pattern, or undefined. */
function lastCount(output: string, pattern: RegExp): number | undefined {
  let value: number | undefined
  for (const match of output.matchAll(pattern)) {
    const parsed = Number.parseInt(match[1] ?? '', 10)
    if (Number.isFinite(parsed)) value = parsed
  }
  return value
}

function readJson(absolutePath: string): Record<string, unknown> | undefined {
  const raw = safeRead(absolutePath)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Malformed manifest — treated as absent.
  }
  return undefined
}

function safeRead(absolutePath: string): string | undefined {
  try {
    return fs.readFileSync(absolutePath, 'utf8')
  } catch {
    return undefined
  }
}
