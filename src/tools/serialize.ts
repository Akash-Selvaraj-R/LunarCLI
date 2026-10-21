import type { ToolResult } from '../domain/types/index.js'

/**
 * Tool result serialization for the model.
 *
 * Providers receive tool results as text. Structured output becomes
 * compact JSON; failures become a clear ERROR line. Serialization is
 * always bounded — the model never receives unbounded tool output.
 */

/** Default cap on a single serialized tool result. */
export const DEFAULT_RESULT_CHAR_LIMIT = 50_000

/** Mark appended when serialized output had to be cut. */
export function truncationMarker(shown: number, total: number): string {
  return `\n[Output truncated: ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters shown]`
}

/** Serialize a tool result to bounded, model-readable text. */
export function serializeToolResult(
  result: ToolResult,
  charLimit: number = DEFAULT_RESULT_CHAR_LIMIT,
): string {
  let text: string
  if (!result.success) {
    const error = result.error
    text = `ERROR (${error?.kind ?? 'execution_error'}): ${error?.message ?? 'Tool failed.'}`
    if (error?.hint !== undefined) text += `\nHint: ${error.hint}`
  } else if (typeof result.output === 'string') {
    text = result.output
  } else {
    try {
      text = JSON.stringify(result.output) ?? String(result.output)
    } catch {
      text = '[unserializable tool output]'
    }
  }
  if (text.length > charLimit) {
    text = text.slice(0, charLimit) + truncationMarker(charLimit, text.length)
  }
  return text
}
