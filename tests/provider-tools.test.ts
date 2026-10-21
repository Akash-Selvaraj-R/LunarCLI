import { describe, expect, it } from 'vitest'

import { createMessage } from '../src/domain/models/session.js'
import { GeminiProvider } from '../src/providers/gemini.js'
import { OpenAIProvider } from '../src/providers/openai.js'
import type { FetchLike } from '../src/providers/types.js'

/**
 * Provider tool-format mapping: normalized ToolCall/ToolResult in,
 * provider-specific wire format out. The agent never sees these shapes.
 */

function capturingFetch(response: Response): {
  fetchImpl: FetchLike
  calls: Array<{ init: RequestInit }>
} {
  const calls: Array<{ init: RequestInit }> = []
  const fetchImpl: FetchLike = async (_url, init = {}) => {
    calls.push({ init })
    return response.clone()
  }
  return { fetchImpl, calls }
}

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** The normalized conversation: user → assistant(tool call) → tool → assistant. */
const toolConversation = [
  createMessage('user', 'read a file'),
  createMessage('assistant', '', {
    toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts' } }],
  }),
  createMessage('tool', '{"lineCount":3}', { toolCallId: 'call_1', toolName: 'read_file' }),
  createMessage('assistant', 'The file has 3 lines.'),
]

describe('OpenAIProvider — tool wire format', () => {
  it('parses streamed tool_call fragments accumulated by index', async () => {
    const { fetchImpl, calls } = capturingFetch(
      sse([
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":' } }],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: null },
      ]),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk-test', fetch: fetchImpl })
    const response = await provider.generate({
      model: 'gpt-5',
      messages: [createMessage('user', 'go')],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    })

    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls).toEqual([
      { id: 'call_9', name: 'read_file', arguments: { path: 'a.ts' } },
    ])

    // The tools array is advertised in OpenAI's shape.
    const body = JSON.parse(String(calls[0]?.init.body)) as { tools?: unknown[] }
    expect(body.tools?.[0]).toMatchObject({ type: 'function', function: { name: 'read_file' } })
  })

  it('sends assistant tool calls and tool results in OpenAI format', async () => {
    const { fetchImpl, calls } = capturingFetch(
      sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: null }]),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk-test', fetch: fetchImpl })
    await provider.generate({ model: 'gpt-5', messages: toolConversation })

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      messages: Array<Record<string, unknown>>
    }
    const assistantTurn = body.messages[1]
    expect(assistantTurn?.role).toBe('assistant')
    expect(assistantTurn?.content).toBeNull()
    expect(assistantTurn?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
      },
    ])
    const toolTurn = body.messages[2]
    expect(toolTurn).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"lineCount":3}' })
  })
})

describe('GeminiProvider — tool wire format', () => {
  it('parses functionCall parts into normalized tool calls', async () => {
    const { fetchImpl, calls } = capturingFetch(
      sse([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'git_status', args: {} } }],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
    )
    const provider = new GeminiProvider({ apiKey: 'AIza-test', fetch: fetchImpl })
    const response = await provider.generate({
      model: 'gemini-3-pro',
      messages: [createMessage('user', 'git status please')],
      tools: [{ name: 'git_status', description: 'Status', parameters: { type: 'object' } }],
    })

    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls?.[0]?.name).toBe('git_status')

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      tools?: Array<{ functionDeclarations?: unknown[] }>
    }
    expect(body.tools?.[0]?.functionDeclarations?.[0]).toMatchObject({ name: 'git_status' })
  })

  it('sends assistant tool calls as functionCall parts and results as functionResponse', async () => {
    const { fetchImpl, calls } = capturingFetch(
      sse([
        {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' },
          ],
        },
      ]),
    )
    const provider = new GeminiProvider({ apiKey: 'AIza-test', fetch: fetchImpl })
    await provider.generate({ model: 'gemini-3-pro', messages: toolConversation })

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>
    }
    const [, modelTurn, responseTurn] = body.contents
    expect(modelTurn?.role).toBe('model')
    expect(modelTurn?.parts).toEqual([
      { functionCall: { name: 'read_file', args: { path: 'src/a.ts' } } },
    ])
    expect(responseTurn?.role).toBe('user')
    expect(responseTurn?.parts[0]).toMatchObject({
      functionResponse: {
        name: 'read_file',
        response: { success: true, result: '{"lineCount":3}' },
      },
    })
  })
})
