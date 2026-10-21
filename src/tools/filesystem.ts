import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import type { ToolResult } from '../domain/types/index.js'
import { ToolError } from './errors.js'
import { resolveWorkspacePath, toWorkspaceRelative } from './path-security.js'
import { ToolRisk } from './risk.js'
import type { Tool, ValidatedToolCall } from './types.js'
import type { ToolContext } from './context.js'

/**
 * Filesystem inspection tools (read-only).
 *
 * Every path is resolved through `resolveWorkspacePath` — model input
 * can never reach the disk outside the workspace. Nothing here writes,
 * moves, or deletes; output is always bounded.
 */

/** Directories never listed or descended into (noise + internal state). */
export const ALWAYS_SKIPPED_DIRS = new Set(['.git', 'node_modules'])

const MAX_ENTRIES = 500
const MAX_LIST_DEPTH = 3
const MAX_FILE_BYTES = 256 * 1024
const MAX_READABLE_BYTES = 8 * 1024 * 1024
const MAX_READ_LINES = 2000

type EntryType = 'file' | 'directory' | 'symlink' | 'other'

function entryTypeOf(stat: fs.Stats): EntryType {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symlink'
  return 'other'
}

/* ------------------------------------------------------------------ */
/* list_directory                                                      */
/* ------------------------------------------------------------------ */

const ListDirectoryInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Directory to list, relative to the workspace root ("." for root).'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_DEPTH)
    .optional()
    .describe(`How many levels to descend (1-${MAX_LIST_DEPTH}, default 1).`),
})

interface DirectoryEntry {
  name: string
  type: EntryType
  size?: number
}

function listDirectory(
  input: z.output<typeof ListDirectoryInput>,
  context: ToolContext,
): ToolResult {
  const absolute = resolveWorkspacePath(context.workspace.root, input.path)
  const stat = fs.statSync(absolute)
  if (!stat.isDirectory()) {
    throw new ToolError('not_a_file', `Not a directory: ${input.path}`)
  }

  const depth = input.depth ?? 1
  const entries: DirectoryEntry[] = []
  let truncated = false

  const walk = (dir: string, level: number): void => {
    if (truncated || level > depth) return
    let names: fs.Dirent[]
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory — skip silently, list the rest
    }
    names.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const dirent of names) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        return
      }
      if (dirent.isDirectory() && ALWAYS_SKIPPED_DIRS.has(dirent.name)) continue
      let size: number | undefined
      let type: EntryType
      if (dirent.isSymbolicLink()) {
        type = 'symlink'
      } else if (dirent.isDirectory()) {
        type = 'directory'
      } else if (dirent.isFile()) {
        type = 'file'
        try {
          size = fs.statSync(path.join(dir, dirent.name)).size
        } catch {
          size = undefined
        }
      } else {
        type = 'other'
      }
      entries.push({ name: dirent.name, type, ...(size !== undefined ? { size } : {}) })
      if (type === 'directory' && level < depth) {
        walk(path.join(dir, dirent.name), level + 1)
      }
    }
  }
  walk(absolute, 1)

  return {
    toolCallId: '',
    success: true,
    output: {
      path: toWorkspaceRelative(context.workspace.root, absolute),
      entryCount: entries.length,
      truncated,
      ...(truncated ? { note: `Output truncated: showing first ${MAX_ENTRIES} entries.` } : {}),
      entries,
    },
  }
}

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description:
    'List the entries of a directory inside the workspace (name and type per entry). Use depth > 1 to see subdirectories.',
  risk: ToolRisk.SAFE,
  inputSchema: ListDirectoryInput,
  execute: async (call, context) => {
    const result = listDirectory(call.input as z.output<typeof ListDirectoryInput>, context)
    return { ...result, toolCallId: call.id }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as { entryCount: number; path: string }
    return `${output.entryCount} entries in ${output.path}`
  },
}

/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */

const ReadFileInput = z.object({
  path: z.string().min(1).describe('File to read, relative to the workspace root.'),
  startLine: z.number().int().min(1).optional().describe('First line to read (1-based).'),
  endLine: z.number().int().min(1).optional().describe('Last line to read (inclusive).'),
})

function readFile(input: z.output<typeof ReadFileInput>, context: ToolContext): ToolResult {
  const absolute = resolveWorkspacePath(context.workspace.root, input.path)
  const stat = fs.statSync(absolute)
  if (stat.isDirectory()) {
    throw new ToolError('not_a_file', `Path is a directory, not a file: ${input.path}`, {
      hint: 'Use list_directory to inspect directories.',
    })
  }
  if (stat.size > MAX_FILE_BYTES && input.startLine === undefined) {
    throw new ToolError(
      'output_limit',
      `File is too large to read in one request (${stat.size.toLocaleString('en-US')} bytes; limit ${MAX_FILE_BYTES.toLocaleString('en-US')}).`,
      { hint: 'Request a line range with startLine/endLine.' },
    )
  }
  // Hard cap: even with a line range, never load an enormous file whole.
  if (stat.size > MAX_READABLE_BYTES) {
    throw new ToolError(
      'output_limit',
      `File is too large for line-range reads too (${stat.size.toLocaleString('en-US')} bytes; limit ${MAX_READABLE_BYTES.toLocaleString('en-US')}).`,
    )
  }

  let raw: string
  try {
    raw = fs.readFileSync(absolute, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EISDIR') {
      throw new ToolError('not_a_file', `Path is a directory: ${input.path}`)
    }
    if (code === 'EACCES') {
      throw new ToolError('permission_denied', `Permission denied reading: ${input.path}`)
    }
    throw new ToolError('execution_error', `Could not read ${input.path}: ${code ?? String(error)}`)
  }
  if (raw.includes('\0')) {
    throw new ToolError('not_a_file', `File appears to be binary: ${input.path}`, {
      hint: 'Only text files can be read.',
    })
  }

  // A trailing newline is a file terminator, not an extra empty line.
  const lines = raw.split(/\r\n|\r|\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const lineCount = lines.length
  const startLine = Math.min(input.startLine ?? 1, lineCount)
  const requestedEnd = input.endLine ?? startLine + MAX_READ_LINES - 1
  const endLine = Math.min(Math.max(requestedEnd, startLine), lineCount)
  const selected = lines.slice(startLine - 1, endLine)
  const truncated = startLine > 1 || endLine < lineCount

  return {
    toolCallId: '',
    success: true,
    output: {
      path: toWorkspaceRelative(context.workspace.root, absolute),
      content: selected.join('\n'),
      lineCount,
      startLine,
      endLine,
      truncated,
      ...(truncated ? { note: `Lines ${startLine}-${endLine} of ${lineCount} shown.` } : {}),
    },
  }
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a text file inside the workspace. Optionally restrict to a line range (startLine/endLine, 1-based, inclusive).',
  risk: ToolRisk.READ_ONLY,
  inputSchema: ReadFileInput,
  execute: async (call, context) => {
    const result = readFile(call.input as z.output<typeof ReadFileInput>, context)
    return { ...result, toolCallId: call.id }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as {
      lineCount: number
      startLine: number
      endLine: number
      path: string
    }
    if (output.startLine === 1 && output.endLine === output.lineCount) {
      return `${output.lineCount} lines in ${output.path}`
    }
    return `lines ${output.startLine}-${output.endLine} of ${output.path}`
  },
}

/* ------------------------------------------------------------------ */
/* file_exists                                                         */
/* ------------------------------------------------------------------ */

const FileExistsInput = z.object({
  path: z.string().min(1).describe('Path to check, relative to the workspace root.'),
})

export const fileExistsTool: Tool = {
  name: 'file_exists',
  description: 'Check whether a path exists inside the workspace and what kind of entry it is.',
  risk: ToolRisk.SAFE,
  inputSchema: FileExistsInput,
  execute: async (call: ValidatedToolCall, context): Promise<ToolResult> => {
    const { path: inputPath } = call.input as z.output<typeof FileExistsInput>
    // allowMissing: this tool's whole purpose is to answer "does it exist?"
    const absolute = resolveWorkspacePath(context.workspace.root, inputPath, {
      allowMissing: true,
    })
    let exists: boolean
    let type: EntryType | undefined
    try {
      type = entryTypeOf(fs.statSync(absolute))
      exists = true
    } catch {
      exists = false
      type = undefined
    }
    return {
      toolCallId: call.id,
      success: true,
      output: {
        path: toWorkspaceRelative(context.workspace.root, absolute),
        exists,
        ...(exists && type !== undefined ? { type } : {}),
      },
    }
  },
  summarize: (_call, result) => {
    if (!result.success) return 'failed'
    const output = result.output as { exists: boolean; path: string; type?: string }
    return output.exists
      ? `${output.path} exists (${output.type ?? 'unknown'})`
      : `${output.path} does not exist`
  },
}
