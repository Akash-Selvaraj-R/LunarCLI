import fs from 'node:fs'
import path from 'node:path'

import { ToolError } from './errors.js'

/**
 * Workspace path security.
 *
 * Every filesystem/search tool resolves model-supplied paths through
 * `resolveWorkspacePath` before touching the disk. The rules:
 *
 * 1. Relative paths resolve against the workspace root; absolute paths
 *    are accepted only if they stay inside the workspace.
 * 2. The resolved candidate must be contained in the workspace root
 *    (checked with `path.relative`, which understands Windows drive
 *    letters and separators — no POSIX-only assumptions).
 * 3. Symlinks/junctions are resolved with `realpath` where the path (or
 *    its nearest existing ancestor, for not-yet-existing paths) exists,
 *    and containment is re-checked against the *real* workspace root.
 *    A symlink inside the workspace that points outside it is rejected.
 * 4. On Windows the filesystem is case-insensitive, so containment
 *    compares case-folded segments on that platform only.
 *
 * Known limitation: a symlink whose target does not exist yet cannot be
 * realpath-resolved; such paths are validated against their lexical
 * location only. Phase 2 tools only ever read, so the worst case is a
 * failed read, never a write outside the workspace.
 */

/** Whether two resolved paths refer to the same location (platform-aware). */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Whether `candidate` is `root` itself or lives beneath it. */
function isWithin(root: string, candidate: string): boolean {
  if (samePath(root, candidate)) return true
  const rel = path.relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Resolve the real path of the deepest existing ancestor (or itself). */
function realpathOfExistingPrefix(target: string): string {
  let current = path.resolve(target)
  const missing: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      // Re-join the non-existing tail (its segments cannot be symlinks).
      return missing.length === 0 ? real : path.join(real, ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target) // nothing exists — lexical only
      missing.push(path.basename(current))
      current = parent
    }
  }
}

export interface ResolveWorkspacePathOptions {
  /** Resolve the path even when it does not exist (file_exists). */
  allowMissing?: boolean
}

/**
 * Resolve a model-supplied path safely inside the workspace.
 *
 * Returns the absolute, normalized, symlink-resolved path. Throws a
 * `ToolError('path_outside_workspace')` for any escape attempt and a
 * `ToolError('file_not_found')` for missing paths unless `allowMissing`.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
  options: ResolveWorkspacePathOptions = {},
): string {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new ToolError('invalid_input', 'Path must be a non-empty string.', {
      hint: 'Use "." for the workspace root or a path like "src/auth/login.ts".',
    })
  }
  // Reject NUL bytes outright — they confuse path APIs on every platform.
  if (inputPath.includes('\0')) {
    throw new ToolError('invalid_input', 'Path contains an illegal NUL byte.')
  }

  const root = path.resolve(workspaceRoot)
  const realRoot = realpathOfExistingPrefix(root)

  const candidate = path.resolve(root, inputPath)
  // Lexical check first: cheap rejection of ../ escapes and foreign drives.
  if (!isWithin(root, candidate)) {
    throw new ToolError('path_outside_workspace', `Path escapes the workspace: ${inputPath}`, {
      details: { workspaceRoot: root },
      hint: 'Paths must stay inside the workspace.',
    })
  }

  // Symlink-aware check: resolve the real location before touching it.
  const realCandidate = realpathOfExistingPrefix(candidate)
  if (!isWithin(realRoot, realCandidate)) {
    throw new ToolError(
      'path_outside_workspace',
      `Path resolves outside the workspace (symlink or junction): ${inputPath}`,
      { details: { workspaceRoot: realRoot } },
    )
  }

  if (!options.allowMissing) {
    if (!fs.existsSync(realCandidate)) {
      throw new ToolError('file_not_found', `No such path in workspace: ${inputPath}`, {
        hint: 'Check the path with list_directory or find_files.',
      })
    }
  }

  return realCandidate
}

/** Render an absolute path as a workspace-relative, "/"-separated path. */
export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const rel = path.relative(path.resolve(workspaceRoot), absolutePath)
  return rel === '' ? '.' : rel.split(path.sep).join('/')
}
