import path from 'node:path'

import { ToolError } from '../tools/errors.js'

/**
 * Command normalization (Phase 4).
 *
 * Classification is only meaningful on a canonical representation, so
 * every command request is normalized BEFORE it is classified:
 *
 *   executable   bare name, lowercased, platform extension stripped
 *                (.exe/.cmd/… — `cmd.exe` and `cmd` normalize alike,
 *                so the hard-deny list cannot be dodged by spelling)
 *   args         trimmed of incidental whitespace, NUL-checked
 *   cwd          canonical relative form ('.' for the workspace root)
 *   display      the human-readable "npm test" form, also used as the
 *                exact-match key for project command policies
 *
 * Normalization deliberately does NOT touch argument content beyond
 * trimming: metacharacters stay DATA because the executor spawns with
 * `shell: false`. Stripping or rewriting them would hide intent from
 * the classifier, so meaningful security distinctions are preserved.
 */

/** A canonical command request, produced by `normalizeCommand`. */
export interface NormalizedCommand {
  /** Bare, lowercased executable name (no path, no extension). */
  readonly executable: string
  /** Trimmed arguments, in order. */
  readonly args: readonly string[]
  /** Canonical workspace-relative cwd ('.' for the root). */
  readonly cwd: string
  /** Human-readable form, e.g. "npm test" — also the policy match key. */
  readonly display: string
}

/** Windows reserved device names — never valid executables or cwds. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Platform suffixes stripped during normalization (never launchable without a shell). */
const EXECUTABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat', '.ps1', '.vbs', '.js']

/** Maximum arguments accepted before the request is structurally invalid. */
export const MAX_COMMAND_ARGS = 32

/** Maximum characters in a single argument. */
export const MAX_COMMAND_ARG_CHARS = 4096

/**
 * Normalize a raw command request. Throws a controlled `ToolError`
 * for structurally invalid requests — nothing invalid reaches the
 * classifier or the executor.
 */
export function normalizeCommand(request: {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
}): NormalizedCommand {
  const executable = normalizeExecutable(request.executable)
  const args = normalizeArgs(request.args)
  const cwd = normalizeCwd(request.cwd)
  return { executable, args, cwd, display: formatCommand(executable, args) }
}

/** Canonical "executable arg1 arg2" form (also the policy match key). */
export function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].join(' ').trim()
}

function normalizeExecutable(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ToolError('invalid_input', 'Command executable must be a non-empty string.')
  }
  const value = raw.trim()
  if (value.includes('\0')) {
    throw new ToolError('invalid_input', 'Executable contains an illegal NUL byte.')
  }
  if (/\s/.test(value)) {
    throw new ToolError('invalid_input', `Executable must be a single bare name, got: ${value}`, {
      hint: 'Arguments belong in the args array, never in the executable.',
    })
  }
  if (/[\\/]/.test(value) || path.isAbsolute(value) || value.includes(':')) {
    throw new ToolError('invalid_input', `Command must be a bare executable name, got: ${value}`, {
      hint: 'Paths and shell syntax are not allowed.',
    })
  }
  if (/["']/.test(value)) {
    throw new ToolError('invalid_input', 'Executable must not contain quote characters.')
  }

  // Strip a platform extension so `cmd.exe`/`CMD.CMD` normalize onto the
  // hard-deny name `cmd` — spelling cannot dodge the deny list.
  let name = value
  const lower = value.toLowerCase()
  for (const extension of EXECUTABLE_EXTENSIONS) {
    if (lower.endsWith(extension) && value.length > extension.length) {
      name = value.slice(0, -extension.length)
      break
    }
  }
  if (name === '') {
    throw new ToolError('invalid_input', `Invalid executable name: ${value}`)
  }
  if (WINDOWS_RESERVED.test(name)) {
    throw new ToolError('invalid_input', `"${name}" is a reserved system name, not a command.`)
  }
  return name.toLowerCase()
}

function normalizeArgs(raw: readonly string[]): string[] {
  if (!Array.isArray(raw)) {
    throw new ToolError('invalid_input', 'Command args must be an array of strings.')
  }
  if (raw.length > MAX_COMMAND_ARGS) {
    throw new ToolError('invalid_input', `Too many arguments (limit ${MAX_COMMAND_ARGS}).`)
  }
  return raw.map((arg) => {
    if (typeof arg !== 'string') {
      throw new ToolError('invalid_input', 'Every argument must be a string.')
    }
    if (arg.includes('\0')) {
      throw new ToolError('invalid_input', 'Argument contains an illegal NUL byte.')
    }
    if (arg.length > MAX_COMMAND_ARG_CHARS) {
      throw new ToolError('invalid_input', `Argument exceeds ${MAX_COMMAND_ARG_CHARS} characters.`)
    }
    // Trim incidental whitespace only — content is left untouched.
    return arg.trim()
  })
}

function normalizeCwd(raw: string | undefined): string {
  if (raw === undefined) return '.'
  if (typeof raw !== 'string') {
    throw new ToolError('invalid_input', 'Command cwd must be a string.')
  }
  const value = raw.trim()
  if (value.includes('\0')) {
    throw new ToolError('invalid_input', 'cwd contains an illegal NUL byte.')
  }
  if (value === '') return '.'
  // Canonical separators and collapsed duplicates; containment is still
  // enforced later by resolveWorkspacePath (this is representation only).
  const canonical = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  return canonical === '' ? '.' : canonical
}
