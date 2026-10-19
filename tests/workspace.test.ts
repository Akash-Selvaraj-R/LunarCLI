import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WorkspaceError } from '../src/domain/errors/index.js'
import { displayPath } from '../src/utils/paths.js'
import { detectGit, detectWorkspace } from '../src/workspace/detector.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-workspace-test-'))
  tempDirs.push(dir)
  return dir
}

/** Create a fake git repository (no git binary needed). */
function makeFakeRepo(branch = 'main'): { repoRoot: string; nested: string } {
  const repoRoot = makeTempDir()
  fs.mkdirSync(path.join(repoRoot, '.git'))
  fs.writeFileSync(path.join(repoRoot, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  const nested = path.join(repoRoot, 'packages', 'app', 'src')
  fs.mkdirSync(nested, { recursive: true })
  return { repoRoot, nested }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('detectWorkspace', () => {
  it('detects a plain directory without git', () => {
    const dir = makeTempDir()
    const workspace = detectWorkspace(dir)
    expect(workspace.cwd).toBe(path.resolve(dir))
    expect(workspace.root).toBe(path.resolve(dir))
    expect(workspace.git.isRepository).toBe(false)
    expect(workspace.git.branch).toBeUndefined()
  })

  it('detects a git repository root and branch', () => {
    const { repoRoot } = makeFakeRepo('develop')
    const workspace = detectWorkspace(repoRoot)
    expect(workspace.root).toBe(path.resolve(repoRoot))
    expect(workspace.git.isRepository).toBe(true)
    expect(workspace.git.branch).toBe('develop')
  })

  it('finds the repository root from a nested directory', () => {
    const { repoRoot, nested } = makeFakeRepo('feature/x')
    const workspace = detectWorkspace(nested)
    expect(workspace.root).toBe(path.resolve(repoRoot))
    expect(workspace.git.branch).toBe('feature/x')
    expect(workspace.cwd).toBe(path.resolve(nested))
  })

  it('uses the home-relative display name', () => {
    const dir = makeTempDir()
    const workspace = detectWorkspace(dir)
    expect(workspace.name).toBe(displayPath(workspace.root))
    // Temp dirs are normally outside the home directory, so the raw path shows.
    expect(workspace.name.startsWith('~')).toBe(workspace.root.startsWith(os.homedir()))
  })

  it('throws WorkspaceError for a missing directory', () => {
    expect(() => detectWorkspace(path.join(os.tmpdir(), 'lunar-definitely-missing'))).toThrow(
      WorkspaceError,
    )
  })

  it('throws WorkspaceError for a file', () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'file.txt')
    fs.writeFileSync(file, 'x')
    expect(() => detectWorkspace(file)).toThrow(WorkspaceError)
  })
})

describe('detectGit', () => {
  it('reports detached HEAD as a short sha', () => {
    const repoRoot = makeTempDir()
    fs.mkdirSync(path.join(repoRoot, '.git'))
    fs.writeFileSync(path.join(repoRoot, '.git', 'HEAD'), 'abcdef1234567890\n')
    const git = detectGit(repoRoot)
    expect(git.isRepository).toBe(true)
    expect(git.branch).toBe('abcdef12')
  })

  it('tolerates a missing HEAD file', () => {
    const repoRoot = makeTempDir()
    fs.mkdirSync(path.join(repoRoot, '.git'))
    const git = detectGit(repoRoot)
    expect(git.isRepository).toBe(true)
    expect(git.branch).toBeUndefined()
  })
})
