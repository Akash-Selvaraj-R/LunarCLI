import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectWorkspace } from '../src/workspace/detector.js'
import type { Workspace } from '../src/domain/types/workspace.js'
import { MockProvider } from '../src/providers/mock.js'
import { createSilentLogger } from '../src/logging/logger.js'
import { PermissionManager, PHASE3_ASK_POLICY, PHASE3_AUTO_POLICY } from '../src/permissions/permission-manager.js'
import { autoApprove, autoCommandApprove, denyAll } from '../src/engineering/approval.js'
import type { ApprovalHandler, ApprovalRequest } from '../src/engineering/approval.js'
import { EngineeringLoop } from '../src/engineering/loop.js'
import type { EngineeringEvent } from '../src/engineering/events.js'
import type { CommandRequest } from '../src/engineering/command.js'

/**
 * Full engineering-loop flows (Phase 3).
 *
 * Every scenario runs in a throwaway temp directory with a scripted
 * MockProvider — the actual Lunar repository is never touched. These
 * tests are the executable Definition of Done:
 *
 *   PLAN → PROPOSE → APPROVE → APPLY → VERIFY → COMPLETE
 *   PLAN → PROPOSE → APPLY → VERIFY → FAIL → DIAGNOSE → FIX → VERIFY → COMPLETE
 */

let base: string
let workspace: Workspace
let events: EngineeringEvent[]

const collect = (event: EngineeringEvent): void => {
  events.push(event)
}

/** JSON plan the scripted model returns. */
function planJson(): string {
  return JSON.stringify({
    goal: 'Add a health module',
    steps: [
      { id: 'inspect', description: 'Inspect the project layout' },
      { id: 'implement', description: 'Implement the health module' },
      { id: 'verify', description: 'Run the tests to verify' },
    ],
  })
}

/** JSON proposal creating one file. */
function proposalJson(file: string, content: string): string {
  return JSON.stringify({
    summary: `Create ${file}`,
    changes: [
      {
        path: file,
        operation: 'create',
        content,
        reason: 'the task needs this module',
      },
    ],
  })
}

/** JSON corrective proposal (with diagnosis) updating one file. */
function fixJson(file: string, oldContent: string, content: string): string {
  return JSON.stringify({
    diagnosis: 'The checker requires the literal marker OK in the file.',
    summary: `Fix ${file} to satisfy the checker`,
    changes: [
      {
        path: file,
        operation: 'update',
        oldContent,
        content,
        reason: 'make the verification pass',
      },
    ],
  })
}

/** A corrective proposal that still fails verification (keeps retrying). */
function diagnosisBadJson(file: string, content: string): string {
  return JSON.stringify({
    diagnosis: 'Still wrong — retrying with different content.',
    summary: `Retry ${file}`,
    changes: [{ path: file, operation: 'update', content, reason: 'retry' }],
  })
}

/**
 * A controlled verification command: passes only when `file` exists and
 * contains `marker`. Runs through the real CommandExecutor (node is on
 * the allowlist; no shell).
 */
function checkCommand(file: string, marker: string): CommandRequest {
  const script = [
    'const fs = require("fs");',
    `const ok = fs.existsSync(${JSON.stringify(file)}) &&`,
    `  fs.readFileSync(${JSON.stringify(file)}, "utf8").includes(${JSON.stringify(marker)});`,
    'if (!ok) { process.stderr.write("check failed: marker missing"); process.exit(1); }',
    'process.stdout.write("1 passed");',
  ].join(' ')
  return { executable: 'node', args: ['-e', script], cwd: '.' }
}

function loopWith(
  script: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): EngineeringLoop {
  const provider = new MockProvider({ script } as ConstructorParameters<typeof MockProvider>[0])
  return new EngineeringLoop({
    provider,
    model: provider.defaultModel,
    workspace,
    logger: createSilentLogger(),
    permissions: new PermissionManager(PHASE3_AUTO_POLICY),
    approval: autoApprove,
    // Phase 4: the harness explicitly approves its REVIEW-class
    // verification command (node -e), keeping assertions unchanged.
    commandApproval: autoCommandApprove,
    testCommand: checkCommand('src/health.js', 'OK'),
    onEvent: collect,
    ...overrides,
  })
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-loop-'))
  fs.mkdirSync(path.join(base, 'src'), { recursive: true })
  fs.writeFileSync(path.join(base, 'README.md'), '# fixture\n')
  workspace = detectWorkspace(base)
  events = []
})

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('EngineeringLoop — happy path', () => {
  it('PLAN → PROPOSE → APPROVE → APPLY → VERIFY → COMPLETE', async () => {
    const loop = loopWith([
      { response: planJson() },
      { response: proposalJson('src/health.js', 'module.exports.health = () => "OK";\n') },
    ])

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('success')
    if (outcome.status !== 'success') return
    expect(outcome.iterations).toBe(1)
    expect(outcome.applied).toHaveLength(1)
    expect(outcome.verification.ok).toBe(true)

    // The file really exists with the proposed content.
    const written = fs.readFileSync(path.join(base, 'src', 'health.js'), 'utf8')
    expect(written).toContain('health')

    // Event flow is complete and ordered.
    const types = events.map((event) => event.type)
    expect(types).toContain('goal')
    expect(types).toContain('plan')
    expect(types).toContain('proposal')
    expect(types).toContain('approval')
    expect(types).toContain('apply_started')
    expect(types).toContain('change_applied')
    expect(types).toContain('verifying')
    expect(types).toContain('verification_passed')
    expect(types[types.length - 1]).toBe('complete')
  })

  it('researches with read-only tools before proposing', async () => {
    const loop = loopWith([
      { response: planJson() },
      // The model lists the directory first, then proposes.
      {
        toolCalls: [{ id: 't1', name: 'list_directory', arguments: { path: '.' } }],
      },
      { response: proposalJson('src/health.js', 'module.exports.health = () => "OK";\n') },
    ])

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('success')
    const toolEvents = events.filter((event) => event.type === 'tool_call')
    expect(toolEvents).toHaveLength(1)
    expect(events.find((event) => event.type === 'tool_result')?.success).toBe(true)
  })
})

describe('EngineeringLoop — corrective iteration', () => {
  it('PLAN → PROPOSE → APPLY → VERIFY → FAIL → DIAGNOSE → FIX → VERIFY → COMPLETE', async () => {
    const bad = 'module.exports.health = () => "WRONG";\n'
    const good = 'module.exports.health = () => "OK";\n'
    const loop = loopWith([
      { response: planJson() },
      { response: proposalJson('src/health.js', bad) },
      { response: fixJson('src/health.js', bad, good) },
    ])

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('success')
    if (outcome.status !== 'success') return
    expect(outcome.iterations).toBe(2)
    expect(fs.readFileSync(path.join(base, 'src', 'health.js'), 'utf8')).toBe(good)

    // The failure was observed, then a fix was proposed with a diagnosis.
    const types = events.map((event) => event.type)
    expect(types).toContain('verification_failed')
    const proposalEvents = events.filter((event) => event.type === 'proposal')
    expect(proposalEvents).toHaveLength(2)
    const second = proposalEvents[1]
    expect(second?.type === 'proposal' ? second.diagnosis : undefined).toContain('marker')
    expect(types[types.length - 1]).toBe('complete')
  })
})

describe('EngineeringLoop — permission gate', () => {
  it('denies by default when the handler rejects (nothing is written)', async () => {
    const loop = loopWith([{ response: planJson() }, { response: proposalJson('src/health.js', 'x') }], {
      permissions: new PermissionManager(PHASE3_ASK_POLICY),
      approval: denyAll,
    })

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('denied')
    expect(fs.existsSync(path.join(base, 'src', 'health.js'))).toBe(false)
    const approval = events.find((event) => event.type === 'approval')
    expect(approval?.type === 'approval' ? approval.approved : undefined).toBe(false)
    expect(approval?.type === 'approval' ? approval.mode : undefined).toBe('prompt')
  })

  it('applies after an explicit approval, passing the request to the handler', async () => {
    const seen: ApprovalRequest[] = []
    const approving: ApprovalHandler = {
      approve: async (request) => {
        seen.push(request)
        return true
      },
    }
    const loop = loopWith(
      [{ response: planJson() }, { response: proposalJson('src/health.js', 'module.exports.health = () => "OK";\n') }],
      {
        permissions: new PermissionManager(PHASE3_ASK_POLICY),
        approval: approving,
      },
    )

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('success')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.changes[0]?.path).toBe('src/health.js')
    expect(seen[0]?.summary).toContain('Create src/health.js')
  })

  it('auto-approves under --yes (PHASE3_AUTO_POLICY)', async () => {
    const loop = loopWith([
      { response: planJson() },
      { response: proposalJson('src/health.js', 'module.exports.health = () => "OK";\n') },
    ])
    const outcome = await loop.run('Add a health module', { onEvent: collect })
    expect(outcome.status).toBe('success')
    const approval = events.find((event) => event.type === 'approval')
    expect(approval?.type === 'approval' ? approval.mode : undefined).toBe('auto')
  })
})

describe('EngineeringLoop — hard limits', () => {
  it('stops after the retry budget is exhausted', async () => {
    const loop = loopWith(
      [
        { response: planJson() },
        { response: proposalJson('src/health.js', 'WRONG\n') },
        { response: diagnosisBadJson('src/health.js', 'STILL WRONG\n') },
        { response: diagnosisBadJson('src/health.js', 'ALSO WRONG\n') },
      ],
      { limits: { maxIterations: 3 } },
    )

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('stopped')
    if (outcome.status !== 'stopped') return
    expect(outcome.reason).toBe('max_iterations')
    expect(outcome.iterations).toBe(3)
    // The last approved attempt's changes remain, clearly flagged.
    expect(fs.existsSync(path.join(base, 'src', 'health.js'))).toBe(true)
    expect(events.map((event) => event.type)).toContain('stopped')
  })

  it('stops when the mutation budget would be exceeded', async () => {
    const big = JSON.stringify({
      summary: 'Create many files',
      changes: Array.from({ length: 5 }, (_, index) => ({
        path: `src/f${index}.js`,
        operation: 'create',
        content: 'x',
        reason: 'r',
      })),
    })
    const loop = loopWith([{ response: planJson() }, { response: big }], {
      limits: { maxMutations: 2 },
    })

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('stopped')
    if (outcome.status !== 'stopped') return
    expect(outcome.reason).toBe('max_mutations')
    expect(fs.readdirSync(path.join(base, 'src'))).toEqual([])
  })

  it('stops when the command budget is exhausted', async () => {
    const loop = loopWith(
      [
        { response: planJson() },
        { response: proposalJson('src/health.js', 'WRONG\n') },
        { response: diagnosisBadJson('src/health.js', 'STILL WRONG\n') },
      ],
      { limits: { maxIterations: 3, maxCommands: 1 } },
    )

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('stopped')
    if (outcome.status !== 'stopped') return
    expect(outcome.reason).toBe('max_commands')
  })
})

describe('EngineeringLoop — controlled model-output failures', () => {
  it('rejects a path-traversal proposal and writes nothing outside the workspace', async () => {
    const escape = JSON.stringify({
      summary: 'Escape!',
      changes: [
        { path: '../../escaped.txt', operation: 'create', content: 'pwned', reason: 'malicious' },
      ],
    })
    const loop = loopWith([{ response: planJson() }, { response: escape }, { response: escape }], {
      limits: { jsonRetries: 1 },
    })

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('error')
    expect(fs.existsSync(path.join(path.dirname(base), 'escaped.txt'))).toBe(false)
    // The repository itself is untouched.
    expect(fs.readdirSync(path.join(base, 'src'))).toEqual([])
  })

  it('errors out on malformed plan JSON after bounded corrections', async () => {
    const loop = loopWith([{ response: 'not json at all' }, { response: 'still not json' }], {
      limits: { jsonRetries: 1 },
    })

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('error')
    if (outcome.status !== 'error') return
    expect(outcome.error.message).toMatch(/not valid JSON|no JSON object/i)
    expect(fs.readdirSync(path.join(base, 'src'))).toEqual([])
  })

  it('requires a diagnosis on corrective proposals', async () => {
    const noDiagnosis = JSON.stringify({
      summary: 'Silent fix',
      changes: [
        { path: 'src/health.js', operation: 'create', content: 'x', reason: 'r' },
      ],
    })
    const bad = proposalJson('src/health.js', 'WRONG\n')
    const loop = loopWith(
      [{ response: planJson() }, { response: bad }, { response: noDiagnosis }, { response: noDiagnosis }],
      { limits: { jsonRetries: 1 } },
    )

    const outcome = await loop.run('Add a health module', { onEvent: collect })

    expect(outcome.status).toBe('error')
  })
})
