import { z } from 'zod'

import { ConfigurationError } from '../domain/errors/index.js'

/**
 * Configuration schema.
 *
 * Raw inputs (CLI flags, env vars, config file) are gathered as
 * `LunarConfigInput` (everything optional), validated and defaulted into a
 * fully-resolved `LunarConfig`.
 */

export const LunarConfigInputSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  debug: z.boolean().optional(),
})

export const LunarConfigSchema = LunarConfigInputSchema.extend({
  debug: z.boolean().default(false),
})

/** Partial configuration as supplied by any single source. */
export type LunarConfigInput = z.input<typeof LunarConfigInputSchema>

/** Fully-resolved configuration after merging and validation. */
export type LunarConfig = z.output<typeof LunarConfigSchema>

/** Validate a merged configuration object, throwing ConfigurationError on failure. */
export function validateConfig(candidate: unknown): LunarConfig {
  const result = LunarConfigSchema.safeParse(candidate)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ConfigurationError(`Invalid configuration: ${issues}`, {
      hint: 'Check ~/.lunar/config.json, LUNAR_* environment variables, and CLI flags.',
      details: { issues: result.error.issues },
    })
  }
  return result.data
}
