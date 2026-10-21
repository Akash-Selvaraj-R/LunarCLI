import fs from 'node:fs'
import path from 'node:path'

import { ToolError } from '../tools/errors.js'

/**
 * Executable resolution (Phase 4).
 *
 * Lunar resolves a bare, allowlisted executable name to ONE absolute
 * path itself, then spawns that exact path. This:
 *
 * - closes the TOCTOU gap between "what we classified" and "what
 *   actually runs" (the resolved path is fixed before spawn);
 * - lets Windows fail CLOSED on `.cmd`/`.bat`/`.ps1` targets instead of
 *   silently routing through cmd.exe — Lunar never launches a shell,
 *   and batch files are shell scripts;
 * - replaces the bare ENOENT with an actionable error.
 *
 * Platform reality: on Windows, npm ships as `npm.cmd` (no npm.exe in
 * standard installs). Lunar refuses to execute batch files, so npm-based
 * verification is unavailable there — surfaced as a clear, controlled
 * error, never a silent shell fallback.
 */

/** Extensions Lunar will launch without a shell, per platform. */
const WINDOWS_LAUNCHABLE = ['.exe', '.com']
const POSIX_LAUNCHABLE = ['']

/** Suffixes that indicate a script requiring a shell — always refused. */
const SCRIPT_SUFFIXES = ['.cmd', '.bat', '.ps1', '.vbs']

/**
 * Resolve a bare executable name against the (already filtered)
 * environment's PATH. Returns the absolute path to launch, or throws a
 * controlled ToolError.
 */
export function resolveExecutable(
  executable: string,
  env: Record<string, string>,
): string {
  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  const directories = pathValue.split(path.delimiter).filter((entry) => entry !== '')
  const isWindows = process.platform === 'win32'
  const launchable = isWindows ? WINDOWS_LAUNCHABLE : POSIX_LAUNCHABLE
  const scriptSuffix = isWindows ? SCRIPT_SUFFIXES : []

  let sawScriptOnly = false
  for (const directory of directories) {
    for (const suffix of launchable) {
      const candidate = path.join(directory, `${executable}${suffix}`)
      if (isRegularFile(candidate)) return candidate
    }
    for (const suffix of scriptSuffix) {
      const candidate = path.join(directory, `${executable}${suffix}`)
      if (isRegularFile(candidate)) {
        sawScriptOnly = true
        break
      }
    }
  }

  if (sawScriptOnly) {
    throw new ToolError(
      'permission_denied',
      `"${executable}" resolves to a batch/script file on this platform.`,
      {
        hint:
          'Lunar never executes batch files or shells. Provide a native executable ' +
          '(e.g. npm.exe) or use a direct toolchain command on the allowlist.',
      },
    )
  }

  throw new ToolError('execution_error', `Executable not found on PATH: ${executable}`, {
    hint: 'Install it or choose a different verification command.',
  })
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}
