import fs from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { ConfigurationError } from '../domain/errors/index.js'

/**
 * Project-level command policy (Phase 4).
 *
 * A repository MAY ship `.lunar/policy.json` describing per-command
 * decisions:
 *
 *   { "commands": { "npm test": "allow", "npm install": "deny" } }
 *
 * SECURITY MODEL — this file is REPOSITORY CONTENT and is therefore
 * UNTRUSTED:
 *
 * - It can only TIGHTEN decisions (deny/ask a command the global
 *   policy would allow) or grant `allow` to REVIEW-class commands.
 * - It can NEVER override a hard deny (git push, shells, curl, …).
 * - It can NEVER auto-allow a DANGEROUS command.
 * - Keys must be exact normalized commands ("npm test", not "npm*").
 * - Unknown keys, unknown fields, or malformed JSON FAIL CLOSED with a
 *   ConfigurationError — the engineering loop refuses to start rather
 *   than silently running with a broken policy.
 */

/** Per-command decision a project policy may express. */
export type ProjectCommandDecision = 'allow' | 'ask' | 'deny'

export interface ProjectPolicy {
  /** Exact normalized command → decision. */
  readonly commands: ReadonlyMap<string, ProjectCommandDecision>
  /** Absolute path the policy was loaded from (for audit output). */
  readonly source: string
}

/** Hard bound so a hostile repository cannot ship a pathological policy. */
const MAX_POLICY_ENTRIES = 200

/** A command key: bare executable plus optional args, no paths. */
const COMMAND_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*( [^\s].*)*$/

const ProjectPolicyFileSchema = z
  .object({
    commands: z
      .record(
        z.string().min(1).max(300).regex(COMMAND_KEY, 'must be a bare command like "npm test"'),
        z.enum(['allow', 'ask', 'deny']),
      )
      .refine((commands) => Object.keys(commands).length <= MAX_POLICY_ENTRIES, {
        message: `at most ${MAX_POLICY_ENTRIES} command entries`,
      })
      .optional(),
  })
  .strict()

/** The project policy file location, relative to the workspace root. */
export const PROJECT_POLICY_PATH = '.lunar/policy.json'

/**
 * Load the project policy, if present. Returns undefined when the file
 * does not exist. Malformed or invalid policies FAIL CLOSED with a
 * ConfigurationError — they never silently downgrade to "no policy".
 */
export function loadProjectPolicy(workspaceRoot: string): ProjectPolicy | undefined {
  const source = path.join(path.resolve(workspaceRoot), PROJECT_POLICY_PATH)
  let raw: string
  try {
    raw = fs.readFileSync(source, 'utf8')
  } catch {
    return undefined // Absent — the global policy governs.
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConfigurationError(`Project command policy is not valid JSON: ${source}`, {
      cause: error,
      hint: `Fix or delete ${PROJECT_POLICY_PATH} in the workspace root.`,
    })
  }

  const result = ProjectPolicyFileSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ConfigurationError(`Invalid project command policy: ${issues}`, {
      hint: `Only { "commands": { "<command>": "allow" | "ask" | "deny" } } is accepted.`,
      details: { source },
    })
  }

  const commands = new Map<string, ProjectCommandDecision>()
  for (const [key, decision] of Object.entries(result.data.commands ?? {})) {
    // Keys match the normalizer's canonical display form exactly —
    // argument case is significant (npm script names are case-sensitive).
    commands.set(key.trim(), decision)
  }
  return { commands, source }
}
