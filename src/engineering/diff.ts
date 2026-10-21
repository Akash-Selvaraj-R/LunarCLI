/**
 * Minimal unified-diff generation (Phase 3).
 *
 * Line-based LCS diff rendered in unified format so the user can see
 * exactly what a proposal will change before approving it. Bounded:
 * common prefix/suffix are trimmed first, and very large middles fall
 * back to a whole-file replace so memory stays predictable.
 */

import { FileOperation } from './operations.js'

const CONTEXT_LINES = 3
/** Above this middle size (after trimming), fall back to replace-all. */
const MAX_LCS_LINES = 1_500

type DiffLine = { op: ' ' | '-' | '+'; text: string }

/** Trim common prefix/suffix, then LCS the middle (bounded). */
function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')

  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)

  const middle =
    oldMiddle.length > MAX_LCS_LINES || newMiddle.length > MAX_LCS_LINES
      ? [
          ...oldMiddle.map((text): DiffLine => ({ op: '-', text })),
          ...newMiddle.map((text): DiffLine => ({ op: '+', text })),
        ]
      : lcsDiff(oldMiddle, newMiddle)

  return [
    ...oldLines.slice(0, prefix).map((text): DiffLine => ({ op: ' ', text })),
    ...middle,
    ...oldLines.slice(oldLines.length - suffix).map((text): DiffLine => ({ op: ' ', text })),
  ]
}

/** Classic O(N·M) LCS diff — bounded by MAX_LCS_LINES upstream. */
function lcsDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] ?? '' })
      i += 1
      j += 1
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      out.push({ op: '-', text: a[i] ?? '' })
      i += 1
    } else {
      out.push({ op: '+', text: b[j] ?? '' })
      j += 1
    }
  }
  while (i < a.length) {
    out.push({ op: '-', text: a[i] ?? '' })
    i += 1
  }
  while (j < b.length) {
    out.push({ op: '+', text: b[j] ?? '' })
    j += 1
  }
  return out
}

/** Render diff lines as unified format with context hunks. */
function renderUnified(lines: readonly DiffLine[], oldLabel: string, newLabel: string): string {
  if (!lines.some((line) => line.op !== ' ')) return '' // no changes

  // Group changed lines into hunks; groups closer than 2×context merge.
  const changeIndices: number[] = []
  lines.forEach((line, index) => {
    if (line.op !== ' ') changeIndices.push(index)
  })
  const first = changeIndices[0] ?? 0
  const groups: Array<{ start: number; end: number }> = [{ start: first, end: first }]
  for (const index of changeIndices.slice(1)) {
    const current = groups[groups.length - 1]
    if (current !== undefined && index - current.end <= CONTEXT_LINES * 2) {
      current.end = index
    } else {
      groups.push({ start: index, end: index })
    }
  }

  const hunks = groups.map((group) => {
    const start = Math.max(0, group.start - CONTEXT_LINES)
    const end = Math.min(lines.length, group.end + CONTEXT_LINES + 1)
    const slice = lines.slice(start, end)

    // Line numbers count only the sides each line belongs to.
    let oldBefore = 0
    let newBefore = 0
    for (const line of lines.slice(0, start)) {
      if (line.op !== '+') oldBefore += 1
      if (line.op !== '-') newBefore += 1
    }
    const oldCount = slice.filter((line) => line.op !== '+').length
    const newCount = slice.filter((line) => line.op !== '-').length

    const body = slice.map((line) => `${line.op}${line.text}`).join('\n')
    return (
      `@@ -${oldCount === 0 ? 0 : oldBefore + 1},${oldCount} ` +
      `+${newCount === 0 ? 0 : newBefore + 1},${newCount} @@\n${body}`
    )
  })

  return `--- ${oldLabel}\n+++ ${newLabel}\n${hunks.join('\n')}`
}

/**
 * Unified diff between two file states. Labels follow git convention:
 * `/dev/null` for a side that does not exist (create/delete).
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  relativePath: string,
  operation: FileOperation,
): string {
  const oldLabel = operation === FileOperation.CREATE ? '/dev/null' : `a/${relativePath}`
  const newLabel = operation === FileOperation.DELETE ? '/dev/null' : `b/${relativePath}`
  return renderUnified(diffLines(oldText, newText), oldLabel, newLabel)
}

/** One-line change descriptor for compact UI lists. */
export function changeNotation(operation: FileOperation): string {
  return operation === FileOperation.CREATE ? 'A' : operation === FileOperation.UPDATE ? 'M' : 'D'
}
