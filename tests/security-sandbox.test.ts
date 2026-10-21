import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandExecutor } from '../src/engineering/command.js'
import type { CommandAuditEvent } from '../src/engineering/command.js'
import { autoCommandApprove, denyCommand } from '../src/engineering/approval.js'
import { resolveLimits } from '../src/engineering/limits.js'
import { createSandbox, DenySandbox, RestrictedSandbox } from '../src/engineering/sandbox.js'
import { CommandPolicy } from '../src/security/policy.js'
import { resolveExecutable } from '../src/security/executable-resolver.js'
import { isToolError, ToolError } from '../src/tools/errors.js'
import { detectWorkspace } from '../src/workspace/detector.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Sandbox + executor integration (Phase 4 security matrix): the
 * sandbox's promises are verified against REAL child processes — the
 * environment is actually filtered, timeouts actually kill, and the
 * fail-closed mode actually denies.
 */

let root: string
let workspace: Workspace

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-sandbox-'))
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
  fragment?: string,
): Promise<void> {
  try {
    await fn()
    expect.unreachable('expected a ToolError')
  } catch (error) {
    expect(isToolError(error)).toBe(true)
    expect((error as ToolError).kind).toBe(kind)
    if (fragment !== undefined) expect((error as ToolError).message).toContain(fragment)
  }
}

describe('RestrictedSandbox — real enforcement', () => {
  it('reports its level honestly (never "ENABLED")', () => {
    const description = new RestrictedSandbox().describe()
    expect(description.level).toBe('restricted')
    expect(description.label).toBe('RESTRICTED FALLBACK')
  })

  it('passes a FILTERED environment to the child — secrets never inherit', async () => {
    process.env['LUNAR_API_KEY'] = 'lunar-secret-key'
    process.env['SOME_RANDOM_TOKEN'] = 'tok-123'
    try {
      const result = await executor().run({
        executable: 'node',
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({k: process.env.LUNAR_API_KEY ?? null, t: process.env.SOME_RANDOM_TOKEN ?? null, p: typeof process.env.PATH}))',
        ],
      })
      const seen = JSON.parse(result.stdout) as { k: string | null; t: string | null; p: string }
      expect(seen.k).toBeNull()
      expect(seen.t).toBeNull()
      expect(seen.p).toBe('string') // PATH survives — tools still resolve
    } finally {
      delete process.env['LUNAR_API_KEY']
      delete process.env['SOME_RANDOM_TOKEN']
    }
  })

  it('rejects a cwd that escapes the workspace', async () => {
    await expectToolError(
      () => executor().run({ executable: 'node', args: ['--version'], cwd: '../..' }),
      'path_outside_workspace',
    )
  })

  it('kills a timed-out command and its whole process tree', async () => {
    // The grandchild would write a marker AFTER the parent is killed.
    // If tree termination works, the marker never appears. The marker
    // path is passed to the grandchild as argv (no nested quoting).
    const marker = path.join(root, 'escaped.txt')
    const grandchild = "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 1500)"
    const script = [
      'const cp = require("child_process");',
      `cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}], { stdio: "ignore" });`,
      'setTimeout(() => {}, 10000);', // parent stays "busy" until killed
    ].join(' ')
    const result = await executor().run({
      executable: 'node',
      args: ['-e', script],
      timeoutMs: 400,
    })
    expect(result.timedOut).toBe(true)
    // Well past the grandchild's write deadline.
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe('DenySandbox — fail closed', () => {
  it('refuses to prepare any execution context', async () => {
    const sandbox = new DenySandbox()
    expect(sandbox.describe().level).toBe('unavailable')
    const denying = executor({ sandbox, approval: autoCommandApprove })
    await expectToolError(
      () => denying.run({ executable: 'node', args: ['--version'] }),
      'permission_denied',
      'denied',
    )
  })

  it('is selected by sandbox mode "deny"', () => {
    expect(createSandbox('deny')).toBeInstanceOf(DenySandbox)
    expect(createSandbox('auto')).toBeInstanceOf(RestrictedSandbox)
  })
})

describe('CommandExecutor — pipeline integration', () => {
  it('runs a SAFE command without any approval prompt', async () => {
    const result = await executor({ approval: denyCommand }).run({
      executable: 'node',
      args: ['--version'],
    })
    expect(result.exitCode).toBe(0)
  })

  it('asks for a REVIEW command and honors a refusal', async () => {
    let asked = 0
    const refusing = executor({
      approval: {
        approveCommand: async () => {
          asked += 1
          return false
        },
      },
    })
    await expectToolError(
      () => refusing.run({ executable: 'node', args: ['script.js'] }),
      'permission_denied',
      'not approved',
    )
    expect(asked).toBe(1)
  })

  it('never runs a hard-denied command, even with auto-approval', async () => {
    const allowing = executor({
      approval: autoCommandApprove,
      allowedCommands: ['curl'], // even when allowlisted by config
      policy: new CommandPolicy({ trusted: true }),
    })
    await expectToolError(
      () => allowing.run({ executable: 'curl', args: ['https://evil.example'] }),
      'permission_denied',
      'denied',
    )
  })

  it('trusted mode auto-allows REVIEW but still asks for DANGEROUS', async () => {
    const trusted = executor({
      policy: new CommandPolicy({ trusted: true }),
      approval: denyCommand,
    })
    // node -e is dangerous → the denyCommand gate refuses it.
    await expectToolError(
      () => trusted.run({ executable: 'node', args: ['-e', 'process.exit(0)'] }),
      'permission_denied',
    )
  })

  it('enforces the concurrency limit', async () => {
    const limited = executor({ limits: resolveLimits({ maxConcurrentCommands: 1 }) })
    const sleeper = limited.run({
      executable: 'node',
      args: ['-e', 'setTimeout(() => {}, 300)'],
    })
    // Give the first command time to start.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await expectToolError(
      () => limited.run({ executable: 'node', args: ['--version'] }),
      'execution_error',
      'Concurrent command limit',
    )
    await sleeper
  })

  it('emits the complete audit trail for a blocked command', async () => {
    const events: string[] = []
    const auditing = executor({
      onAudit: (event: CommandAuditEvent) => events.push(event.type),
      approval: denyCommand,
    })
    await expectToolError(() => auditing.run({ executable: 'git', args: ['push'] }), 'permission_denied')
    expect(events).toContain('proposed')
    expect(events).toContain('normalized')
    expect(events).toContain('policy_evaluated')
    expect(events).toContain('blocked')
    expect(events).not.toContain('started')
  })

  it('emits the full trail for a completed command', async () => {
    const events: string[] = []
    const auditing = executor({ onAudit: (event: CommandAuditEvent) => events.push(event.type) })
    await auditing.run({ executable: 'node', args: ['--version'] })
    expect(events).toEqual([
      'proposed',
      'normalized',
      'classified',
      'policy_evaluated',
      'permission_granted',
      'sandbox_prepared',
      'started',
      'completed',
    ])
  })
})

describe('resolveExecutable — fail-closed resolution', () => {
  it('resolves the bare name to an absolute path on PATH', () => {
    const resolved = resolveExecutable('node', { PATH: path.dirname(process.execPath) })
    expect(path.isAbsolute(resolved)).toBe(true)
    expect(resolved.toLowerCase()).toContain('node')
  })

  it('reports a missing executable as a controlled execution error', () => {
    try {
      resolveExecutable('ghost-executable-12345', { PATH: root })
      expect.unreachable('expected a ToolError')
    } catch (error) {
      expect((error as ToolError).kind).toBe('execution_error')
    }
  })

  it.runIf(process.platform === 'win32')(
    'refuses to launch a batch file (.cmd) instead of routing through a shell',
    () => {
      fs.writeFileSync(path.join(root, 'fakecmd.cmd'), '@echo off\r\n')
      try {
        resolveExecutable('fakecmd', { PATH: root })
        expect.unreachable('expected a ToolError')
      } catch (error) {
        expect((error as ToolError).kind).toBe('permission_denied')
        expect((error as ToolError).message).toContain('batch')
      }
    },
  )
})
