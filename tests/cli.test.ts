import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli/program.js'
import type { CliOptions, RunOptions } from '../src/cli/program.js'

interface Captured {
  runs: RunOptions[]
  doctors: CliOptions[]
}

function makeProgram() {
  const captured: Captured = { runs: [], doctors: [] }
  const program = buildProgram('0.0.0-test', {
    run: async (options) => {
      captured.runs.push(options)
    },
    doctor: async (options) => {
      captured.doctors.push(options)
    },
  })
  return { program, captured }
}

describe('lunar (default command)', () => {
  it('launches without a task when no arguments are given', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync([], { from: 'user' })
    expect(captured.runs).toHaveLength(1)
    expect(captured.runs[0]?.task).toBeUndefined()
    expect(captured.doctors).toHaveLength(0)
  })

  it('joins positional arguments into a single task string', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['fix', 'the', 'auth', 'bug'], { from: 'user' })
    expect(captured.runs[0]?.task).toBe('fix the auth bug')
  })

  it('passes --debug through', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['--debug'], { from: 'user' })
    expect(captured.runs[0]?.debug).toBe(true)
  })

  it('leaves debug unset when the flag is absent', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync([], { from: 'user' })
    expect(captured.runs[0]?.debug).toBeUndefined()
  })

  it('resolves --cwd to an absolute path', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['--cwd', 'relative/dir'], { from: 'user' })
    expect(captured.runs[0]?.cwd).toBe(path.resolve('relative/dir'))
  })

  it('defaults --cwd to the process working directory', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync([], { from: 'user' })
    expect(captured.runs[0]?.cwd).toBe(process.cwd())
  })

  it('combines a task with global options', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['--debug', 'run', 'the', 'tests'], { from: 'user' })
    expect(captured.runs[0]).toMatchObject({ task: 'run the tests', debug: true })
  })
})

describe('lunar --engineer (Phase 3 flags)', () => {
  it('passes --engineer through with a task', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['add', 'a', 'health', 'endpoint', '--engineer'], { from: 'user' })
    expect(captured.runs[0]).toMatchObject({
      task: 'add a health endpoint',
      engineer: true,
    })
  })

  it('passes --yes through for trusted mode', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['do', 'it', '--engineer', '--yes'], { from: 'user' })
    expect(captured.runs[0]).toMatchObject({ engineer: true, yes: true })
  })

  it('leaves engineer and yes unset by default', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['explain', 'this'], { from: 'user' })
    expect(captured.runs[0]?.engineer).toBeUndefined()
    expect(captured.runs[0]?.yes).toBeUndefined()
  })

  it('does not leak --engineer into the doctor subcommand', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['doctor'], { from: 'user' })
    expect(captured.doctors).toHaveLength(1)
    expect(captured.runs).toHaveLength(0)
  })
})

describe('lunar doctor', () => {
  it('routes to the doctor handler, not run', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['doctor'], { from: 'user' })
    expect(captured.doctors).toHaveLength(1)
    expect(captured.runs).toHaveLength(0)
  })

  it('keeps a global --cwd when the subcommand does not override it', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['--cwd', 'some/dir', 'doctor'], { from: 'user' })
    expect(captured.doctors[0]?.cwd).toBe(path.resolve('some/dir'))
  })

  it('lets a subcommand --cwd win over the global one', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['--cwd', 'global/dir', 'doctor', '--cwd', 'sub/dir'], {
      from: 'user',
    })
    expect(captured.doctors[0]?.cwd).toBe(path.resolve('sub/dir'))
  })

  it('passes --debug to the doctor handler', async () => {
    const { program, captured } = makeProgram()
    await program.parseAsync(['doctor', '--debug'], { from: 'user' })
    expect(captured.doctors[0]?.debug).toBe(true)
  })
})
