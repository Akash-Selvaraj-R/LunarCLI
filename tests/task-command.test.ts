import { describe, expect, it, vi } from 'vitest'

import { runTask } from '../src/cli/commands/task.js'
import { AgentRuntime } from '../src/agent/runtime.js'
import { MockProvider } from '../src/providers/mock.js'
import { createSilentLogger } from '../src/logging/logger.js'
import type { Workspace } from '../src/domain/types/workspace.js'

const workspace: Workspace = {
  cwd: '/repo',
  root: '/repo',
  name: '~/repo',
  git: { isRepository: true, root: '/repo', branch: 'main' },
}

/** Capture everything the one-shot command writes to stdout. */
async function runOneShot(
  task: string,
  provider: MockProvider,
  debug = false,
): Promise<{ output: string; exitCode: number | undefined }> {
  const chunks: string[] = []
  const capture = (chunk: string | Uint8Array): boolean => {
    chunks.push(chunk.toString())
    return true
  }
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(capture as typeof process.stdout.write)
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(capture as typeof process.stderr.write)

  const previousExitCode = process.exitCode
  process.exitCode = undefined

  try {
    const agent = new AgentRuntime({
      provider,
      model: provider.defaultModel,
      workspace,
      logger: createSilentLogger(),
      version: '0.0.0-test',
    })
    await runTask({
      task,
      config: { debug },
      workspace,
      version: '0.0.0-test',
      logger: createSilentLogger(),
      agent,
    })
    return { output: chunks.join(''), exitCode: process.exitCode }
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
    process.exitCode = previousExitCode
  }
}

describe('lunar "<task>" (one-shot mode)', () => {
  it('prints the Lunar header, workspace/provider info, and the response', async () => {
    const provider = new MockProvider({ response: 'This is a TypeScript project.' })
    const { output, exitCode } = await runOneShot('explain this project', provider)

    expect(output).toContain('LUNARCLI')
    expect(output).toContain('workspace')
    expect(output).toContain('~/repo')
    expect(output).toContain('provider')
    expect(output).toContain('mock')
    expect(output).toContain('model')
    expect(output).toContain('mock-1')
    expect(output).toContain('thinking...')
    expect(output).toContain('This is a TypeScript project.')
    expect(exitCode).toBeUndefined()
  })

  it('sends the task through the agent to the provider', async () => {
    const provider = new MockProvider({ response: 'ok' })
    await runOneShot('explain this project', provider)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.messages.at(-1)?.content).toBe('explain this project')
    expect(provider.calls[0]?.messages[0]?.role).toBe('system')
  })

  it('exits non-zero with a clean error when the provider fails', async () => {
    const provider = new MockProvider({ error: new Error('network down') })
    const { output, exitCode } = await runOneShot('hi', provider)
    // printError writes to stderr, which runOneShot also captures.
    expect(output).toContain('network down')
    expect(output).toContain('error')
    expect(exitCode).toBe(1)
  })

  it('stays quiet about usage unless debug mode is on', async () => {
    const provider = new MockProvider({ response: 'x', usage: { inputTokens: 7, outputTokens: 3 } })
    const normal = await runOneShot('hi', provider, false)
    expect(normal.output).not.toContain('tokens')

    const debugProvider = new MockProvider({
      response: 'x',
      usage: { inputTokens: 7, outputTokens: 3 },
    })
    const debug = await runOneShot('hi', debugProvider, true)
    expect(debug.output).toContain('tokens')
    expect(debug.output).toContain('input 7')
    expect(debug.output).toContain('total 10')
  })
})
