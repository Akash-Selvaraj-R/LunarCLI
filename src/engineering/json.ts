import type { z } from 'zod'

import { ToolError } from '../tools/errors.js'

/**
 * Validated model-output parsing (Phase 3).
 *
 * Structured output from the LLM is NEVER trusted: it is extracted,
 * parsed, and schema-validated. Anything else becomes a controlled
 * error the loop can react to (retry with a correction prompt).
 */

/**
 * Extract a JSON object from model text: tolerates ```json fences and
 * surrounding prose by slicing from the first `{` to the last `}`.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new ToolError('invalid_input', 'The model response contains no JSON object.', {
      hint: 'The agent will retry with an explicit correction prompt.',
    })
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch (error) {
    throw new ToolError(
      'invalid_input',
      `The model response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { hint: 'The agent will retry with an explicit correction prompt.' },
    )
  }
}

/**
 * Extract and Zod-validate a structured model response. Throws a
 * controlled ToolError summarizing schema issues on failure.
 */
export function parseModelJson<T>(text: string, schema: z.ZodType<T>, label: string): T {
  const raw = extractJsonObject(text)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ToolError('invalid_input', `The ${label} is not valid: ${issues}`, {
      details: { issues: result.error.issues },
      hint: 'The agent will retry with an explicit correction prompt.',
    })
  }
  return result.data
}
