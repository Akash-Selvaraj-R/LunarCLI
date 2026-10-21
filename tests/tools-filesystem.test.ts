import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSilentLogger } from '../src/logging/logger.js'
import { fileExistsTool, listDirectoryTool, readFileTool } from '../src/tools/filesystem.js'
import { findFilesTool, searchFilesTool, globToRegExp } from '../src/tools/search.js'
import { ToolError } from '../src/tools/errors.js'
import type { ToolContext } from '../src/tools/context.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Integration tests for the real filesystem/search tools against a
 * temporary workspace — never the LunarCLI repository itself, so the
 * suite stays deterministic.
 */

let root: string
let context: ToolContext

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-tools-int-'))
  fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'src', 'auth', 'login.ts'),
    ['export function login(user: string): boolean {', '  return user.length > 0;', '}', ''].join(
      '\n',
    ),
  )
  fs.writeFileSync(
    path.join(root, 'src', 'auth', 'token.ts'),
    [
      'export const TOKEN_TTL = 3600;',
      'export function signToken(): string { return "t"; }',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(root, 'src', 'app.ts'),
    ['import { login } from "./auth/login.js";', 'export const app = { login };', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(root, 'tests', 'auth.test.ts'),
    ['test("auth", () => { login("x"); });', ''].join('\n'),
  )
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","private":true}\n')

  const workspace: Workspace = {
    cwd: root,
    root,
    name: 'fixture',
    git: { isRepository: false },
  }
  context = { workspace, logger: createSilentLogger() }
})

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

let callId = 0
const nextCall = (name: string, input: Record<string, unknown>) => ({
  id: `call_${++callId}`,
  name,
  input,
})

/** Tools throw structured ToolErrors; the executor converts them to failed results. */
async function expectToolError(
  promise: Promise<unknown>,
  kind: string,
  hintContains?: string,
): Promise<void> {
  try {
    await promise
    expect.unreachable('expected the tool to throw a ToolError')
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).kind).toBe(kind)
    if (hintContains !== undefined) expect((error as ToolError).hint).toContain(hintContains)
  }
}

describe('list_directory', () => {
  it('lists top-level entries with types', async () => {
    const result = await listDirectoryTool.execute(
      nextCall('list_directory', { path: '.' }),
      context,
    )
    expect(result.success).toBe(true)
    const output = result.output as { entries: Array<{ name: string; type: string }>; path: string }
    expect(output.path).toBe('.')
    const names = output.entries.map((entry) => entry.name)
    expect(names).toEqual(['package.json', 'src', 'tests']) // sorted, .git/node_modules skipped
    expect(output.entries.find((entry) => entry.name === 'src')?.type).toBe('directory')
    expect(output.entries.find((entry) => entry.name === 'package.json')?.type).toBe('file')
  })

  it('descends into subdirectories with depth=2', async () => {
    const result = await listDirectoryTool.execute(
      nextCall('list_directory', { path: 'src', depth: 2 }),
      context,
    )
    const output = result.output as { entries: Array<{ name: string }> }
    const names = output.entries.map((entry) => entry.name)
    expect(names).toContain('app.ts')
    expect(names).toContain('auth')
    expect(names).toContain('login.ts')
  })

  it('rejects a file path as not_a_file', async () => {
    await expectToolError(
      listDirectoryTool.execute(nextCall('list_directory', { path: 'package.json' }), context),
      'not_a_file',
    )
  })

  it('rejects paths outside the workspace', async () => {
    await expectToolError(
      listDirectoryTool.execute(nextCall('list_directory', { path: '../..' }), context),
      'path_outside_workspace',
    )
  })

  it('validates its input through Zod', () => {
    expect(listDirectoryTool.inputSchema.safeParse({ path: 42 }).success).toBe(false)
    expect(listDirectoryTool.inputSchema.safeParse({ path: '.', depth: 99 }).success).toBe(false)
    expect(listDirectoryTool.inputSchema.safeParse({ path: '.' }).success).toBe(true)
    expect(readFileTool.inputSchema.safeParse({ path: 123 }).success).toBe(false)
  })
})

describe('read_file', () => {
  it('reads a file with metadata', async () => {
    const result = await readFileTool.execute(
      nextCall('read_file', { path: 'src/auth/login.ts' }),
      context,
    )
    expect(result.success).toBe(true)
    const output = result.output as {
      path: string
      content: string
      lineCount: number
      truncated: boolean
    }
    expect(output.path).toBe('src/auth/login.ts')
    expect(output.content).toContain('export function login')
    expect(output.lineCount).toBe(3)
    expect(output.truncated).toBe(false)
  })

  it('supports a 1-based inclusive line range', async () => {
    const result = await readFileTool.execute(
      nextCall('read_file', { path: 'src/auth/token.ts', startLine: 1, endLine: 1 }),
      context,
    )
    const output = result.output as { content: string; lineCount: number; truncated: boolean }
    expect(output.content).toBe('export const TOKEN_TTL = 3600;')
    expect(output.lineCount).toBe(2)
    expect(output.truncated).toBe(true)
  })

  it('reports missing files as file_not_found', async () => {
    await expectToolError(
      readFileTool.execute(nextCall('read_file', { path: 'src/nope.ts' }), context),
      'file_not_found',
    )
  })

  it('rejects directories', async () => {
    await expectToolError(
      readFileTool.execute(nextCall('read_file', { path: 'src' }), context),
      'not_a_file',
    )
  })

  it('rejects paths outside the workspace', async () => {
    await expectToolError(
      readFileTool.execute(nextCall('read_file', { path: '../../etc/passwd' }), context),
      'path_outside_workspace',
    )
  })

  it('rejects binary files', async () => {
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    await expectToolError(
      readFileTool.execute(nextCall('read_file', { path: 'blob.bin' }), context),
      'not_a_file',
    )
  })

  it('rejects oversized files with an actionable hint', async () => {
    fs.writeFileSync(path.join(root, 'huge.txt'), 'a'.repeat(300 * 1024))
    try {
      await expectToolError(
        readFileTool.execute(nextCall('read_file', { path: 'huge.txt' }), context),
        'output_limit',
        'startLine',
      )
    } finally {
      fs.rmSync(path.join(root, 'huge.txt'))
    }
  })
})

describe('file_exists', () => {
  it('finds an existing file', async () => {
    const result = await fileExistsTool.execute(
      nextCall('file_exists', { path: 'src/app.ts' }),
      context,
    )
    expect(result.output).toEqual({ path: 'src/app.ts', exists: true, type: 'file' })
  })

  it('reports a missing path without failing', async () => {
    const result = await fileExistsTool.execute(
      nextCall('file_exists', { path: 'ghost.ts' }),
      context,
    )
    expect(result.success).toBe(true)
    expect((result.output as { exists: boolean }).exists).toBe(false)
  })

  it('still refuses outside paths', async () => {
    await expectToolError(
      fileExistsTool.execute(nextCall('file_exists', { path: '../etc/passwd' }), context),
      'path_outside_workspace',
    )
  })
})

describe('search_files', () => {
  it('finds literal matches with path, line, and snippet', async () => {
    const result = await searchFilesTool.execute(
      nextCall('search_files', { query: 'login' }),
      context,
    )
    expect(result.success).toBe(true)
    const output = result.output as {
      matchCount: number
      matches: Array<{ path: string; line: number; column: number; snippet: string }>
    }
    expect(output.matchCount).toBeGreaterThanOrEqual(2)
    const paths = output.matches.map((match) => match.path)
    expect(paths).toContain('src/app.ts')
    expect(paths).toContain('tests/auth.test.ts')
    const first = output.matches[0]
    expect(first?.line).toBeGreaterThan(0)
    expect(first?.column).toBeGreaterThan(0)
    expect(first?.snippet).toContain('login')
  })

  it('respects maxResults and flags truncation', async () => {
    const result = await searchFilesTool.execute(
      nextCall('search_files', { query: 'auth', maxResults: 1 }),
      context,
    )
    const output = result.output as { matchCount: number; truncated: boolean }
    expect(output.matchCount).toBe(1)
    expect(output.truncated).toBe(true)
  })

  it('searches only within a scoped path', async () => {
    const result = await searchFilesTool.execute(
      nextCall('search_files', { query: 'login', path: 'src/auth' }),
      context,
    )
    const output = result.output as { matches: Array<{ path: string }> }
    expect(output.matches.every((match) => match.path.startsWith('src/auth/'))).toBe(true)
  })

  it('returns empty results for a query with no matches', async () => {
    const result = await searchFilesTool.execute(
      nextCall('search_files', { query: 'zzz_not_present_zzz' }),
      context,
    )
    expect((result.output as { matchCount: number }).matchCount).toBe(0)
  })

  it('refuses to search outside the workspace', async () => {
    await expectToolError(
      searchFilesTool.execute(nextCall('search_files', { query: 'x', path: '../..' }), context),
      'path_outside_workspace',
    )
  })
})

describe('find_files', () => {
  it('matches a glob pattern against relative paths', async () => {
    const result = await findFilesTool.execute(
      nextCall('find_files', { pattern: '**/*.ts' }),
      context,
    )
    const output = result.output as { paths: string[] }
    expect(output.paths).toContain('src/app.ts')
    expect(output.paths).toContain('src/auth/login.ts')
    expect(output.paths).toContain('tests/auth.test.ts')
    expect(output.paths).not.toContain('package.json')
  })

  it('matches a plain substring against file names', async () => {
    const result = await findFilesTool.execute(nextCall('find_files', { pattern: 'auth' }), context)
    const output = result.output as { paths: string[] }
    expect(output.paths).toContain('tests/auth.test.ts')
  })

  it('limits results deterministically', async () => {
    const result = await findFilesTool.execute(
      nextCall('find_files', { pattern: '**/*', maxResults: 2 }),
      context,
    )
    const output = result.output as { paths: string[]; truncated: boolean }
    expect(output.paths).toHaveLength(2)
    expect(output.truncated).toBe(true)
    // Deterministic ordering.
    const again = await findFilesTool.execute(
      nextCall('find_files', { pattern: '**/*', maxResults: 2 }),
      context,
    )
    expect((again.output as { paths: string[] }).paths).toEqual(output.paths)
  })

  it('refuses to walk outside the workspace', async () => {
    await expectToolError(
      findFilesTool.execute(nextCall('find_files', { pattern: '**/*', path: '../..' }), context),
      'path_outside_workspace',
    )
  })
})

describe('globToRegExp', () => {
  it('translates **, *, and ? correctly', () => {
    expect(globToRegExp('**/*.tsx').test('src/a.tsx')).toBe(true)
    expect(globToRegExp('**/*.tsx').test('a.tsx')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false)
    expect(globToRegExp('a?c.ts').test('abc.ts')).toBe(true)
  })

  it('escapes regex metacharacters in literals', () => {
    expect(globToRegExp('a+b.c').test('a+b.c')).toBe(true)
    expect(globToRegExp('a+b.c').test('axbzc')).toBe(false)
  })
})
