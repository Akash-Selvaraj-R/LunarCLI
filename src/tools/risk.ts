/**
 * Tool risk classification.
 *
 * Every tool declares a risk level; the PermissionManager maps risk to a
 * decision. Classification is required even for tools that do not exist
 * yet, so the security review of a new tool is a single field.
 */

export const ToolRisk = {
  /** Read-only, side-effect free, no sensitive data (e.g. list_directory). */
  SAFE: 'safe',
  /** Reads user data but changes nothing (e.g. read_file, git_diff). */
  READ_ONLY: 'read_only',
  /** Modifies the machine (files, git history, packages). Denied in Phase 2. */
  MUTATING: 'mutating',
  /** Irreversible or high-blast-radius actions. Denied in Phase 2. */
  DANGEROUS: 'dangerous',
} as const

export type ToolRisk = (typeof ToolRisk)[keyof typeof ToolRisk]
