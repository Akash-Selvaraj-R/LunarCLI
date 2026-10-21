import { Readable, Writable } from 'node:stream'

import { render } from 'ink'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { App } from '../src/app/app.js'
import { AgentRuntime } from '../src/agent/runtime.js'
import type { LunarConfig } from '../src/config/schema.js'
import { createSilentLogger } from '../src/logging/logger.js'
import { MockProvider } from '../src/providers/mock.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolRisk } from '../src/tools/risk.js'
import type { Workspace } from '../src/domain/types/workspace.js'

/**
 * Interactive-mode tests: drive the real Ink app through a fake terminal
 * (fake stdin/stdout), exercising the Phase 1 submit → think → stream →
 * respond flow, empty-input handling, Ctrl+C cancellation, and Ctrl+D exit.
 */

const workspace: Workspace = {
  cwd: '/repo',
  root: '/repo',
  name: '~/repo',
  git: { isRepository: true, root: '/repo', branch: 'main' },
}

const config: LunarConfig = { debug: false }

class FakeStdout extends Writable {
  data = ''
  readonly columns = 80
  readonly isTTY = true

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.data += chunk.toString()
    callback()
  }

  get text(): string {
    return this.data
  }

  /** The most recent rendered frame (raw `data` accumulates old frames). */
  get lastFrame(): string {
    const frames = this.data.split('\u001B[?2026h')
    return frames[frames.length - 1] ?? ''
  }
}

function makeStdin(): NodeJS.ReadStream {
  // Ink uses readable-mode input (`stdin.read()` on 'readable'), so a real
  // Readable with TTY-ish properties is the closest stand-in for a terminal.
  const stdin = new Readable({ read() {} }) as Readable & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  return stdin as unknown as NodeJS.ReadStream
}

function renderApp(provider: MockProvider) {
  const stdin = makeStdin()
  const stdout = new FakeStdout()
  const agent = new AgentRuntime({ provider, model: provider.defaultModel, workspace })
  const instance = render(
    <App
      config={config}
      workspace={workspace}
      version="0.1.0"
      logger={createSilentLogger()}
      agent={agent}
      interactive
    />,
    { stdin, stdout, patchConsole: false, exitOnCtrlC: false },
  )
  return { instance, stdin, stdout, agent }
}

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the terminal output satisfies the predicate (render timing varies under load). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await tick(10)
  }
}

function press(stdin: NodeJS.ReadStream, data: string): void {
  ;(stdin as unknown as Readable).push(Buffer.from(data, 'utf8'))
}

describe('interactive App (driven terminal)', () => {
  it('submits input, streams the answer, and keeps the transcript', async () => {
    const provider = new MockProvider({ deltas: ['JWT ', 'auth ', 'explained.'], delayMs: 0 })
    const { instance, stdin, stdout } = renderApp(provider)
    try {
      press(stdin, 'explain jwt auth')
      await tick()
      press(stdin, '\r')
      await waitFor(() => stdout.text.includes('JWT auth explained.'))
      press(stdin, 'more detail')
      await tick()
      press(stdin, '\r')
      await waitFor(() => stdout.text.includes('more detail') && provider.calls.length === 2)

      const output = stdout.text
      expect(output).toContain('explain jwt auth')
      expect(output).toContain('JWT auth explained.')
      expect(output).toContain('more detail')
      expect(provider.calls).toHaveLength(2)
      // Conversation history reached the provider on turn 2.
      expect(provider.calls[1]?.messages.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'user',
      ])
      // No spinner left behind.
      expect(output).not.toContain('Request cancelled.')
    } finally {
      instance.unmount()
    }
  })

  it('ignores empty input without touching the provider', async () => {
    const provider = new MockProvider()
    const { instance, stdin, stdout } = renderApp(provider)
    try {
      press(stdin, '   ')
      await tick()
      press(stdin, '\r')
      await tick()

      expect(provider.calls).toHaveLength(0)
      expect(stdout.text).not.toContain('thinking...')
    } finally {
      instance.unmount()
    }
  })

  it('renders provider errors as transcript entries and stays usable', async () => {
    const provider = new MockProvider({ error: new Error('network down') })
    const { instance, stdin, stdout } = renderApp(provider)
    try {
      press(stdin, 'hello')
      await tick()
      press(stdin, '\r')
      await waitFor(() => stdout.text.includes('network down'))

      // The spinner is gone from the CURRENT frame (old frames stay in raw output).
      expect(stdout.lastFrame).not.toContain('thinking...')
      expect(stdout.lastFrame).toContain('network down')
    } finally {
      instance.unmount()
    }
  })

  it('cancels an in-flight request on Ctrl+C and returns to the prompt', async () => {
    const provider = new MockProvider({ response: 'too late', delayMs: 400 })
    const { instance, stdin, stdout } = renderApp(provider)
    try {
      press(stdin, 'slow question')
      await tick()
      press(stdin, '\r')
      await waitFor(() => stdout.text.includes('thinking...'))

      press(stdin, '\x03') // Ctrl+C
      await waitFor(() => stdout.text.includes('Request cancelled.'))
      expect(stdout.lastFrame).not.toContain('too late')
      // The app is still alive — cancellation never crashes the UI, and the
      // next submit reaches the provider again.
      press(stdin, 'follow-up')
      await tick()
      press(stdin, '\r')
      await waitFor(() => provider.calls.length >= 2)
    } finally {
      instance.unmount()
    }
  })

  it('exits cleanly on Ctrl+D', async () => {
    const provider = new MockProvider()
    const { instance, stdin } = renderApp(provider)
    let exited = false
    const exitPromise = instance.waitUntilExit().then(() => {
      exited = true
    })
    press(stdin, '\x04') // Ctrl+D
    await Promise.race([exitPromise, tick(2000)])
    expect(exited).toBe(true)
  })
})

describe('interactive App — tool activity', () => {
  it('renders tool calls and results, then the final answer', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'list_directory',
      description: 'List a directory',
      risk: ToolRisk.SAFE,
      inputSchema: z.object({ path: z.string() }),
      execute: async (call) => ({
        toolCallId: call.id,
        success: true,
        output: { entries: [{ name: 'src', type: 'directory' }] },
      }),
      summarize: () => '2 entries in .',
    })
    const provider = new MockProvider({
      script: [
        { toolCalls: [{ id: 'c1', name: 'list_directory', arguments: { path: '.' } }] },
        { deltas: ['There ', 'is ', 'a ', 'src ', 'directory.'] },
      ],
    })
    const stdin = makeStdin()
    const stdout = new FakeStdout()
    const agent = new AgentRuntime({
      provider,
      model: provider.defaultModel,
      workspace,
      tools: registry,
    })
    const instance = render(
      <App
        config={config}
        workspace={workspace}
        version="0.3.0"
        logger={createSilentLogger()}
        agent={agent}
        interactive
      />,
      { stdin, stdout, patchConsole: false, exitOnCtrlC: false },
    )
    try {
      press(stdin, 'what is in this project?')
      await tick()
      press(stdin, '\r')
      await waitFor(() => stdout.text.includes('There is a src directory.'))

      const output = stdout.text
      // Tool activity, compact and visible.
      expect(output).toContain('◇')
      expect(output).toContain('list_directory')
      expect(output).toContain('path: .')
      expect(output).toContain('✓')
      expect(output).toContain('2 entries in .')
      // The final answer follows the tool activity.
      expect(output).toContain('There is a src directory.')
    } finally {
      instance.unmount()
    }
  })
})
