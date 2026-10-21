import { z } from 'zod'

import { ConfigurationError } from '../domain/errors/index.js'

/**
 * Configuration schema.
 *
 * Raw inputs (CLI flags, env vars, config file) are gathered as
 * `LunarConfigInput` (everything optional), validated and defaulted into a
 * fully-resolved `LunarConfig`.
 */

/**
 * Engineering-loop limits (Phase 3). Every key is optional; the
 * defaults live in `src/engineering/limits.ts`. Ranges are bounded so a
 * misconfigured file cannot remove the hard caps entirely.
 */
export const EngineeringConfigSchema = z
  .object({
    /** Correct-and-verify attempts per task (1–10). */
    maxIterations: z.number().int().min(1).max(10).optional(),
    /** File mutations across the whole task (1–100). */
    maxMutations: z.number().int().min(1).max(100).optional(),
    /** Controlled command executions across the task (1–50). */
    maxCommands: z.number().int().min(1).max(50).optional(),
    /** Hard cap on one command's runtime in ms (1 s – 10 min). */
    commandTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
    /** Cap on captured stdout/stderr per command in bytes. */
    maxOutputBytes: z.number().int().min(1000).max(10_000_000).optional(),
    /** Cap on the content of any single mutated file in bytes. */
    maxFileBytes: z.number().int().min(1000).max(10_000_000).optional(),
    /** Max changes in one proposal (1–50). */
    maxChangesPerProposal: z.number().int().min(1).max(50).optional(),
    /** Extra attempts when the model's JSON is invalid (0–5). */
    jsonRetries: z.number().int().min(0).max(5).optional(),
    /** Executables the command layer may run (empty → built-in defaults). */
    allowedCommands: z.array(z.string().min(1)).max(50).optional(),
    /** Commands running at the same time (1–4). */
    maxConcurrentCommands: z.number().int().min(1).max(4).optional(),
  })
  .strict()

/**
 * Security settings (Phase 4). Strictly enumerated: there are no values
 * that disable a core boundary. `sandbox: "deny"` fails CLOSED (no
 * execution without a full sandbox); `network` and `environment` accept
 * only the enforced modes.
 */
export const SecurityConfigSchema = z
  .object({
    /** Sandbox enforcement level. */
    sandbox: z.enum(['auto', 'restricted', 'deny']).optional(),
    /** Network policy — deny-by-default is the only Phase 4 mode. */
    network: z.enum(['deny']).optional(),
    /** Environment policy — filtered execution is the only mode. */
    environment: z.enum(['filtered']).optional(),
  })
  .strict()

export const LunarConfigInputSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  debug: z.boolean().optional(),
  engineering: EngineeringConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
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
