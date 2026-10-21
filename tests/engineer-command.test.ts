import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runEngineer } from '../src/cli/commands/engineer.js'
import { EngineeringLoop } from '../src/engineering/loop.js'
import { autoApprove } from '../src/engineering/approval.js'
import { PermissionManager, PHASE3_AUTO_POLICY } from '../src/permissions/permission-manager.js'
import { MockProvider } from '../src/providers/mock.js'
import { createSilentLogger } from '../src/logging/logger.js'
import { detectWorkspace } from '../src/workspace/detector.js'
import type { Workspace } from '../src/domain/types/workspace.js'
import type { CommandRequest } from '../src/engineering/command.js'

/**
 * Terminal UX for the engineering loop (Phase 3): the banner, GOAL,
 * PLAN, PROPOSED CHANGES, DIFF, APPLYING, VERIFYING, LUNAR COMPLETE —
 * plus bounded-stop messaging. Rendering only; the loop is scripted.
 */

let base: string
let workspace: Workspace

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-ux-'))
  fs.mkdirSync(path.join(base, 'src'), { recursive: true })
  workspace = detectWorkspace(base)
})

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const plan = JSON.stringify({
  goal: 'Add a health module',
  steps: [
    { id: 'inspect', description: 'Inspect the project layout' },
    { id: 'implement', description: 'Implement the health module' },
    { id: 'verify', description: 'Run the tests to verify' },
  ],
})

const goodProposal = JSON.stringify({
  summary: 'Create the health module',
  changes: [
    {
      path: 'src/health.js',
      operation: 'create',
      content: 'module.exports.health = () => "OK";\n',
      reason: 'the task needs it',
    },
  ],
})

function passingCommand(): CommandRequest {
  return { executable: 'node', args: ['-e', 'process.stdout.write("2 passed");'], cwd: '.' }
}

function failingCommand(): CommandRequest {
  return {
    executable: 'node',
    args: ['-e', 'process.stderr.write("1 failed"); process.exit(1)'],
    cwd: '.',
  }
}

/** Capture everything the command writes to stdout/stderr. */
async function render(
  task: string,
  provider: MockProvider,
  command: CommandRequest,
  loopLimits: Record<string, unknown> = {},
): Promise<{ output: string; exitCode: number }> {
  const chunks: string[] = []
  const capture = (chunk: string | Uint8Array): boolean => {
    chunks.push(chunk.toString())
    return true
  }
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(capture as typeof process.stdout.write)
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(capture as typeof process.stderr.write)
  try {
    const loop = new EngineeringLoop({
      provider,
      model: provider.defaultModel,
      workspace,
      logger: createSilentLogger(),
      permissions: new PermissionManager(PHASE3_AUTO_POLICY),
      approval: autoApprove,
      testCommand: command,
      limits: loopLimits,
    })
    const exitCode = await runEngineer({
      task,
      loop,
      version: '0.0.0-test',
      logger: createSilentLogger(),
    })
    return { output: chunks.join(''), exitCode }
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
}

describe('lunar "<task>" --engineer (terminal UX)', () => {
  it('renders the complete happy-path flow', async () => {
    const provider = new MockProvider({ script: [{ response: plan }, { response: goodProposal }] })
    const { output, exitCode } = await render('Add a health module', provider, passingCommand())

    expect(exitCode).toBe(0)
    expect(output).toContain('Autonomous Engineering')
    expect(output).toContain('GOAL')
    expect(output).toContain('Add a health module')
    expect(output).toContain('PLAN')
    expect(output).toContain('Inspect the project layout')
    expect(output).toContain('PROPOSED CHANGES')
    expect(output).toContain('A src/health.js')
    expect(output).toContain('DIFF')
    expect(output).toContain('+module.exports.health')
    expect(output).toContain('APPLYING CHANGES')
    expect(output).toContain('VERIFYING')
    expect(output).toContain('LUNAR COMPLETE')
    expect(output).toContain('1 file changed')
  })

  it('renders verification failure and the diagnosis on retry', async () => {
    const bad = JSON.stringify({
      summary: 'Create it wrong',
      changes: [
        { path: 'src/health.js', operation: 'create', content: 'WRONG\n', reason: 'r' },
      ],
    })
    const fix = JSON.stringify({
      diagnosis: 'The checker wants OK in the file.',
      summary: 'Fix the content',
      changes: [
        {
          path: 'src/health.js',
          operation: 'update',
          content: 'module.exports.health = () => "OK";\n',
          reason: 'make it pass',
        },
      ],
    })
    const provider = new MockProvider({
      script: [{ response: plan }, { response: bad }, { response: fix }],
    })
    const { output, exitCode } = await render(
      'Add a health module',
      provider,
      { executable: 'node', args: ['-e', 'process.exit(1)'], cwd: '.' },
      { maxIterations: 2 },
    )
    // The command always fails: attempt 1 fails, the corrective attempt
    // 2 (with diagnosis) is applied and fails again → STOPPED.
    expect(exitCode).toBe(1)
    expect(output).toContain('VERIFICATION FAILED')
    expect(output).toContain('DIAGNOSIS (attempt 2)')
    expect(output).toContain('The checker wants OK in the file.')
    expect(output).toContain('LUNAR STOPPED')
  })

  it('renders LUNAR STOPPED when the retry budget is exhausted', async () => {
    const bad = JSON.stringify({
      summary: 'Create it wrong',
      changes: [
        { path: 'src/health.js', operation: 'create', content: 'WRONG\n', reason: 'r' },
      ],
    })
    const badFix = JSON.stringify({
      diagnosis: 'Still wrong.',
      summary: 'Retry',
      changes: [
        { path: 'src/health.js', operation: 'update', content: 'STILL WRONG\n', reason: 'r' },
      ],
    })
    const provider = new MockProvider({
      script: [{ response: plan }, { response: bad }, { response: badFix }, { response: badFix }],
    })
    const { output, exitCode } = await render('Add a health module', provider, failingCommand(), {
      maxIterations: 3,
    })
    expect(exitCode).toBe(1)
    expect(output).toContain('LUNAR STOPPED')
    expect(output).toContain('Maximum engineering iterations reached')
    expect(output).toContain('Last failure:')
  })

  it('renders research tool activity', async () => {
    const provider = new MockProvider({
      script: [
        { response: plan },
        { toolCalls: [{ id: 't1', name: 'list_directory', arguments: { path: '.' } }] },
        { response: goodProposal },
      ],
    })
    const { output } = await render('Add a health module', provider, passingCommand())
    expect(output).toContain('◇ list_directory')
    expect(output).toContain('✓ list_directory')
    expect(output).toContain('LUNAR COMPLETE')
  })
})
