import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSilentLogger } from '../src/logging/logger.js'
import { gitBranchTool, gitDiffTool, gitLogTool, gitStatusTool } from '../src/tools/git-tools.js'
import { ToolError } from '../src/tools/errors.js'
import type { ToolContext } from '../src/tools/context.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Git tool integration tests against a temporary repository — never the
 * LunarCLI repository itself. Skips gracefully when git is missing.
 */

let root: string
let context: ToolContext
let gitAvailable = true

/** Run git in the fixture repo (test setup only). */
function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, shell: false, windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr)}`)
  }
}

beforeAll(() => {
  const probe = spawnSync('git', ['--version'], { shell: false, windowsHide: true })
  if (probe.status !== 0) {
    gitAvailable = false
    return
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-git-int-'))
  git('init', '-b', 'main')
  git('config', 'user.email', 'lunar@test.invalid')
  git('config', 'user.name', 'Lunar Test')

  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 1;\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n')
  git('add', '.')
  git('commit', '-m', 'initial commit')

  // Leave the worktree dirty: one staged, one unstaged, one untracked.
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 2;\n')
  git('add', 'src/app.ts')
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const app = 3;\n')
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n')

  const workspace: Workspace = {
    cwd: root,
    root,
    name: 'git-fixture',
    git: { isRepository: true, root, branch: 'main' },
  }
  context = { workspace, logger: createSilentLogger() }
})

afterAll(() => {
  if (!gitAvailable) return
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const skip = (): boolean => !gitAvailable
let callId = 0
const nextCall = () => ({ id: `call_${++callId}`, name: 'git_tool', input: {} })

describe('git_status', () => {
  it.skipIf(skip())('reports branch, cleanliness, and file classes', async () => {
    const result = await gitStatusTool.execute(nextCall(), context)
    expect(result.success).toBe(true)
    const output = result.output as {
      branch: string
      clean: boolean
      staged: string[]
      unstaged: string[]
      untracked: string[]
    }
    expect(output.branch).toBe('main')
    expect(output.clean).toBe(false)
    expect(output.staged).toContain('src/app.ts')
    expect(output.unstaged).toContain('src/app.ts')
    expect(output.untracked).toContain('untracked.txt')
  })

  it.skipIf(skip())('refuses outside a git repository', async () => {
    const plain: ToolContext = {
      workspace: { cwd: root, root, name: 'x', git: { isRepository: false } },
      logger: createSilentLogger(),
    }
    try {
      await gitStatusTool.execute(nextCall(), plain)
      expect.unreachable('expected a ToolError')
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).message).toContain('not a git repository')
    }
  })
})

describe('git_log', () => {
  it.skipIf(skip())('returns structured commits, newest first', async () => {
    const result = await gitLogTool.execute(nextCall(), context)
    const output = result.output as {
      count: number
      commits: Array<{ hash: string; shortHash: string; author: string; subject: string }>
    }
    expect(output.count).toBe(1)
    expect(output.commits[0]?.subject).toBe('initial commit')
    expect(output.commits[0]?.author).toBe('Lunar Test')
    expect(output.commits[0]?.hash).toHaveLength(40)
    expect(output.commits[0]?.shortHash.length).toBeLessThan(40)
  })

  it.skipIf(skip())('clamps the requested count through the schema', () => {
    expect(gitLogTool.inputSchema.safeParse({ count: 500 }).success).toBe(false)
    expect(gitLogTool.inputSchema.safeParse({ count: 5 }).success).toBe(true)
  })
})

describe('git_diff', () => {
  it.skipIf(skip())('shows uncommitted changes and flags non-empty diffs', async () => {
    const result = await gitDiffTool.execute(nextCall(), context)
    const output = result.output as { diff: string; empty: boolean; truncated: boolean }
    expect(output.empty).toBe(false)
    expect(output.diff).toContain('export const app = 3;')
  })

  it.skipIf(skip())('scopes to a single path when asked', async () => {
    const result = await gitDiffTool.execute(
      { id: 'c', name: 'git_diff', input: { path: 'README.md' } },
      context,
    )
    const output = result.output as { empty: boolean }
    expect(output.empty).toBe(true) // README was not modified
  })
})

describe('git_branch', () => {
  it.skipIf(skip())('lists branches and the current one', async () => {
    const result = await gitBranchTool.execute(nextCall(), context)
    const output = result.output as {
      current: string
      branchCount: number
      branches: Array<{ name: string; current: boolean }>
    }
    expect(output.current).toBe('main')
    expect(output.branches.find((branch) => branch.name === 'main')?.current).toBe(true)
  })
})
