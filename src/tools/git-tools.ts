import { z } from 'zod'

import { runGit } from '../git/runner.js'
import { ToolError } from './errors.js'
import { ToolRisk } from './risk.js'
import type { Tool } from './types.js'
import type { ToolContext } from './context.js'

/**
 * Git inspection tools — strictly read-only.
 *
 * No commit, push, pull, checkout, reset, merge, or branch mutation of
 * any kind exists here or anywhere in the tool registry. Every command
 * is an explicitly constructed argument vector run through the
 * controlled adapter (no shell, bounded output, abortable).
 */

/** Diff output cap — beyond this the model gets a truncation notice. */
const MAX_DIFF_BYTES = 32 * 1024
const DEFAULT_LOG_COUNT = 10
const MAX_LOG_COUNT = 50

function requireRepository(context: ToolContext): string {
  if (!context.workspace.git.isRepository) {
    throw new ToolError('execution_error', 'The workspace is not a git repository.', {
      hint: 'Git inspection tools only work inside a git repository.',
    })
  }
  return context.workspace.root
}

/** Whether the repository has at least one commit (HEAD resolves). */
async function hasHead(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit({ cwd, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], signal })
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* git_status                                                          */
/* ------------------------------------------------------------------ */

interface StatusEntry {
  path: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export const gitStatusTool: Tool = {
  name: 'git_status',
  description:
    'Show the working tree status: current branch, whether the tree is clean, and lists of staged, unstaged, and untracked paths.',
  risk: ToolRisk.SAFE,
  inputSchema: z.object({}),
  execute: async (call, context) => {
    const cwd = requireRepository(context)
    const { stdout } = await runGit({
      cwd,
      args: ['status', '--porcelain=v1', '-b'],
      signal: context.signal,
    })

    const lines = stdout.split('\n')
    let branch: string | undefined
    const staged: string[] = []
    const unstaged: string[] = []
    const untracked: string[] = []

    for (const line of lines) {
      if (line === '') continue
      if (line.startsWith('## ')) {
        const header = line.slice(3)
        branch = header.split('...')[0]?.split(' ')[0]
        continue
      }
      const entry: StatusEntry = {
        path: line.slice(3),
        staged: line[0] !== ' ' && line[0] !== '?' && line[0] !== '!',
        unstaged: line[1] !== ' ' && line[1] !== '?' && line[1] !== '!',
        untracked: line.startsWith('??'),
      }
      if (entry.untracked) untracked.push(entry.path)
      else {
        if (entry.staged) staged.push(entry.path)
        if (entry.unstaged) unstaged.push(entry.path)
      }
    }

    return {
      toolCallId: call.id,
      success: true,
      output: {
        branch: branch ?? context.workspace.git.branch ?? 'unknown',
        clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
        staged,
        unstaged,
        untracked,
      },
    }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as { clean: boolean; branch: string }
    return output.clean ? `clean on ${output.branch}` : `changes on ${output.branch}`
  },
}

/* ------------------------------------------------------------------ */
/* git_diff                                                            */
/* ------------------------------------------------------------------ */

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description:
    'Show the current uncommitted diff (working tree + staged changes versus HEAD). Output is capped; a truncation notice is included when cut.',
  risk: ToolRisk.READ_ONLY,
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .optional()
      .describe('Limit the diff to a single file or directory (workspace-relative).'),
  }),
  execute: async (call, context) => {
    const cwd = requireRepository(context)
    const input = call.input as { path?: string }
    const headExists = await hasHead(cwd, context.signal)

    // Fixed argument vectors only; the optional path goes after `--`.
    const scoped = input.path !== undefined ? ['--', input.path] : []
    let diff: string
    let truncated: boolean
    if (headExists) {
      const result = await runGit({
        cwd,
        args: ['diff', '--no-color', 'HEAD', ...scoped],
        signal: context.signal,
        maxBytes: MAX_DIFF_BYTES,
      })
      diff = result.stdout
      truncated = result.truncated
    } else {
      // Unborn branch (no commits yet): staged + unstaged diffs.
      const unstaged = await runGit({
        cwd,
        args: ['diff', '--no-color', ...scoped],
        signal: context.signal,
        maxBytes: MAX_DIFF_BYTES,
      })
      const stagedResult = await runGit({
        cwd,
        args: ['diff', '--no-color', '--cached', ...scoped],
        signal: context.signal,
        maxBytes: MAX_DIFF_BYTES,
      })
      diff = unstaged.stdout + stagedResult.stdout
      truncated = unstaged.truncated || stagedResult.truncated
    }

    return {
      toolCallId: call.id,
      success: true,
      output: {
        diff,
        empty: diff.trim() === '',
        truncated,
        ...(truncated
          ? {
              note: `Diff truncated at ${(MAX_DIFF_BYTES / 1024).toFixed(0)} KB — request a single path for a focused diff.`,
            }
          : {}),
      },
    }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as { empty: boolean; truncated: boolean }
    if (output.empty) return 'no changes'
    return `diff${output.truncated ? ' (truncated)' : ''}`
  },
}

/* ------------------------------------------------------------------ */
/* git_log                                                             */
/* ------------------------------------------------------------------ */

const GitLogInput = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOG_COUNT)
    .optional()
    .describe(`How many commits to show (default ${DEFAULT_LOG_COUNT}, max ${MAX_LOG_COUNT}).`),
})

interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  date: string
  subject: string
}

export const gitLogTool: Tool = {
  name: 'git_log',
  description: `Show recent commits (hash, author, date, subject). Default ${DEFAULT_LOG_COUNT} commits, max ${MAX_LOG_COUNT}.`,
  risk: ToolRisk.SAFE,
  inputSchema: GitLogInput,
  execute: async (call, context) => {
    const cwd = requireRepository(context)
    const input = call.input as z.output<typeof GitLogInput>
    const count = input.count ?? DEFAULT_LOG_COUNT

    if (!(await hasHead(cwd, context.signal))) {
      return {
        toolCallId: call.id,
        success: true,
        output: { commits: [], note: 'No commits yet.' },
      }
    }

    // %x1f = unit separator — safe for any commit text, unlike "|".
    const { stdout, truncated } = await runGit({
      cwd,
      args: ['log', `-n${count}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s'],
      signal: context.signal,
    })

    const commits: CommitInfo[] = stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [hash = '', shortHash = '', author = '', date = '', ...rest] = line.split('\x1f')
        return { hash, shortHash, author, date, subject: rest.join(' ') }
      })

    return {
      toolCallId: call.id,
      success: true,
      output: { count: commits.length, truncated, commits },
    }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as { count: number }
    return `${output.count} commits`
  },
}

/* ------------------------------------------------------------------ */
/* git_branch                                                          */
/* ------------------------------------------------------------------ */

export const gitBranchTool: Tool = {
  name: 'git_branch',
  description:
    'List local branches and show the current branch. Read-only: never creates, switches, or deletes branches.',
  risk: ToolRisk.READ_ONLY,
  inputSchema: z.object({}),
  execute: async (call, context) => {
    const cwd = requireRepository(context)

    let current: string
    try {
      const ref = await runGit({
        cwd,
        args: ['symbolic-ref', '--short', 'HEAD'],
        signal: context.signal,
      })
      current = ref.stdout.trim()
    } catch {
      // Detached HEAD — fall back to the short sha.
      try {
        const sha = await runGit({
          cwd,
          args: ['rev-parse', '--short', 'HEAD'],
          signal: context.signal,
        })
        current = `detached at ${sha.stdout.trim()}`
      } catch {
        current = 'unknown'
      }
    }

    const { stdout } = await runGit({
      cwd,
      args: ['branch', '--format=%(refname:short)%09%(HEAD)'],
      signal: context.signal,
    })
    const branches = stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [name = '', head = ''] = line.split('\t')
        return { name, current: head === '*' }
      })

    return {
      toolCallId: call.id,
      success: true,
      output: { current, branchCount: branches.length, branches },
    }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as { current: string; branchCount: number }
    return `${output.branchCount} branches, on ${output.current}`
  },
}
