import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { AgentRuntime } from '../src/agent/runtime.js'
import type { AgentEvent } from '../src/agent/events.js'
import { CLIError, ProviderError } from '../src/domain/errors/index.js'
import { createMessage } from '../src/domain/models/session.js'
import { MockProvider } from '../src/providers/mock.js'
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/providers/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolRisk } from '../src/tools/risk.js'
import type { Tool } from '../src/tools/types.js'
import type { Workspace } from '../src/domain/types/workspace.js'

const workspace: Workspace = {
  cwd: '/repo',
  root: '/repo',
  name: '~/repo',
  git: { isRepository: true, root: '/repo', branch: 'main' },
}

function makeRuntime(
  provider: MockProvider,
  tools?: ToolRegistry,
  extra?: { maxToolIterations?: number },
): AgentRuntime {
  return new AgentRuntime({
    provider,
    model: provider.defaultModel,
    workspace,
    ...(tools ? { tools } : {}),
    ...(extra ? extra : {}),
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

describe('AgentRuntime — tool-call loop', () => {
  it('executes a permitted tool call and returns the final answer', async () => {
    const registry = new ToolRegistry()
    const executions: Array<{ id: string; input: unknown }> = []
    registry.register({
      name: 'echo_tool',
      description: 'Echo the input back.',
      risk: ToolRisk.SAFE,
      inputSchema: z.object({ text: z.string() }),
      execute: async (call) => {
        executions.push({ id: call.id, input: call.input })
        return {
          toolCallId: call.id,
          success: true,
          output: { echoed: (call.input as { text: string }).text },
        }
      },
      summarize: () => 'echoed',
    })
    const provider = new MockProvider({
      script: [
        { toolCalls: [{ id: 'call_1', name: 'echo_tool', arguments: { text: 'hello' } }] },
        { response: 'The tool said hello.' },
      ],
    })
    const agent = makeRuntime(provider, registry)
    const { events, onEvent } = recorder()

    const result = await agent.run('use the tool', { onEvent })

    expect(result.status).toBe('completed')
    expect(result.text).toBe('The tool said hello.')
    expect(executions).toEqual([{ id: 'call_1', input: { text: 'hello' } }])

    // Tool activity events for the UI.
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'echo_tool',
      arguments: { text: 'hello' },
    })
    expect(events).toContainEqual({
      type: 'tool_result',
      toolCallId: 'call_1',
      name: 'echo_tool',
      success: true,
      summary: 'echoed',
    })

    // Conversation carries the tool exchange into the next request:
    // assistant (tool call) → tool (result) → assistant (final).
    const secondCall = provider.calls[1]!
    const roles = secondCall.messages.map((m) => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(secondCall.messages[2]?.toolCalls).toEqual([
      { id: 'call_1', name: 'echo_tool', arguments: { text: 'hello' } },
    ])
    expect(secondCall.messages[3]?.toolCallId).toBe('call_1')
    expect(secondCall.messages[3]?.toolName).toBe('echo_tool')
    expect(secondCall.messages[3]?.content).toContain('hello')
  })

  it('supports multiple tool calls across multiple rounds in one request', async () => {
    const registry = new ToolRegistry()
    const executed: string[] = []
    const makeTool = (name: string): Tool => ({
      name,
      description: name,
      risk: ToolRisk.SAFE,
      inputSchema: z.object({}),
      execute: async (call) => {
        executed.push(name)
        return { toolCallId: call.id, success: true, output: { from: name } }
      },
    })
    registry.register(makeTool('find_files'))
    registry.register(makeTool('read_file'))
    const provider = new MockProvider({
      script: [
        { toolCalls: [{ id: 'c1', name: 'find_files', arguments: {} }] },
        { toolCalls: [{ id: 'c2', name: 'read_file', arguments: {} }] },
        { response: 'After reading, here is the answer.' },
      ],
    })
    const agent = makeRuntime(provider, registry)

    const result = await agent.run('inspect auth', {})

    expect(result.text).toBe('After reading, here is the answer.')
    expect(executed).toEqual(['find_files', 'read_file'])
    expect(provider.calls).toHaveLength(3)
    // Round 2 sees both the first result and the second call.
    expect(provider.calls[1]?.messages.at(-1)?.role).toBe('tool')
    expect(provider.calls[2]?.messages.at(-1)?.content).toContain('read_file')
  })

  it('turns an unknown tool into a failed result the model can react to', async () => {
    const provider = new MockProvider({
      script: [
        { toolCalls: [{ id: 'call_1', name: 'shell', arguments: { command: 'rm -rf /' } }] },
        { response: 'I do not have a shell tool.' },
      ],
    })
    const tools = new ToolRegistry() // empty — shell is not registered
    const agent = makeRuntime(provider, tools)
    const { events, onEvent } = recorder()

    const result = await agent.run('do something dangerous', { onEvent })

    expect(result.status).toBe('completed')
    expect(result.text).toBe('I do not have a shell tool.')
    // The failure is a structured tool result, not an execution.
    const failure = events.find(
      (event): event is Extract<AgentEvent, { type: 'tool_result' }> =>
        event.type === 'tool_result',
    )
    expect(failure).toMatchObject({ success: false, summary: 'tool_not_found' })
    // The serialized error is what the model sees.
    const toolMessage = provider.calls[1]?.messages.at(-1)
    expect(toolMessage?.role).toBe('tool')
    expect(toolMessage?.content).toContain('Unknown tool: shell')
  })

  it('refuses a mutating tool even when it is somehow registered', async () => {
    const registry = new ToolRegistry()
    let executed = false
    registry.register({
      name: 'write_file',
      description: 'Should never run.',
      risk: ToolRisk.MUTATING,
      inputSchema: z.object({ path: z.string() }),
      execute: async (call) => {
        executed = true
        return { toolCallId: call.id, success: true, output: {} }
      },
    })
    const provider = new MockProvider({
      script: [
        { toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'x' } }] },
        { response: 'That tool is not permitted.' },
      ],
    })
    const agent = makeRuntime(provider, registry) // default PermissionManager

    await agent.run('write a file', {})

    expect(executed).toBe(false)
    const toolMessage = provider.calls[1]?.messages.at(-1)
    expect(toolMessage?.content).toContain('not permitted')
  })

  it('stops safely when the tool iteration limit is reached', async () => {
    const provider = new MockProvider({
      toolCalls: [{ id: 'c', name: 'whatever', arguments: {} }], // every turn: tool call
    })
    const agent = makeRuntime(provider, undefined, { maxToolIterations: 3 })
    const { events, onEvent } = recorder()

    const result = await agent.run('loop forever', { onEvent })

    expect(result.status).toBe('completed')
    expect(result.text).toContain('Tool execution limit reached (3')
    // One initial call + one per completed round, then the cap stops it.
    expect(provider.calls.length).toBeLessThanOrEqual(4)
    expect(events.at(-1)).toMatchObject({ type: 'response' })
  })

  it('cancels during tool execution', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'slow_tool',
      description: 'Takes a while.',
      risk: ToolRisk.SAFE,
      inputSchema: z.object({}),
      execute: async (_call, context) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500)
          context.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
        return { toolCallId: 'x', success: true, output: {} }
      },
    })
    const provider = new MockProvider({
      toolCalls: [{ id: 'c1', name: 'slow_tool', arguments: {} }],
    })
    const agent = makeRuntime(provider, registry)
    const controller = new AbortController()
    const { events, onEvent } = recorder()

    const promise = agent.run('slow tool please', { signal: controller.signal, onEvent })
    setTimeout(() => controller.abort(), 20)
    const result = await promise

    expect(result.status).toBe('cancelled')
    expect(events.at(-1)).toEqual({ type: 'cancelled' })
  })

  it('advertises registered tools to the provider with their definitions', async () => {
    const provider = new MockProvider({ response: 'ok' })
    const tools = new ToolRegistry()
    tools.register({
      name: 'read_file',
      description: 'Read a file',
      risk: ToolRisk.READ_ONLY,
      inputSchema: z.object({ path: z.string() }),
      execute: async (call) => ({ toolCallId: call.id, success: true, output: 'x' }),
    })
    const agent = makeRuntime(provider, tools)
    await agent.run('read something')
    expect(provider.calls[0]?.tools?.map((t) => t.name)).toEqual(['read_file'])
    // The system prompt advertises the tool by name.
    expect(provider.calls[0]?.messages[0]?.content).toContain('read_file')
  })

  it('reports a parseable tool-call request with no calls as a soft failure', async () => {
    const provider = new MockProvider({
      finishReason: 'tool_calls',
      response: 'confused',
    })
    const agent = makeRuntime(provider)
    const result = await agent.run('weird response', {})
    expect(result.status).toBe('completed')
    expect(result.text).toContain('no valid tool call')
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
