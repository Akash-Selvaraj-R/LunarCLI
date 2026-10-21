import fs from 'node:fs'
import { z } from 'zod'

import type { Workspace } from '../domain/types/workspace.js'
import { resolveWorkspacePath, toWorkspaceRelative } from '../tools/path-security.js'
import { ToolError } from '../tools/errors.js'
import { unifiedDiff } from './diff.js'
import type { EngineeringLimits } from './limits.js'
import { FileOperation } from './operations.js'

export { FileOperation } from './operations.js'

/**
 * Proposed file changes (Phase 3).
 *
 * The model never mutates anything directly — it proposes structured
 * changes; this module validates each one BEFORE any approval or disk
 * access:
 *
 *   path safety       resolved through the Phase 2 workspace boundary
 *   existence rules   update/delete need an existing file; create must
 *                     not silently overwrite
 *   conflict checks   optional oldContent must match the current file
 *   size limits       bounded per file and per proposal
 *
 * Validation failures are controlled ToolErrors the loop can surface.
 */

export const FileChangeSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative path of the target file.'),
  operation: z.enum(['create', 'update', 'delete']),
  content: z.string().optional().describe('New full file content (required for create/update).'),
  oldContent: z
    .string()
    .optional()
    .describe('Expected current content for updates — verified before applying.'),
  reason: z.string().min(1).describe('Why this change is needed.'),
})

export type FileChange = z.output<typeof FileChangeSchema>

/** A change that passed every validation, ready for the MutationManager. */
export interface ValidatedChange {
  /** Workspace-relative, "/"-separated path. */
  readonly path: string
  /** Absolute, resolved path inside the workspace. */
  readonly absolutePath: string
  readonly operation: FileOperation
  readonly content?: string
  readonly reason: string
  /** Unified diff preview computed at validation time. */
  readonly diff: string
}

/** Validate one model-proposed change. Throws a controlled ToolError. */
export function validateChange(
  workspace: Workspace,
  change: FileChange,
  limits: EngineeringLimits,
): ValidatedChange {
  const isCreate = change.operation === FileOperation.CREATE
  const isDelete = change.operation === FileOperation.DELETE

  // ── Content rules ────────────────────────────────────────────────
  if (isDelete && change.content !== undefined) {
    throw new ToolError('invalid_input', `Delete proposal for "${change.path}" must not carry content.`)
  }
  if (!isDelete && change.content === undefined) {
    throw new ToolError(
      'invalid_input',
      `The ${change.operation} proposal for "${change.path}" is missing "content".`,
      { hint: 'Provide the complete new file content for create/update operations.' },
    )
  }
  const content = change.content
  if (content !== undefined && Buffer.byteLength(content, 'utf8') > limits.maxFileBytes) {
    throw new ToolError(
      'output_limit',
      `Proposed content for "${change.path}" exceeds the mutation size limit ` +
        `(${Buffer.byteLength(content, 'utf8')} bytes; limit ${limits.maxFileBytes}).`,
    )
  }

  // ── Path safety (Phase 2 boundary) ───────────────────────────────
  // allowMissing for create: existence is checked explicitly below so
  // the error message is precise.
  const absolutePath = resolveWorkspacePath(workspace.root, change.path, {
    allowMissing: isCreate,
  })
  const relativePath = toWorkspaceRelative(workspace.root, absolutePath)
  const stat = safeStat(absolutePath)

  // ── Existence rules ──────────────────────────────────────────────
  if (!isCreate && stat === undefined) {
    throw new ToolError('file_not_found', `Target does not exist: ${change.path}`, {
      hint: 'Update and delete operations require an existing file.',
    })
  }
  if (stat?.isDirectory() === true) {
    throw new ToolError(
      'not_a_file',
      `Target is a directory, not a file: ${change.path}`,
      { hint: 'Phase 3 mutates single files only — no directory operations.' },
    )
  }
  if (isCreate && stat !== undefined) {
    throw new ToolError(
      'invalid_input',
      `Create would overwrite an existing file: ${change.path}`,
      { hint: 'Use operation "update" for files that already exist.' },
    )
  }

  // ── Conflict check (oldContent / expected state) ─────────────────
  let oldText = ''
  if ((change.operation === FileOperation.UPDATE || isDelete) && stat !== undefined) {
    oldText = fs.readFileSync(absolutePath, 'utf8')
    if (change.operation === FileOperation.UPDATE && change.oldContent !== undefined && change.oldContent !== oldText) {
      throw new ToolError(
        'invalid_input',
        `The file changed since it was last read: ${change.path}`,
        { hint: 'Re-read the file and propose the update against its current content.' },
      )
    }
  }

  const diff = unifiedDiff(oldText, content ?? '', relativePath, change.operation)

  return {
    path: relativePath,
    absolutePath,
    operation: change.operation,
    ...(content !== undefined ? { content } : {}),
    reason: change.reason,
    diff,
  }
}

/**
 * Validate a full proposal: bounds, duplicates, then each change.
 * Returns validated changes in proposal order. Throws on any problem —
 * a proposal is applied all-or-nothing at the validation layer.
 */
export function validateChanges(
  workspace: Workspace,
  changes: readonly FileChange[],
  limits: EngineeringLimits,
): ValidatedChange[] {
  if (changes.length === 0) {
    throw new ToolError('invalid_input', 'The proposal contains no changes.', {
      hint: 'A proposal must include at least one file change.',
    })
  }
  if (changes.length > limits.maxChangesPerProposal) {
    throw new ToolError(
      'output_limit',
      `The proposal has ${changes.length} changes; the limit is ${limits.maxChangesPerProposal}.`,
      { hint: 'Split the work into smaller proposals.' },
    )
  }
  const seen = new Set<string>()
  for (const change of changes) {
    const key = change.path.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) {
      throw new ToolError('invalid_input', `Duplicate change for the same file: ${change.path}`, {
        hint: 'Each file may appear at most once per proposal.',
      })
    }
    seen.add(key)
  }
  return changes.map((change) => validateChange(workspace, change, limits))
}

function safeStat(absolutePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(absolutePath)
  } catch {
    return undefined
  }
}
