import fs from 'node:fs'
import path from 'node:path'

import { ALWAYS_SKIPPED_DIRS } from './filesystem.js'

/**
 * Bounded, deterministic file walker shared by the search tools.
 *
 * - Skips `.git` and `node_modules` everywhere.
 * - Sorts entries so results are stable across runs and platforms.
 * - Hard caps on files visited and depth keep latency predictable —
 *   tools never scan an entire large repository unboundedly.
 * - Honors an AbortSignal so Ctrl+C stops mid-walk.
 */

export interface WalkOptions {
  /** Stop after visiting this many files (default 10 000). */
  maxFiles?: number
  /** Stop descending beyond this depth (default 12). */
  maxDepth?: number
  signal?: AbortSignal
}

export interface WalkResult {
  /** Workspace-relative, "/"-separated file paths, sorted. */
  readonly files: string[]
  /** Whether a cap stopped the walk early. */
  readonly truncated: boolean
}

const DEFAULT_MAX_FILES = 10_000
const DEFAULT_MAX_DEPTH = 12

/** Walk `root` (absolute) collecting relative file paths, bounded and sorted. */
export function walkFiles(root: string, options: WalkOptions = {}): WalkResult {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const files: string[] = []
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const dirent of dirents) {
      if (options.signal?.aborted === true) return
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      const absolute = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRS.has(dirent.name)) continue
        walk(absolute, depth + 1)
      } else if (dirent.isFile()) {
        files.push(path.relative(root, absolute).split(path.sep).join('/'))
      }
      // Symlinks and others are skipped: they may leave the workspace
      // (path security resolves each path individually where needed).
    }
  }

  walk(path.resolve(root), 1)
  return { files, truncated }
}
