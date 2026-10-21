import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectWorkspace } from '../src/workspace/detector.js'
import type { Workspace } from '../src/domain/types/workspace.js'
import { isToolError, ToolError } from '../src/tools/errors.js'
import { validateChange, validateChanges } from '../src/engineering/changes.js'
import type { FileChange } from '../src/engineering/changes.js'
import { resolveLimits } from '../src/engineering/limits.js'

/**
 * Change validation (Phase 3): path safety, existence rules, conflict
 * detection, and size limits — all BEFORE approval or disk access.
 * Attack shapes, not just happy paths.
 */

let base: string // temp base, removed in afterEach
let workspace: Workspace
let outside: string // a directory OUTSIDE the workspace

const limits = resolveLimits()

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-changes-'))
  const root = path.join(base, 'workspace')
  outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'existing.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n')
  workspace = detectWorkspace(root)
})

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function expectToolError(fn: () => unknown, kind: string): void {
  try {
    fn()
    expect.unreachable('expected a ToolError')
  } catch (error) {
    expect(isToolError(error)).toBe(true)
    expect((error as ToolError).kind).toBe(kind)
  }
}

const create = (over: Partial<FileChange> = {}): FileChange => ({
  path: 'src/new.ts',
  operation: 'create',
  content: 'export const b = 2\n',
  reason: 'add the new module',
  ...over,
})

describe('validateChange — legitimate operations', () => {
  it('validates a create with an all-additions diff', () => {
    const change = validateChange(workspace, create(), limits)
    expect(change.path).toBe('src/new.ts')
    expect(change.operation).toBe('create')
    expect(change.diff).toContain('--- /dev/null')
    expect(change.diff).toContain('+++ b/src/new.ts')
    expect(change.diff).toContain('+export const b = 2')
  })

  it('validates an update with a unified diff', () => {
    const change = validateChange(
      workspace,
      create({ path: 'src/existing.ts', operation: 'update', content: 'export const a = 2\n' }),
      limits,
    )
    expect(change.diff).toContain('--- a/src/existing.ts')
    expect(change.diff).toContain('-export const a = 1')
    expect(change.diff).toContain('+export const a = 2')
  })

  it('validates an update whose oldContent matches the file', () => {
    const change = validateChange(
      workspace,
      create({
        path: 'src/existing.ts',
        operation: 'update',
        content: 'export const a = 3\n',
        oldContent: 'export const a = 1\n',
      }),
      limits,
    )
    expect(change.operation).toBe('update')
  })

  it('validates a delete with an all-deletions diff', () => {
    const change = validateChange(
      workspace,
      create({ path: 'src/existing.ts', operation: 'delete', content: undefined }),
      limits,
    )
    expect(change.diff).toContain('+++ /dev/null')
    expect(change.diff).toContain('-export const a = 1')
  })

  it('resolves nested paths to workspace-relative form', () => {
    const change = validateChange(workspace, create({ path: './src/./deep/new.ts' }), limits)
    expect(change.path).toBe('src/deep/new.ts')
  })
})

describe('validateChange — existence rules', () => {
  it('rejects updating a file that does not exist', () => {
    expectToolError(
      () => validateChange(workspace, create({ path: 'src/ghost.ts', operation: 'update' }), limits),
      'file_not_found',
    )
  })

  it('rejects deleting a file that does not exist', () => {
    expectToolError(
      () =>
        validateChange(
          workspace,
          create({ path: 'src/ghost.ts', operation: 'delete', content: undefined }),
          limits,
        ),
      'file_not_found',
    )
  })

  it('rejects a create that would overwrite an existing file', () => {
    expectToolError(
      () => validateChange(workspace, create({ path: 'src/existing.ts' }), limits),
      'invalid_input',
    )
  })

  it('rejects a delete targeting a directory', () => {
    fs.mkdirSync(path.join(workspace.root, 'src', 'adir'), { recursive: true })
    expectToolError(
      () =>
        validateChange(
          workspace,
          create({ path: 'src/adir', operation: 'delete', content: undefined }),
          limits,
        ),
      'not_a_file',
    )
  })
})

describe('validateChange — conflict detection', () => {
  it('rejects an update whose oldContent no longer matches', () => {
    expectToolError(
      () =>
        validateChange(
          workspace,
          create({
            path: 'src/existing.ts',
            operation: 'update',
            oldContent: 'export const a = 999\n',
          }),
          limits,
        ),
      'invalid_input',
    )
  })
})

describe('validateChange — path safety', () => {
  it('rejects traversal outside the workspace', () => {
    expectToolError(
      () => validateChange(workspace, create({ path: '../../escape.txt' }), limits),
      'path_outside_workspace',
    )
  })

  it('rejects absolute paths outside the workspace (POSIX style)', () => {
    expectToolError(
      () => validateChange(workspace, create({ path: '/etc/passwd' }), limits),
      'path_outside_workspace',
    )
  })

  it('rejects absolute Windows system paths', () => {
    expectToolError(
      () => validateChange(workspace, create({ path: 'C:\\Windows\\system.ini' }), limits),
      'path_outside_workspace',
    )
  })

  it('rejects escapes via an existing sibling directory', () => {
    expectToolError(
      () =>
        validateChange(workspace, create({ path: path.join(outside, 'planted.txt') }), limits),
      'path_outside_workspace',
    )
  })
})

describe('validateChange — content rules and size limits', () => {
  it('rejects a create without content', () => {
    expectToolError(
      () => validateChange(workspace, create({ content: undefined }), limits),
      'invalid_input',
    )
  })

  it('rejects a delete carrying content', () => {
    expectToolError(
      () =>
        validateChange(
          workspace,
          create({ path: 'src/existing.ts', operation: 'delete' }),
          limits,
        ),
      'invalid_input',
    )
  })

  it('rejects content beyond the per-file size limit', () => {
    const small = resolveLimits({ maxFileBytes: 16 })
    expectToolError(
      () => validateChange(workspace, create({ content: 'x'.repeat(64) }), small),
      'output_limit',
    )
  })
})

describe('validateChanges — proposal-level rules', () => {
  it('rejects an empty change list', () => {
    expectToolError(() => validateChanges(workspace, [], limits), 'invalid_input')
  })

  it('rejects more changes than the per-proposal limit', () => {
    const small = resolveLimits({ maxChangesPerProposal: 1 })
    const changes = [
      create({ path: 'src/n1.ts' }),
      create({ path: 'src/n2.ts' }),
    ]
    expectToolError(() => validateChanges(workspace, changes, small), 'output_limit')
  })

  it('rejects duplicate changes for the same file', () => {
    const changes = [create({ path: 'src/n1.ts' }), create({ path: 'src/n1.ts' })]
    expectToolError(() => validateChanges(workspace, changes, limits), 'invalid_input')
  })

  it('validates a mixed proposal in order', () => {
    const changes = [
      create({ path: 'src/n1.ts' }),
      create({ path: 'src/existing.ts', operation: 'update', content: 'changed\n' }),
    ]
    const validated = validateChanges(workspace, changes, limits)
    expect(validated).toHaveLength(2)
    expect(validated[0]?.operation).toBe('create')
    expect(validated[1]?.operation).toBe('update')
    expect(validated[1]?.path).toBe('src/existing.ts')
  })
})
