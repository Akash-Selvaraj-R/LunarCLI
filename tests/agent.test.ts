import { describe, expect, it } from 'vitest'

import { AgentRuntime } from '../src/agent/runtime.js'
import type { AgentEvent } from '../src/agent/events.js'
import { CLIError, ProviderError } from '../src/domain/errors/index.js'
import { createMessage } from '../src/domain/models/session.js'
import { MockProvider } from '../src/providers/mock.js'
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/providers/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { Workspace } from '../src/domain/types/workspace.js'

const workspace: Workspace = {
  cwd: '/repo',
  root: '/repo',
  name: '~/repo',
  git: { isRepository: true, root: '/repo', branch: 'main' },
}

function makeRuntime(provider: MockProvider, tools?: ToolRegistry): AgentRuntime {
  return new AgentRuntime({
    provider,
    model: provider.defaultModel,
    workspace,
    ...(tools ? { tools } : {}),
  })
}

/** Collect every event a run emits. */
function recorder(): { events: AgentEvent[]; onEvent: (event: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

describe('AgentRuntime — happy path', () => {
  it('runs a request end to end and returns the assistant response', async () => {
    const provider = new MockProvider({ response: 'The answer.' })
    const agent = makeRuntime(provider)
    const { events, onEvent } = recorder()

    const result = await agent.run('explain this project', { onEvent })

    expect(result.status).toBe('completed')
    expect(result.text).toBe('The answer.')
    expect(provider.calls).toHaveLength(1)

    // Thinking → responding → deltas → response lifecycle.
    expect(events.map((e) => e.type)).toEqual(['status', 'status', 'delta', 'delta', 'response'])
    expect(events[0]).toEqual({ type: 'status', status: 'thinking' })
    expect(events[1]).toEqual({ type: 'status', status: 'responding' })
    expect(events.at(-1)).toMatchObject({ type: 'response', text: 'The answer.' })
  })

  it('sends the system prompt first and the user request last', async () => {
    const provider = new MockProvider()
    const agent = makeRuntime(provider)
    await agent.run('first question')

    const request = provider.calls[0]!
    expect(request.model).toBe('mock-1')
    expect(request.messages[0]?.role).toBe('system')
    expect(request.messages[0]?.content).toContain('You are Lunar')
    expect(request.messages[0]?.content).toContain('branch: main')
    expect(request.messages[request.messages.length - 1]?.content).toBe('first question')
  })

  it('keeps the system prompt out of conversation history', async () => {
    const provider = new MockProvider()
    const agent = makeRuntime(provider)
    await agent.run('hello')
    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('carries conversation history into subsequent requests', async () => {
    const provider = new MockProvider({ response: 'Answer one.' })
    const agent = makeRuntime(provider)

    await agent.run('question one')
    await agent.run('question two')

    expect(provider.calls).toHaveLength(2)
    const roles = provider.calls[1]!.messages.map((m) => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'user'])
    const contents = provider.calls[1]!.messages.map((m) => m.content)
    expect(contents[1]).toBe('question one')
    expect(contents[2]).toBe('Answer one.')
    expect(contents[3]).toBe('question two')
  })

  it('updates conversation state in order', async () => {
    const provider = new MockProvider({ response: 'A1' })
    const agent = makeRuntime(provider)

    await agent.run('Q1')
    await agent.run('Q2')

    expect(agent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(agent.messages.map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2', 'A1'])
  })

  it('reports provider usage when available and omits it otherwise', async () => {
    const withUsage = new MockProvider({ usage: { inputTokens: 10, outputTokens: 4 } })
    const agentA = makeRuntime(withUsage)
    const resultA = await agentA.run('with usage')
    expect(resultA.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 })

    const withoutUsage = new MockProvider()
    const agentB = makeRuntime(withoutUsage)
    const resultB = await agentB.run('no usage')
    expect(resultB.usage).toBeUndefined()
  })

  it('emits streamed deltas that concatenate to the full response', async () => {
    const provider = new MockProvider({ deltas: ['JWT ', 'auth ', 'works ', 'like ', 'this'] })
    const agent = makeRuntime(provider)
    const { events, onEvent } = recorder()

    const result = await agent.run('explain JWT auth', { onEvent })

    const streamed = events
      .filter((event): event is Extract<AgentEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.text)
      .join('')
    expect(streamed).toBe(result.text)
    expect(result.text).toBe('JWT auth works like this')
    // Exactly one responding transition, at the first delta.
    expect(events.filter((e) => e.type === 'status' && e.status === 'responding')).toHaveLength(1)
  })
})

describe('AgentRuntime — failures', () => {
  it('returns a structured error when the provider fails', async () => {
    const provider = new MockProvider({ error: new ProviderError('provider exploded') })
    const agent = makeRuntime(provider)
    const { events, onEvent } = recorder()

    const result = await agent.run('hello', { onEvent })

    expect(result.status).toBe('error')
    expect(result.error).toBeInstanceOf(ProviderError)
    expect(result.error?.message).toBe('provider exploded')
    expect(result.text).toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'error', error: result.error })

    // The user message was recorded; no phantom assistant reply was added.
    expect(agent.messages.map((m) => m.role)).toEqual(['user'])
  })

  it('never rejects — failures land in the result', async () => {
    const provider = new MockProvider({ error: new Error('unexpected crash') })
    const agent = makeRuntime(provider)
    await expect(agent.run('hello')).resolves.toMatchObject({ status: 'error' })
  })

  it('wraps non-Lunar throwables as a safe ProviderError', async () => {
    const provider = new MockProvider({ error: new Error('boom sk-lunar-secret-key-123456') })
    const agent = makeRuntime(provider)
    const result = await agent.run('hello')
    expect(result.error).toBeInstanceOf(ProviderError)
    // Inline secrets are scrubbed from the surfaced message.
    expect(result.error?.message).not.toContain('sk-lunar-secret-key-123456')
    expect(result.error?.message).toContain('[redacted]')
  })

  it('refuses empty input without calling the provider', async () => {
    const provider = new MockProvider()
    const agent = makeRuntime(provider)
    const { events, onEvent } = recorder()

    const result = await agent.run('   \n  ', { onEvent })

    expect(result.status).toBe('error')
    expect(result.error).toBeInstanceOf(CLIError)
    expect(provider.calls).toHaveLength(0)
    expect(agent.messages).toHaveLength(0)
    expect(events[0]).toMatchObject({ type: 'error' })
  })
})

describe('AgentRuntime — cancellation', () => {
  it('cancels an in-flight request and returns to idle cleanly', async () => {
    const provider = new MockProvider({ response: 'never printed', delayMs: 500 })
    const agent = makeRuntime(provider)
    const controller = new AbortController()
    const { events, onEvent } = recorder()

    const promise = agent.run('slow request', { signal: controller.signal, onEvent })
    setTimeout(() => controller.abort(), 10)
    const result = await promise

    expect(result.status).toBe('cancelled')
    expect(result.text).toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'cancelled' })
    // No assistant message was appended for a cancelled turn.
    expect(agent.messages.map((m) => m.role)).toEqual(['user'])
    expect(agent.messages.map((m) => m.content)).toEqual(['slow request'])
  })

  it('treats a pre-aborted signal as cancelled', async () => {
    const provider = new MockProvider({ delayMs: 100 })
    const agent = makeRuntime(provider)
    const controller = new AbortController()
    controller.abort()

    const result = await agent.run('already cancelled', { signal: controller.signal })
    expect(result.status).toBe('cancelled')
    expect(agent.messages.every((m) => m.role !== 'assistant')).toBe(true)
  })
})

describe('AgentRuntime — tool-call foundation', () => {
  it('refuses model tool calls and executes nothing', async () => {
    const provider = new MockProvider({
      response: 'I wanted to run something',
      toolCalls: [{ id: 'call_1', name: 'shell', arguments: { command: 'rm -rf /' } }],
    })
    const tools = new ToolRegistry()
    const agent = makeRuntime(provider, tools)
    const { events, onEvent } = recorder()

    const result = await agent.run('do something dangerous', { onEvent })

    expect(result.status).toBe('completed')
    expect(result.text).toContain('shell')
    expect(result.text).toContain('not available in Phase 1')
    expect(result.text).toContain('No commands were executed')

    // The refusal was recorded as the assistant message.
    const last = agent.messages.at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.content).toBe(result.text)

    // Nothing executed; the registry is untouched and empty.
    expect(tools.size).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'response' })
  })

  it('advertises registered tools to the provider, but still never executes them', async () => {
    const provider = new MockProvider({ response: 'ok' })
    const tools = new ToolRegistry()
    tools.register({
      definition: { name: 'read_file', description: 'read', parameters: {} },
      execute: async () => {
        throw new Error('Phase 1 must never execute tools')
      },
    })
    const agent = makeRuntime(provider, tools)
    await agent.run('read something')
    expect(provider.calls[0]?.tools?.map((t) => t.name)).toEqual(['read_file'])
  })
})

/** Fallback provider without streaming — exercises the generate() path. */
function nonStreamingProvider(received: LLMRequest[]): LLMProvider {
  return {
    id: 'once',
    name: 'Once',
    models: ['once-1'],
    defaultModel: 'once-1',
    requiresApiKey: false,
    generate: async (request: LLMRequest): Promise<LLMResponse> => {
      received.push(request)
      return { message: createMessage('assistant', 'Non-streamed answer.'), finishReason: 'stop' }
    },
  }
}

describe('AgentRuntime — providers without streaming', () => {
  it('uses generate() and emits a single response event', async () => {
    const received: LLMRequest[] = []
    const agent = new AgentRuntime({
      provider: nonStreamingProvider(received),
      model: 'once-1',
      workspace,
    })
    const { events, onEvent } = recorder()

    const result = await agent.run('hello', { onEvent })

    expect(result.status).toBe('completed')
    expect(result.text).toBe('Non-streamed answer.')
    expect(received).toHaveLength(1)
    expect(events.some((event) => event.type === 'delta')).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'response', text: 'Non-streamed answer.' })
  })
})
