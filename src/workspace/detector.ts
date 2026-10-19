import fs from 'node:fs'
import path from 'node:path'

import { WorkspaceError } from '../domain/errors/index.js'
import type { GitInfo, Workspace } from '../domain/types/workspace.js'
import { displayPath } from '../utils/paths.js'

/**
 * Workspace and git detection.
 *
 * Phase 0 scope: locate the project root (git root when inside a repository,
 * otherwise the working directory) and read the current branch. No git
 * commands are executed — detection is pure filesystem inspection, which
 * keeps startup fast and side-effect free.
 */

/** Read the current branch from a repository's .git/HEAD, if determinable. */
function readBranch(gitDir: string): string | undefined {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (match?.[1] !== undefined) return match[1]
    // Detached HEAD — the ref is a raw commit sha.
    return head.length > 0 ? head.slice(0, 8) : undefined
  } catch {
    return undefined
  }
}

/** Walk up from `startDir` looking for a `.git` entry; return its directory. */
function findGitRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir)
  const { root } = path.parse(current)

  for (;;) {
    const gitEntry = path.join(current, '.git')
    try {
      const gitStat = fs.statSync(gitEntry)
      if (gitStat.isDirectory() || gitStat.isFile()) {
        return current
      }
    } catch {
      // No .git here — keep walking up.
    }
    if (current === root) return undefined
    current = path.dirname(current)
  }
}

/** Detect git information for a directory. */
export function detectGit(dir: string): GitInfo {
  const gitRoot = findGitRoot(dir)
  if (gitRoot === undefined) {
    return { isRepository: false }
  }
  const gitDir = path.join(gitRoot, '.git')
  const stat = fs.statSync(gitDir)
  // A `.git` file means a worktree/submodule — its actual directory is
  // referenced inside; for Phase 0 branch detection we only handle the
  // common directory case and degrade gracefully otherwise.
  const branch = stat.isDirectory() ? readBranch(gitDir) : undefined
  return { isRepository: true, root: gitRoot, ...(branch !== undefined ? { branch } : {}) }
}

/** Detect the workspace for a given working directory. */
export function detectWorkspace(cwd: string): Workspace {
  const resolved = path.resolve(cwd)

  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch (error) {
    throw new WorkspaceError(`Directory does not exist: ${resolved}`, {
      cause: error,
      hint: 'Pass a valid path with --cwd.',
    })
  }
  if (!stat.isDirectory()) {
    throw new WorkspaceError(`Not a directory: ${resolved}`, {
      hint: 'Pass a directory path with --cwd.',
    })
  }

  const git = detectGit(resolved)
  const root = git.isRepository && git.root !== undefined ? git.root : resolved

  return {
    cwd: resolved,
    root,
    name: displayPath(root),
    git,
  }
}
