import { describe, expect, it } from 'vitest'

import { normalizeCommand, formatCommand } from '../src/security/normalizer.js'
import { isToolError, ToolError } from '../src/tools/errors.js'

/**
 * Command normalization (Phase 4 security matrix): canonical form for
 * classification, with every structural escape route rejected.
 */

async function expectInvalid(fn: () => unknown, fragment?: string): Promise<void> {
  try {
    fn()
    expect.unreachable('expected a ToolError')
  } catch (error) {
    expect(isToolError(error)).toBe(true)
    expect((error as ToolError).kind).toBe('invalid_input')
    if (fragment !== undefined) expect((error as ToolError).message).toContain(fragment)
  }
}

describe('normalizeCommand — canonical form', () => {
  it('lowercases the executable and trims arguments', () => {
    const command = normalizeCommand({ executable: 'NPM', args: [' test '] })
    expect(command.executable).toBe('npm')
    expect(command.args).toEqual(['test'])
    expect(command.display).toBe('npm test')
  })

  it('produces the same canonical form for equivalent spellings', () => {
    const a = normalizeCommand({ executable: 'Node.exe', args: ['--version'] })
    const b = normalizeCommand({ executable: 'node', args: ['--version'] })
    expect(a.display).toBe(b.display)
  })

  it('strips platform extensions so cmd.exe normalizes onto cmd', () => {
    expect(normalizeCommand({ executable: 'cmd.exe', args: ['/c', 'dir'] }).executable).toBe('cmd')
    expect(normalizeCommand({ executable: 'CMD.BAT', args: [] }).executable).toBe('cmd')
    expect(normalizeCommand({ executable: 'powershell.PS1', args: [] }).executable).toBe('powershell')
  })

  it('defaults an empty cwd to the workspace root', () => {
    expect(normalizeCommand({ executable: 'node', args: [] }).cwd).toBe('.')
    expect(normalizeCommand({ executable: 'node', args: [], cwd: '  ' }).cwd).toBe('.')
  })

  it('canonicalizes cwd separators and duplicate slashes', () => {
    expect(normalizeCommand({ executable: 'node', args: [], cwd: 'src\\lib' }).cwd).toBe('src/lib')
    expect(normalizeCommand({ executable: 'node', args: [], cwd: 'src//lib' }).cwd).toBe('src/lib')
  })

  it('preserves argument content — metacharacters stay data', () => {
    const command = normalizeCommand({
      executable: 'node',
      args: ['-e', 'x', 'a && echo injected; b | c > d'],
    })
    expect(command.args[2]).toBe('a && echo injected; b | c > d')
  })
})

describe('normalizeCommand — structural rejections', () => {
  it('rejects a path-like executable', () => {
    void expectInvalid(() => normalizeCommand({ executable: './node', args: [] }))
    void expectInvalid(() => normalizeCommand({ executable: '..\\node', args: [] }))
  })

  it('rejects an absolute executable path (POSIX and Windows)', () => {
    void expectInvalid(() => normalizeCommand({ executable: '/usr/bin/node', args: [] }))
    void expectInvalid(() => normalizeCommand({ executable: 'C:\\Windows\\cmd.exe', args: [] }))
  })

  it('rejects Windows drive-letter and UNC-style executables', () => {
    void expectInvalid(() => normalizeCommand({ executable: 'C:node', args: [] }))
    void expectInvalid(() => normalizeCommand({ executable: '\\\\server\\share\\tool', args: [] }))
  })

  it('rejects executables with whitespace or quotes', () => {
    void expectInvalid(() => normalizeCommand({ executable: 'node --version', args: [] }))
    void expectInvalid(() => normalizeCommand({ executable: '"node"', args: [] }))
  })

  it('rejects NUL bytes everywhere', () => {
    void expectInvalid(() => normalizeCommand({ executable: 'no\0de', args: [] }))
    void expectInvalid(() => normalizeCommand({ executable: 'node', args: ['a\0b'] }))
    void expectInvalid(() => normalizeCommand({ executable: 'node', args: [], cwd: 'a\0b' }))
  })

  it('rejects Windows reserved device names', () => {
    void expectInvalid(() => normalizeCommand({ executable: 'CON', args: [] }))
    void expectInvalid(() => normalizeCommand({ executable: 'lpt1', args: [] }))
  })

  it('rejects an empty executable', () => {
    void expectInvalid(() => normalizeCommand({ executable: '   ', args: [] }))
  })

  it('rejects too many arguments and oversized arguments', () => {
    const many = Array.from({ length: 40 }, (_, index) => `arg${index}`)
    void expectInvalid(() => normalizeCommand({ executable: 'node', args: many }))
    void expectInvalid(() => normalizeCommand({ executable: 'node', args: ['x'.repeat(5000)] }))
  })

  it('rejects non-string arguments', () => {
    void expectInvalid(() =>
      normalizeCommand({ executable: 'node', args: [42 as unknown as string] }),
    )
  })
})

describe('formatCommand', () => {
  it('renders the canonical display form used as the policy key', () => {
    expect(formatCommand('npm', ['test'])).toBe('npm test')
    expect(formatCommand('node', [])).toBe('node')
  })
})
