import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import { ToolError } from './errors.js'
import { resolveWorkspacePath } from './path-security.js'
import { ToolRisk } from './risk.js'
import type { Tool } from './types.js'
import { walkFiles } from './walk.js'

/**
 * Search tools (read-only, workspace-bounded, output-limited).
 *
 * `search_files` prefers ripgrep when it is installed, but never goes
 * through a shell: it is spawned with a fixed argument vector and the
 * query is passed after `--` so it can never be interpreted as an
 * option or command. A controlled Node.js fallback provides identical
 * semantics (fixed-string, case-sensitive) when ripgrep is missing.
 *
 * The tools own their implementation — there is no generic
 * run-command path the model can reach.
 */

const MAX_MATCHES = 200
const DEFAULT_MATCHES = 50
const MAX_SNIPPET = 200
const MAX_SCANNED_FILES = 5_000
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const RG_TIMEOUT_MS = 15_000

interface FileMatch {
  path: string
  line: number
  column: number
  snippet: string
}

/** Detect ripgrep once per process (never through a shell). */
let ripgrepAvailable: boolean | undefined
export function hasRipgrep(): boolean {
  if (ripgrepAvailable === undefined) {
    try {
      const probe = spawnSync('rg', ['--version'], {
        shell: false,
        windowsHide: true,
        timeout: 3_000,
      })
      ripgrepAvailable = probe.status === 0
    } catch {
      ripgrepAvailable = false
    }
  }
  return ripgrepAvailable
}

/** Run a fixed-string ripgrep search, bounded by maxResults. */
function ripgrepSearch(
  root: string,
  relativeTo: string,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<{ matches: FileMatch[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const matches: FileMatch[] = []
    let truncated = false
    // Fixed vector: -F (literal query), --json (robust parsing incl.
    // Windows drive letters), no shell, query after `-e`, root after `--`.
    const child = spawn('rg', ['--json', '--no-messages', '-F', '-e', query, '--', root], {
      shell: false,
      windowsHide: true,
      signal,
    })
    let buffer = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error !== undefined) reject(error)
      else resolve({ matches, truncated })
    }
    const timer = setTimeout(() => {
      truncated = true
      child.kill()
    }, RG_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (matches.length >= maxResults) {
          truncated = true
          child.kill()
          return
        }
        try {
          const event = JSON.parse(line) as {
            type?: string
            data?: {
              path?: { text?: string }
              line_number?: number
              submatches?: Array<{ match?: { text?: string }; start?: number }>
              lines?: { text?: string }
            }
          }
          if (event.type !== 'match' || event.data === undefined) continue
          const absolute = event.data.path?.text ?? ''
          const text = (event.data.lines?.text ?? '').replace(/\r?\n$/, '')
          const start = event.data.submatches?.[0]?.start ?? 0
          matches.push({
            path: path.relative(relativeTo, absolute).split(path.sep).join('/'),
            line: event.data.line_number ?? 0,
            column: start + 1,
            snippet: text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text,
          })
        } catch {
          // Ignore unparseable lines — never fail a search on one event.
        }
      }
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finish(error.code === 'ENOENT' ? new Error('ripgrep disappeared') : error)
    })
    child.once('close', () => {
      clearTimeout(timer)
      // A final partial event line, if any.
      if (buffer.trim() !== '' && matches.length < maxResults) {
        try {
          const event = JSON.parse(buffer) as { type?: string; data?: Record<string, unknown> }
          if (event.type === 'match' && event.data !== undefined) {
            truncated = true
          }
        } catch {
          /* ignore */
        }
      }
      finish()
    })
  })
}

/** Controlled Node.js fallback: fixed-string, case-sensitive line scan. */
function nodeSearch(
  root: string,
  relativeTo: string,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
): { matches: FileMatch[]; truncated: boolean } {
  const { files } = walkFiles(root, { maxFiles: MAX_SCANNED_FILES, signal })
  const matches: FileMatch[] = []
  let truncated = false
  for (const relative of files) {
    if (signal?.aborted === true) break
    if (matches.length >= maxResults) {
      truncated = true
      break
    }
    const absolute = path.join(root, relative)
    let stat: fs.Stats
    try {
      stat = fs.statSync(absolute)
    } catch {
      continue
    }
    if (stat.size > MAX_SEARCH_FILE_BYTES) continue
    let content: string
    try {
      content = fs.readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    if (content.includes('\0')) continue // binary
    const lines = content.split(/\r\n|\r|\n/)
    for (let index = 0; index < lines.length; index++) {
      if (matches.length >= maxResults) {
        truncated = true
        break
      }
      const lineText = lines[index] ?? ''
      const column = lineText.indexOf(query)
      if (column === -1) continue
      matches.push({
        path: path.relative(relativeTo, absolute).split(path.sep).join('/'),
        line: index + 1,
        column: column + 1,
        snippet:
          lineText.length > MAX_SNIPPET
            ? `${lineText.slice(0, MAX_SNIPPET)}…`
            : lineText.trimStart(),
      })
    }
  }
  return { matches, truncated }
}

/* ------------------------------------------------------------------ */
/* search_files                                                        */
/* ------------------------------------------------------------------ */

const SearchFilesInput = z.object({
  query: z.string().min(1).describe('Fixed text to search for (case-sensitive, literal).'),
  path: z.string().min(1).optional().describe('Directory to search in (default: workspace root).'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_MATCHES)
    .optional()
    .describe(`Maximum matches to return (default ${DEFAULT_MATCHES}, max ${MAX_MATCHES}).`),
})

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Search for a literal text string across files in the workspace (fixed-string, case-sensitive). Returns path, line, column, and a snippet per match.',
  risk: ToolRisk.SAFE,
  inputSchema: SearchFilesInput,
  execute: async (call, context) => {
    const input = call.input as z.output<typeof SearchFilesInput>
    const root = resolveWorkspacePath(context.workspace.root, input.path ?? '.')
    const maxResults = input.maxResults ?? DEFAULT_MATCHES

    let matches: FileMatch[]
    let truncated: boolean
    let engine: string
    const relativeTo = context.workspace.root
    if (hasRipgrep()) {
      try {
        const result = await ripgrepSearch(
          root,
          relativeTo,
          input.query,
          maxResults,
          context.signal,
        )
        matches = result.matches
        truncated = result.truncated
        engine = 'ripgrep'
      } catch {
        // Fall back on any rg failure (it vanished mid-flight, etc.).
        const result = nodeSearch(root, relativeTo, input.query, maxResults, context.signal)
        matches = result.matches
        truncated = result.truncated
        engine = 'node-fallback'
      }
    } else {
      const result = nodeSearch(root, relativeTo, input.query, maxResults, context.signal)
      matches = result.matches
      truncated = result.truncated
      engine = 'node-fallback'
    }
    if (context.signal?.aborted === true) {
      throw new ToolError('cancelled', 'Search was cancelled.')
    }

    return {
      toolCallId: call.id,
      success: true,
      output: {
        query: input.query,
        engine,
        matchCount: matches.length,
        truncated,
        ...(truncated ? { note: `Results truncated at ${maxResults} matches.` } : {}),
        matches,
      },
    }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as { matchCount: number }
    return `${output.matchCount} matches`
  },
}

/* ------------------------------------------------------------------ */
/* find_files                                                          */
/* ------------------------------------------------------------------ */

const MAX_FIND_RESULTS = 200
const DEFAULT_FIND_RESULTS = 50

const FindFilesInput = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      'Glob like "**/*.tsx" (matches path) or a plain substring like "auth" (matches file names).',
    ),
  path: z.string().min(1).optional().describe('Directory to search in (default: workspace root).'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_FIND_RESULTS)
    .optional()
    .describe(
      `Maximum paths to return (default ${DEFAULT_FIND_RESULTS}, max ${MAX_FIND_RESULTS}).`,
    ),
})

/** Convert a simple glob (**, *, ?) into an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] ?? ''
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (glob[index + 2] === '/') {
          source += '(?:[^/]+/)*'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export const findFilesTool: Tool = {
  name: 'find_files',
  description:
    'Find files by glob pattern (e.g. "**/*.tsx", "src/**/*.ts") or by plain substring of the file name (e.g. "auth"). Returns workspace-relative paths.',
  risk: ToolRisk.SAFE,
  inputSchema: FindFilesInput,
  execute: async (call, context) => {
    const input = call.input as z.output<typeof FindFilesInput>
    const root = resolveWorkspacePath(context.workspace.root, input.path ?? '.')
    const maxResults = input.maxResults ?? DEFAULT_FIND_RESULTS
    const { files, truncated: walkTruncated } = walkFiles(root, { signal: context.signal })

    const hasGlob = /[*?]/.test(input.pattern)
    let predicate: (relative: string) => boolean
    if (hasGlob) {
      // Globs match against the path relative to the search root.
      const regex = globToRegExp(input.pattern.replace(/^\.\//, ''))
      predicate = (relative) => regex.test(relative)
    } else {
      const needle = input.pattern.toLowerCase()
      predicate = (relative) => path.posix.basename(relative).toLowerCase().includes(needle)
    }

    const matched: string[] = []
    let truncated = walkTruncated
    for (const relative of files) {
      if (matched.length >= maxResults) {
        truncated = true
        break
      }
      if (predicate(relative)) matched.push(relative)
    }

    return {
      toolCallId: call.id,
      success: true,
      output: {
        pattern: input.pattern,
        matchCount: matched.length,
        truncated,
        ...(truncated ? { note: `Results truncated at ${maxResults} paths.` } : {}),
        paths: matched,
      },
    }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as { matchCount: number }
    return `${output.matchCount} files found`
  },
}
