import { theme } from '../ui/theme.js'

/**
 * Explicit stdout/stderr writers for user-facing CLI output.
 *
 * The TUI owns stdout while it is mounted; these helpers are for
 * non-interactive commands (`doctor`, task passthrough) and top-level
 * error reporting.
 */

export function stdout(text: string): void {
  process.stdout.write(`${text}\n`)
}

export function stderr(text: string): void {
  process.stderr.write(`${text}\n`)
}

/** Print a human-readable error with an optional hint. */
export function printError(message: string, hint?: string): void {
  stderr(`${theme.error('error')} ${message}`)
  if (hint !== undefined) {
    stderr(theme.muted(`hint: ${hint}`))
  }
}
