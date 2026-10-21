import { theme } from '../ui/theme.js'
import { redactText } from '../utils/redact.js'

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

/** Write a partial chunk (no newline) — used for streamed responses. */
export function stdoutChunk(text: string): void {
  process.stdout.write(text)
}

/** Clear the current terminal line (no-op when stdout is not a TTY). */
export function clearLine(): void {
  if (process.stdout.isTTY === true) {
    process.stdout.write('\r\x1b[2K')
  }
}

/** Print a human-readable error with an optional hint. */
export function printError(message: string, hint?: string): void {
  stderr(`${theme.error('error')} ${redactText(message)}`)
  if (hint !== undefined) {
    stderr(theme.muted(`hint: ${redactText(hint)}`))
  }
}
