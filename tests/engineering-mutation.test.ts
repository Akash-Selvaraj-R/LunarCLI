import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MutationManager } from '../src/engineering/mutation.js'
import type { ValidatedChange } from '../src/engineering/changes.js'
import { resolveLimits } from '../src/engineering/limits.js'

/**
 * MutationManager (Phase 3): the ONLY code path that writes to disk.
 * Atomic writes, single files only, stop-on-first-error, never throws.
 */

let root: string
let manager: MutationManager

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-mutation-'))
  fs.writeFileSync(path.join(root, 'existing.txt'), 'original content\n')
  manager = new MutationManager({ limits: resolveLimits() })
})

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function change(over: Partial<ValidatedChange> & { operation: ValidatedChange['operation'] }): ValidatedChange {
  const target = over.path ?? 'created.txt'
  return {
    path: target,
    absolutePath: path.join(root, target),
    reason: 'test',
    diff: '',
    ...over,
  } as ValidatedChange
}

describe('MutationManager.apply', () => {
  it('creates a file with the exact content', async () => {
    const results = await manager.apply([
      change({ operation: 'create', content: 'hello\n', path: 'created.txt' }),
    ])
    expect(results).toHaveLength(1)
    expect(results[0]?.applied).toBe(true)
    expect(fs.readFileSync(path.join(root, 'created.txt'), 'utf8')).toBe('hello\n')
  })

  it('updates an existing file atomically', async () => {
    const results = await manager.apply([
      change({ operation: 'update', content: 'replaced\n', path: 'existing.txt' }),
    ])
    expect(results[0]?.applied).toBe(true)
    expect(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8')).toBe('replaced\n')
  })

  it('deletes a single file', async () => {
    const results = await manager.apply([
      change({ operation: 'delete', path: 'existing.txt' }),
    ])
    expect(results[0]?.applied).toBe(true)
    expect(fs.existsSync(path.join(root, 'existing.txt'))).toBe(false)
  })

  it('leaves no temporary files behind after a successful write', async () => {
    await manager.apply([change({ operation: 'create', content: 'x\n', path: 't.txt' })])
    const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('stops at the first failure and reports later changes as skipped', async () => {
    const results = await manager.apply([
      change({ operation: 'create', content: 'ok\n', path: 'first.txt' }),
      // Parent directory does not exist → write fails.
      change({ operation: 'create', content: 'x\n', path: 'missing-dir/second.txt' }),
      change({ operation: 'create', content: 'ok\n', path: 'third.txt' }),
    ])
    expect(results[0]?.applied).toBe(true)
    expect(results[1]?.applied).toBe(false)
    expect(results[1]?.error).toBeDefined()
    expect(results[2]?.applied).toBe(false)
    expect(results[2]?.error).toContain('skipped')
    expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'third.txt'))).toBe(false)
  })

  it('refuses to delete a directory', async () => {
    fs.mkdirSync(path.join(root, 'adir'))
    const results = await manager.apply([
      change({ operation: 'delete', path: 'adir' }),
    ])
    expect(results[0]?.applied).toBe(false)
    expect(results[0]?.error).toContain('non-file')
    expect(fs.existsSync(path.join(root, 'adir'))).toBe(true)
  })

  it('refuses oversized content at the write chokepoint (defense in depth)', async () => {
    const strict = new MutationManager({ limits: resolveLimits({ maxFileBytes: 8 }) })
    const results = await strict.apply([
      change({ operation: 'create', content: 'x'.repeat(100), path: 'big.txt' }),
    ])
    expect(results[0]?.applied).toBe(false)
    expect(results[0]?.error).toContain('exceeds')
    expect(fs.existsSync(path.join(root, 'big.txt'))).toBe(false)
  })

  it('marks remaining changes as cancelled when the signal aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const results = await manager.apply(
      [change({ operation: 'create', content: 'x\n', path: 'a.txt' })],
      { signal: controller.signal },
    )
    expect(results[0]?.applied).toBe(false)
    expect(results[0]?.error).toBe('cancelled')
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false)
  })
})
