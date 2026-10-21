import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandExecutor } from '../src/engineering/command.js'
import { resolveLimits } from '../src/engineering/limits.js'
import { VerificationManager } from '../src/engineering/verification.js'
import type { ValidatedChange } from '../src/engineering/changes.js'
import { detectWorkspace } from '../src/workspace/detector.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Verification (Phase 3): success is not "the write worked" — applied
 * changes must hold on disk AND the controlled test command must pass.
 */

let root: string
let workspace: Workspace
let executor: CommandExecutor

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-verify-'))
  workspace = detectWorkspace(root)
  executor = new CommandExecutor({ workspace, limits: resolveLimits() })
})

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function appliedCreate(name: string): ValidatedChange {
  const absolutePath = path.join(root, name)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, 'written\n')
  return { path: name, absolutePath, operation: 'create', reason: 't', diff: '' }
}

function passingManager(): VerificationManager {
  return new VerificationManager({
    workspace,
    executor,
    command: { executable: 'node', args: ['-e', 'process.exit(0)'], cwd: '.' },
  })
}

function failingManager(): VerificationManager {
  return new VerificationManager({
    workspace,
    executor,
    command: {
      executable: 'node',
      args: ['-e', "process.stderr.write('2 tests failed'); process.exit(1)"],
      cwd: '.',
    },
  })
}

describe('VerificationManager', () => {
  it('passes when files exist and the test command exits 0', async () => {
    const result = await passingManager().verify([appliedCreate('src/a.ts')])
    expect(result.ok).toBe(true)
    expect(result.checks.every((check) => check.ok)).toBe(true)
    expect(result.testSummary?.exitCode).toBe(0)
    expect(result.testSummary?.command).toContain('node')
  })

  it('fails when the test command exits non-zero, keeping raw output', async () => {
    const result = await failingManager().verify([appliedCreate('src/a.ts')])
    expect(result.ok).toBe(false)
    expect(result.testSummary?.exitCode).toBe(1)
    expect(result.testSummary?.stderr).toContain('2 tests failed')
    expect(result.checks.some((check) => !check.ok)).toBe(true)
  })

  it('fails when an applied file is missing on disk', async () => {
    const ghost: ValidatedChange = {
      path: 'src/ghost.ts',
      absolutePath: path.join(root, 'src', 'ghost.ts'),
      operation: 'create',
      reason: 't',
      diff: '',
    }
    const result = await passingManager().verify([ghost])
    expect(result.ok).toBe(false)
    expect(result.checks[0]?.detail).toContain('missing')
  })

  it('verifies that deleted files are actually gone', async () => {
    const target = path.join(root, 'gone.txt')
    fs.writeFileSync(target, 'x')
    const change: ValidatedChange = {
      path: 'gone.txt',
      absolutePath: target,
      operation: 'delete',
      reason: 't',
      diff: '',
    }

    // Simulate the deletion having been applied: file is gone.
    fs.rmSync(target)
    const gone = await passingManager().verify([change])
    expect(gone.ok).toBe(true)

    // Simulate the deletion NOT having happened: file is still there.
    fs.writeFileSync(target, 'still here')
    const still = await passingManager().verify([change])
    expect(still.ok).toBe(false)
  })

  it('falls back to filesystem checks when no test command exists', async () => {
    const manager = new VerificationManager({ workspace, executor })
    expect(manager.testCommand()).toBeUndefined()
    const result = await manager.verify([appliedCreate('src/a.ts')])
    expect(result.ok).toBe(true)
    expect(result.testSummary).toBeUndefined()
    expect(result.note).toContain('No test command')
  })

  it('skips tests when asked (command budget exhausted)', async () => {
    const result = await passingManager().verify([appliedCreate('src/a.ts')], {
      skipTests: true,
    })
    expect(result.ok).toBe(true)
    expect(result.note).toContain('skipped')
    expect(result.testSummary).toBeUndefined()
  })

  it('fails verification when the test executable cannot start', async () => {
    const broken = new VerificationManager({
      workspace,
      executor: new CommandExecutor({
        workspace,
        limits: resolveLimits(),
        allowedCommands: ['ghost-executable-12345'],
      }),
      command: { executable: 'ghost-executable-12345', args: [], cwd: '.' },
    })
    const result = await broken.verify([appliedCreate('src/a.ts')])
    expect(result.ok).toBe(false)
    expect(result.checks.some((check) => check.name.startsWith('tests:'))).toBe(true)
  })
})
