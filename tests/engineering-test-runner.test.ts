import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectTestCommand, parseCounts } from '../src/engineering/test-runner.js'
import { detectWorkspace } from '../src/workspace/detector.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Test-runner detection (Phase 3): repository-aware, never hard-coded
 * to one ecosystem, never invented by the model.
 */

let root: string
let workspace: Workspace

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-testrunner-'))
  workspace = detectWorkspace(root)
})

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('detectTestCommand', () => {
  it('detects an npm test script', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    )
    expect(detectTestCommand(workspace)).toEqual({ executable: 'npm', args: ['test'], cwd: '.' })
  })

  it('ignores the npm placeholder test script', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'Error: no test specified' } }),
    )
    expect(detectTestCommand(workspace)).toBeUndefined()
  })

  it('ignores a malformed package.json', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{oops')
    expect(detectTestCommand(workspace)).toBeUndefined()
  })

  it('detects cargo test', () => {
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "x"\n')
    expect(detectTestCommand(workspace)).toEqual({ executable: 'cargo', args: ['test'], cwd: '.' })
  })

  it('detects go test ./...', () => {
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/x\n')
    expect(detectTestCommand(workspace)).toEqual({
      executable: 'go',
      args: ['test', './...'],
      cwd: '.',
    })
  })

  it('detects pytest from pytest.ini', () => {
    fs.writeFileSync(path.join(root, 'pytest.ini'), '[pytest]\n')
    expect(detectTestCommand(workspace)).toEqual({ executable: 'pytest', args: [], cwd: '.' })
  })

  it('detects pytest from pyproject.toml', () => {
    fs.writeFileSync(
      path.join(root, 'pyproject.toml'),
      '[tool.pytest.ini_options]\nminversion = "7.0"\n',
    )
    expect(detectTestCommand(workspace)).toEqual({ executable: 'pytest', args: [], cwd: '.' })
  })

  it('detects a Makefile test target', () => {
    fs.writeFileSync(path.join(root, 'Makefile'), 'build:\n\techo build\n\ntest:\n\techo test\n')
    expect(detectTestCommand(workspace)).toEqual({ executable: 'make', args: ['test'], cwd: '.' })
  })

  it('prefers package.json over other ecosystems', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\n')
    expect(detectTestCommand(workspace)?.executable).toBe('npm')
  })

  it('returns undefined when no manifest exists', () => {
    expect(detectTestCommand(workspace)).toBeUndefined()
  })
})

describe('parseCounts', () => {
  it('parses vitest summary output', () => {
    const output = '✓ 12 tests\n\n Test Files  3 passed (3)\n      Tests  12 passed (12)\n'
    expect(parseCounts(output)).toEqual({ passed: 12 })
  })

  it('parses vitest output with failures', () => {
    const output = 'Tests  2 failed | 10 passed (12)'
    expect(parseCounts(output)).toEqual({ passed: 10, failed: 2 })
  })

  it('parses jest summary output', () => {
    const output = 'Tests:       1 failed, 11 passed, 12 total'
    expect(parseCounts(output)).toEqual({ passed: 11, failed: 1 })
  })

  it('parses pytest summary output', () => {
    const output = '=== 2 failed, 10 passed in 4.80s ==='
    expect(parseCounts(output)).toEqual({ passed: 10, failed: 2 })
  })

  it('parses cargo test result lines', () => {
    const output = 'test result: ok. 5 passed; 0 failed; 0 ignored'
    expect(parseCounts(output)).toEqual({ passed: 5, failed: 0 })
  })

  it('returns undefined counts for output without summaries', () => {
    expect(parseCounts('running 3 tests\n...')).toEqual({})
  })
})
