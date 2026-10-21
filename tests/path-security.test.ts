import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveWorkspacePath, toWorkspaceRelative } from '../src/tools/path-security.js'
import { isToolError, ToolError } from '../src/tools/errors.js'

/**
 * Security suite for workspace path resolution.
 *
 * These tests are the boundary that keeps model-supplied paths inside
 * the workspace — on POSIX and on Windows (drive letters, backslashes,
 * case-insensitivity). Attack shapes, not just happy paths.
 */

let workspace: string // inside a unique temp dir
let outside: string // a sibling temp dir OUTSIDE the workspace

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-pathsec-'))
  workspace = path.join(base, 'workspace')
  outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(workspace, 'src', 'auth'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'src', 'auth', 'token.ts'), 'export const t = 1\n')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n')
})

afterEach(() => {
  // Temp dirs are small; best-effort cleanup.
  try {
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function expectToolError(fn: () => unknown, kind: string): void {
  try {
    fn()
    expect.unreachable('expected a ToolError')
  } catch (error) {
    expect(isToolError(error)).toBe(true)
    expect((error as ToolError).kind).toBe(kind)
  }
}

describe('resolveWorkspacePath — legitimate paths', () => {
  it('resolves "." to the workspace root', () => {
    expect(resolveWorkspacePath(workspace, '.')).toBe(fs.realpathSync(workspace))
  })

  it('resolves relative paths against the workspace root', () => {
    const resolved = resolveWorkspacePath(workspace, 'src/auth/token.ts')
    expect(resolved).toBe(fs.realpathSync(path.join(workspace, 'src', 'auth', 'token.ts')))
  })

  it('resolves "./src" and "src" identically', () => {
    expect(resolveWorkspacePath(workspace, './src')).toBe(resolveWorkspacePath(workspace, 'src'))
  })

  it('accepts an absolute path that is inside the workspace', () => {
    const inside = path.join(workspace, 'src')
    expect(resolveWorkspacePath(workspace, inside)).toBe(fs.realpathSync(inside))
  })

  it('accepts nested relative traversal that stays inside (src/../src)', () => {
    expect(resolveWorkspacePath(workspace, 'src/../src')).toBe(
      fs.realpathSync(path.join(workspace, 'src')),
    )
  })

  it('reports missing paths as file_not_found unless allowMissing', () => {
    expectToolError(() => resolveWorkspacePath(workspace, 'nope.ts'), 'file_not_found')
    const allowed = resolveWorkspacePath(workspace, 'nope.ts', { allowMissing: true })
    expect(allowed).toBe(path.join(fs.realpathSync(workspace), 'nope.ts'))
  })
})

describe('resolveWorkspacePath — escape attempts', () => {
  it('rejects "../outside"', () => {
    expectToolError(() => resolveWorkspacePath(workspace, '../outside'), 'path_outside_workspace')
  })

  it('rejects "../../outside" and deeper chains', () => {
    expectToolError(
      () => resolveWorkspacePath(workspace, '../../outside'),
      'path_outside_workspace',
    )
    expectToolError(
      () => resolveWorkspacePath(workspace, 'src/../../../../outside'),
      'path_outside_workspace',
    )
  })

  it('rejects an absolute path outside the workspace', () => {
    expectToolError(() => resolveWorkspacePath(workspace, outside), 'path_outside_workspace')
  })

  it('rejects a Windows-style absolute path on another drive', () => {
    if (process.platform !== 'win32') return
    expectToolError(
      () => resolveWorkspacePath(workspace, 'Z:\\evil\\file.txt'),
      'path_outside_workspace',
    )
    expectToolError(
      () => resolveWorkspacePath(workspace, 'Z:/evil/file.txt'),
      'path_outside_workspace',
    )
  })

  it('rejects a POSIX absolute path outside the workspace', () => {
    if (process.platform === 'win32') return
    expectToolError(() => resolveWorkspacePath(workspace, '/etc/passwd'), 'path_outside_workspace')
  })

  it('rejects backslash traversal on every platform', () => {
    expectToolError(() => resolveWorkspacePath(workspace, '..\\outside'), 'path_outside_workspace')
  })

  it('rejects empty and whitespace paths', () => {
    expectToolError(() => resolveWorkspacePath(workspace, ''), 'invalid_input')
    expectToolError(() => resolveWorkspacePath(workspace, '   '), 'invalid_input')
  })

  it('rejects NUL bytes in paths', () => {
    expectToolError(() => resolveWorkspacePath(workspace, 'src\0/auth.ts'), 'invalid_input')
  })

  it('cannot escape via src/../.. even with allowMissing', () => {
    expectToolError(
      () => resolveWorkspacePath(workspace, '../outside-2', { allowMissing: true }),
      'path_outside_workspace',
    )
  })
})

describe('resolveWorkspacePath — symlinks', () => {
  it('rejects a symlink inside the workspace pointing outside it', () => {
    const link = path.join(workspace, 'leak')
    try {
      if (process.platform === 'win32') {
        // Junctions do not require elevated privileges on Windows.
        fs.symlinkSync(outside, link, 'junction')
      } else {
        fs.symlinkSync(outside, link, 'dir')
      }
    } catch {
      return // environment cannot create symlinks — documented limitation
    }
    expectToolError(
      () => resolveWorkspacePath(workspace, 'leak/secret.txt'),
      'path_outside_workspace',
    )
  })

  it('allows a symlink that stays inside the workspace', () => {
    const link = path.join(workspace, 'alias')
    try {
      if (process.platform === 'win32') {
        fs.symlinkSync(path.join(workspace, 'src'), link, 'junction')
      } else {
        fs.symlinkSync(path.join(workspace, 'src'), link, 'dir')
      }
    } catch {
      return // environment cannot create symlinks — documented limitation
    }
    expect(resolveWorkspacePath(workspace, 'alias/auth/token.ts')).toBe(
      fs.realpathSync(path.join(workspace, 'src', 'auth', 'token.ts')),
    )
  })
})

describe('toWorkspaceRelative', () => {
  it('renders the root as "."', () => {
    expect(toWorkspaceRelative(workspace, workspace)).toBe('.')
  })

  it('renders "/"-separated relative paths on every platform', () => {
    const absolute = path.join(workspace, 'src', 'auth', 'token.ts')
    expect(toWorkspaceRelative(workspace, absolute)).toBe('src/auth/token.ts')
  })
})
