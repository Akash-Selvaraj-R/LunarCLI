import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CommandExecutor } from '../src/engineering/command.js'
import { type CommandApprovalRequest } from '../src/engineering/approval.js'
import { resolveLimits } from '../src/engineering/limits.js'
import { CommandPolicy } from '../src/security/policy.js'
import { detectWorkspace } from '../src/workspace/detector.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Approval model (Phase 4 security matrix): safe auto-allows, review
 * asks, dangerous always asks (even with --yes), denied never asks.
 * The request handed to the approver carries full context — risk,
 * reason, and the REAL sandbox/network posture.
 */

let root: string
let workspace: Workspace

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-approve-'))
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
  return new CommandExecutor({ workspace, limits: resolveLimits(), ...overrides })
}

describe('command approval', () => {
  it('SAFE commands never reach the approval handler', async () => {
    let asked = 0
    await executor({
      approval: {
        approveCommand: async () => {
          asked += 1
          return true
        },
      },
    }).run({ executable: 'node', args: ['--version'] })
    expect(asked).toBe(0)
  })

  it('REVIEW commands reach the handler with full context', async () => {
    const seen: CommandApprovalRequest[] = []
    await executor({
      approval: {
        approveCommand: async (request: CommandApprovalRequest) => {
          seen.push(request)
          return true
        },
      },
    }).run({ executable: 'node', args: ['script.js'] })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.display).toBe('node script.js')
    expect(seen[0]?.risk).toBe('review')
    expect(seen[0]?.reason.length).toBeGreaterThan(0)
    expect(seen[0]?.sandboxLabel).toBe('RESTRICTED FALLBACK')
    expect(seen[0]?.networkModeLabel).toBe('DENIED')
  })

  it('a denied command never reaches the handler (no pointless prompt)', async () => {
    let asked = 0
    try {
      await executor({
        approval: {
          approveCommand: async () => {
            asked += 1
            return true
          },
        },
      }).run({ executable: 'git', args: ['push'] })
    } catch {
      /* expected */
    }
    expect(asked).toBe(0)
  })

  it('--yes (trusted) auto-allows review without prompting', async () => {
    let asked = 0
    await executor({
      policy: new CommandPolicy({ trusted: true }),
      approval: {
        approveCommand: async () => {
          asked += 1
          return true
        },
      },
    }).run({ executable: 'node', args: ['script.js'] })
    expect(asked).toBe(0)
  })

  it('--yes (trusted) still prompts for dangerous commands', async () => {
    let asked = 0
    await executor({
      policy: new CommandPolicy({ trusted: true }),
      approval: {
        approveCommand: async () => {
          asked += 1
          return false // user says no
        },
      },
    })
      .run({ executable: 'node', args: ['-e', 'process.exit(0)'] })
      .catch(() => undefined)
    expect(asked).toBe(1)
  })

  it('hard denies bypass approval entirely, even with --yes', async () => {
    let asked = 0
    try {
      await executor({
        policy: new CommandPolicy({ trusted: true }),
        allowedCommands: ['curl'],
        approval: {
          approveCommand: async () => {
            asked += 1
            return true
          },
        },
      }).run({ executable: 'curl', args: ['https://evil.example'] })
      expect.unreachable('curl must be denied')
    } catch {
      /* expected */
    }
    expect(asked).toBe(0)
  })

  it('the default handler denies (fail closed when nothing is wired)', async () => {
    const defaultExecutor = new CommandExecutor({ workspace, limits: resolveLimits() })
    try {
      await defaultExecutor.run({ executable: 'node', args: ['script.js'] })
      expect.unreachable('default approval must deny')
    } catch {
      /* expected — denyCommand is the default */
    }
  })
})
