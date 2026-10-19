/**
 * Secret redaction for logs and debug output.
 *
 * Rule: LunarCLI never prints API keys. Debug output passes through
 * `redactSecrets` so that a config object accidentally interpolated into a
 * log line cannot leak a credential.
 */

const SECRET_PATTERN = /(api[-_ ]?key|token|secret|password|credential)/i

/** Mask the value of any key whose name looks secret-bearing. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SECRET_PATTERN.test(key) && entry != null ? '[redacted]' : redactSecrets(entry)
    }
    return result
  }
  return value
}

/** Render an unknown thrown value as a string safe for logging. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
