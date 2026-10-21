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

/** Patterns for secret-shaped substrings that may appear inside text. */
const INLINE_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g, // OpenAI / Anthropic style keys
  /\bAIza[0-9A-Za-z_-]{10,}\b/g, // Google API keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization header values
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/gi, // Slack-style tokens
]

/** Scrub secret-shaped substrings out of free-form text (logs, errors). */
export function redactText(text: string): string {
  let result = text
  for (const pattern of INLINE_SECRET_PATTERNS) {
    result = result.replace(pattern, '[redacted]')
  }
  return result
}
