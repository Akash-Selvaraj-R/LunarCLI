import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigurationError } from '../src/domain/errors/index.js'
import { normalizeCommand } from '../src/security/normalizer.js'
import { CommandPolicy } from '../src/security/policy.js'
import type { CommandDecisionKind } from '../src/security/policy.js'
import { loadProjectPolicy } from '../src/security/project-policy.js'
import type { ProjectPolicy } from '../src/security/project-policy.js'

/**
 * Command policy precedence (Phase 4 security matrix):
 *
 *   hard deny > global policy > project policy > user approval
 *
 * The project policy is UNTRUSTED repo content: it may tighten, may
 * widen only REVIEW-class commands, and can never touch denied or
 * dangerous ones.
 */

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-policy-'))
})

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function decide(
  executable: string,
  args: string[] = [],
  options: { trusted?: boolean; project?: ProjectPolicy } = {},
): CommandDecisionKind {
  return new CommandPolicy(options).evaluate(normalizeCommand({ executable, args })).decision
}

function writePolicy(contents: string): void {
  fs.mkdirSync(path.join(root, '.lunar'), { recursive: true })
  fs.writeFileSync(path.join(root, '.lunar', 'policy.json'), contents)
}

const benignPolicy: ProjectPolicy = {
  commands: new Map([['npm run legacy', 'allow']]),
  source: 'test',
}

describe('CommandPolicy — global mapping', () => {
  it('allows safe, asks for review, asks for dangerous, denies denied', () => {
    expect(decide('npm', ['test'])).toBe('allow')
    expect(decide('npm', ['install'])).toBe('ask')
    expect(decide('node', ['-e', 'x'])).toBe('ask')
    expect(decide('git', ['push'])).toBe('deny')
    expect(decide('curl', ['https://x'])).toBe('deny')
  })

  it('trusted mode auto-allows review but NEVER dangerous', () => {
    const trusted = { trusted: true }
    expect(decide('npm', ['install'], trusted)).toBe('allow')
    expect(decide('node', ['-e', 'x'], trusted)).toBe('ask') // still prompts
    expect(decide('git', ['push'], trusted)).toBe('deny') // never
    expect(decide('curl', [], trusted)).toBe('deny') // never
  })
})

describe('CommandPolicy — project overlay', () => {
  it('project allow widens a REVIEW command to allow', () => {
    expect(decide('npm', ['run', 'legacy'], { project: benignPolicy })).toBe('allow')
  })

  it('project deny tightens a SAFE command to deny', () => {
    const policy: ProjectPolicy = {
      commands: new Map([['npm test', 'deny']]),
      source: 'test',
    }
    expect(decide('npm', ['test'], { project: policy })).toBe('deny')
  })

  it('project allow can NEVER grant a hard-denied command', () => {
    const policy: ProjectPolicy = {
      commands: new Map([
        ['git push', 'allow'],
        ['curl https://evil.example', 'allow'],
      ]),
      source: 'test',
    }
    expect(decide('git', ['push'], { project: policy })).toBe('deny')
    expect(decide('curl', ['https://evil.example'], { project: policy })).toBe('deny')
  })

  it('project allow can NEVER auto-allow a dangerous command', () => {
    const policy: ProjectPolicy = {
      commands: new Map([['node -e process.exit(0)', 'allow']]),
      source: 'test',
    }
    expect(decide('node', ['-e', 'process.exit(0)'], { project: policy })).toBe('ask')
  })

  it('project ask can downgrade an auto-approved review command', () => {
    const policy: ProjectPolicy = {
      commands: new Map([['npm install', 'ask']]),
      source: 'test',
    }
    expect(decide('npm', ['install'], { trusted: true, project: policy })).toBe('ask')
  })

  it('matches keys exactly — argument case is significant', () => {
    const policy: ProjectPolicy = {
      commands: new Map([['npm run build', 'deny']]),
      source: 'test',
    }
    // Exact match on the normalized display: 'BUILD' is a different
    // (review-class → ask) command than 'build' (denied by policy).
    expect(decide('npm', ['run', 'build'], { project: policy })).toBe('deny')
    expect(decide('npm', ['run', 'BUILD'], { project: policy })).toBe('ask')
  })
})

describe('loadProjectPolicy — fail closed', () => {
  it('returns undefined when no policy file exists', () => {
    expect(loadProjectPolicy(root)).toBeUndefined()
  })

  it('loads a valid policy', () => {
    writePolicy(JSON.stringify({ commands: { 'npm test': 'allow', 'npm install': 'deny' } }))
    const policy = loadProjectPolicy(root)
    expect(policy?.commands.get('npm test')).toBe('allow')
    expect(policy?.commands.get('npm install')).toBe('deny')
  })

  it('rejects malformed JSON (fails closed, never "no policy")', () => {
    writePolicy('{ not json')
    expect(() => loadProjectPolicy(root)).toThrow(ConfigurationError)
  })

  it('rejects unknown top-level keys', () => {
    writePolicy(JSON.stringify({ commands: {}, evil: true }))
    expect(() => loadProjectPolicy(root)).toThrow(ConfigurationError)
  })

  it('rejects unknown decision values', () => {
    writePolicy(JSON.stringify({ commands: { 'npm test': 'maybe' } }))
    expect(() => loadProjectPolicy(root)).toThrow(ConfigurationError)
  })

  it('rejects path-like command keys', () => {
    writePolicy(JSON.stringify({ commands: { '../../rm -rf': 'allow' } }))
    expect(() => loadProjectPolicy(root)).toThrow(ConfigurationError)
  })

  it('rejects a policy with too many entries', () => {
    const commands: Record<string, string> = {}
    for (let index = 0; index < 300; index++) commands[`tool${index} run`] = 'allow'
    writePolicy(JSON.stringify({ commands }))
    expect(() => loadProjectPolicy(root)).toThrow(ConfigurationError)
  })
})
