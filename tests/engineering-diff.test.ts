import { describe, expect, it } from 'vitest'

import { changeNotation, unifiedDiff } from '../src/engineering/diff.js'

/**
 * Diff generation (Phase 3): the user must understand a proposal
 * BEFORE approving it. Unified format, bounded line-based LCS.
 */

describe('unifiedDiff', () => {
  it('renders a create as an all-additions diff against /dev/null', () => {
    const diff = unifiedDiff('', 'line one\nline two\n', 'src/new.ts', 'create')
    expect(diff).toContain('--- /dev/null')
    expect(diff).toContain('+++ b/src/new.ts')
    expect(diff).toContain('+line one')
    expect(diff).toContain('+line two')
    // No deletion lines (headers excluded).
    const body = diff.split('\n').slice(2).join('\n')
    expect(body).not.toMatch(/^-/m)
  })

  it('renders a delete as an all-deletions diff to /dev/null', () => {
    const diff = unifiedDiff('goodbye\ncruel world\n', '', 'src/old.ts', 'delete')
    expect(diff).toContain('--- a/src/old.ts')
    expect(diff).toContain('+++ /dev/null')
    expect(diff).toContain('-goodbye')
    expect(diff).toContain('-cruel world')
  })

  it('renders an update with context and a unified hunk header', () => {
    const oldText = ['const a = 1', 'const b = 2', 'const c = 3'].join('\n')
    const newText = ['const a = 1', 'const b = 22', 'const c = 3'].join('\n')
    const diff = unifiedDiff(oldText, newText, 'src/x.ts', 'update')
    expect(diff).toContain('--- a/src/x.ts')
    expect(diff).toContain('+++ b/src/x.ts')
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)
    expect(diff).toContain(' const a = 1') // context line
    expect(diff).toContain('-const b = 2')
    expect(diff).toContain('+const b = 22')
    expect(diff).toContain(' const c = 3')
  })

  it('returns an empty string when nothing changes', () => {
    expect(unifiedDiff('same\n', 'same\n', 'src/x.ts', 'update')).toBe('')
  })

  it('splits distant changes into separate hunks', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`)
    const changed = [...lines]
    changed[1] = 'line 1 CHANGED'
    changed[16] = 'line 16 CHANGED'
    const diff = unifiedDiff(lines.join('\n'), changed.join('\n'), 'src/x.ts', 'update')
    const hunkCount = (diff.match(/@@/g) ?? []).length / 2
    expect(hunkCount).toBe(2)
  })

  it('keeps a large insertion bounded (replace-all fallback)', () => {
    const oldText = Array.from({ length: 2_000 }, (_, index) => `old ${index}`).join('\n')
    const newText = Array.from({ length: 2_000 }, (_, index) => `new ${index}`).join('\n')
    const diff = unifiedDiff(oldText, newText, 'src/big.ts', 'update')
    expect(diff).toContain('-old 0')
    expect(diff).toContain('+new 0')
  })
})

describe('changeNotation', () => {
  it('uses git-style letters', () => {
    expect(changeNotation('create')).toBe('A')
    expect(changeNotation('update')).toBe('M')
    expect(changeNotation('delete')).toBe('D')
  })
})
