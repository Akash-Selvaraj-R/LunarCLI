import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandExecutor } from '../src/engineering/command.js'
import { autoCommandApprove } from '../src/engineering/approval.js'
import { resolveLimits } from '../src/engineering/limits.js'
import { isToolError, ToolError } from '../src/tools/errors.js'
import { detectWorkspace } from '../src/workspace/detector.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Controlled command execution (Phase 3): allowlisted bare executables,
 * no shell, workspace-bound cwd, hard timeouts, bounded output. Every
 * failure mode is structured — nothing here can run arbitrary strings.
 */

let root: string
let workspace: Workspace

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-command-'))
  workspace = detectWorkspace(root)
})

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function executor(overrides = {}): CommandExecutor {
  // Phase 4: `node -e` is a REVIEW-class command (inline code). The
  // harness is the trusted user, so it grants approval explicitly.
  return new CommandExecutor({
    workspace,
    limits: resolveLimits(),
    approval: autoCommandApprove,
    ...overrides,
  })
}

async function expectToolError(
  fn: () => Promise<unknown>,
  kind: string,
): Promise<void> {
  try {
    await fn()
    expect.unreachable('expected a ToolError')
  } catch (error) {
    expect(isToolError(error)).toBe(true)
    expect((error as ToolError).kind).toBe(kind)
  }
}

describe('CommandExecutor.run — structured results', () => {
  it('runs a successful command and captures stdout', async () => {
    const result = await executor().run({
      executable: 'node',
      args: ['-e', "process.stdout.write('hello from lunar')"],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello from lunar')
    expect(result.timedOut).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('captures a non-zero exit code', async () => {
    const result = await executor().run({ executable: 'node', args: ['-e', 'process.exit(3)'] })
    expect(result.exitCode).toBe(3)
  })

  it('captures stderr separately from stdout', async () => {
    const result = await executor().run({
      executable: 'node',
      args: ['-e', "process.stderr.write('problem details'); process.stdout.write('normal')"],
    })
    expect(result.stdout).toBe('normal')
    expect(result.stderr).toBe('problem details')
    expect(result.exitCode).toBe(0)
  })

  it('passes arguments without any shell interpretation', async () => {
    // If a shell were involved, these metacharacters would be dangerous.
    const result = await executor().run({
      executable: 'node',
      args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', 'a && echo injected; b | c'],
    })
    expect(result.stdout).toBe('a && echo injected; b | c')
  })

  it('runs inside the workspace cwd', async () => {
    fs.writeFileSync(path.join(root, 'marker.txt'), 'x')
    const result = await executor().run({ executable: 'node', args: ['-e', ''], cwd: '.' })
    expect(result.exitCode).toBe(0)
  })
})

describe('CommandExecutor — timeouts and output caps', () => {
  it('kills a command that exceeds its timeout', async () => {
    const startedAt = Date.now()
    const result = await executor().run(
      { executable: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 400 },
    )
    expect(result.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('caps runaway output and kills the process', async () => {
    const strict = executor({ limits: resolveLimits({ maxOutputBytes: 2_000 }) })
    const result = await strict.run({
      executable: 'node',
      args: ['-e', "for (let i = 0; i < 500; i++) process.stdout.write('x'.repeat(1000))"],
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(4_000)
  })
})

describe('CommandExecutor — validation gates', () => {
  it('rejects executables containing a path separator', async () => {
    await expectToolError(
      () => executor().run({ executable: './node', args: [] }),
      'invalid_input',
    )
  })

  it('rejects absolute executable paths', async () => {
    await expectToolError(
      () => executor().run({ executable: 'C:\\Windows\\cmd.exe', args: [] }),
      'invalid_input',
    )
  })

  it('rejects non-allowlisted executables', async () => {
    await expectToolError(
      () => executor().run({ executable: 'format', args: ['C:'] }),
      'permission_denied',
    )
  })

  it('rejects shell built-ins even when spelled out', async () => {
    await expectToolError(
      () => executor().run({ executable: 'cmd', args: ['/c', 'dir'] }),
      'permission_denied',
    )
  })

  it('honours an explicit allowlist override', async () => {
    const custom = executor({ allowedCommands: ['definitely-not-node'] })
    await expectToolError(() => custom.run({ executable: 'node', args: [] }), 'permission_denied')
  })

  it('rejects a cwd that escapes the workspace', async () => {
    await expectToolError(
      () => executor().run({ executable: 'node', args: [], cwd: '../..' }),
      'path_outside_workspace',
    )
  })

  it('rejects a cwd that is a file', async () => {
    fs.writeFileSync(path.join(root, 'afile.txt'), 'x')
    await expectToolError(
      () => executor().run({ executable: 'node', args: [], cwd: 'afile.txt' }),
      'not_a_file',
    )
  })

  it('rejects too many arguments', async () => {
    const args = Array.from({ length: 40 }, (_, index) => `arg${index}`)
    await expectToolError(() => executor().run({ executable: 'node', args }), 'invalid_input')
  })

  it('rejects oversized individual arguments', async () => {
    await expectToolError(
      () => executor().run({ executable: 'node', args: ['x'.repeat(9_000)] }),
      'invalid_input',
    )
  })

  it('reports an allowlisted executable that is not installed', async () => {
    const ghost = executor({ allowedCommands: ['ghost-executable-12345'] })
    await expectToolError(
      () => ghost.run({ executable: 'ghost-executable-12345', args: [] }),
      'execution_error',
    )
  })
})
