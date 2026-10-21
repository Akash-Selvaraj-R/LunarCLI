import { describe, expect, it } from 'vitest'

import { ConfigurationError, ProviderError } from '../src/domain/errors/index.js'
import { AnthropicProvider } from '../src/providers/anthropic.js'
import { GeminiProvider } from '../src/providers/gemini.js'
import { OpenAIProvider } from '../src/providers/openai.js'
import type { FetchLike, LLMRequest } from '../src/providers/types.js'

/**
 * Transport-level provider tests.
 *
 * Every test injects a fake `fetch` — the suite never touches the network
 * and never needs a real API key.
 */

const messages: LLMRequest['messages'] = [
  { id: 'sys', role: 'system', content: 'You are Lunar.', timestamp: 0 },
  { id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
]

/** Build an SSE Response from raw event payloads. */
function sse(events: unknown[], status = 200): Response {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** A fetch stub that captures the request and returns a canned response. */
function fakeFetch(response: Response | (() => never)): {
  fetchImpl: FetchLike
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init })
    if (typeof response === 'function') return response()
    return response.clone()
  }
  return { fetchImpl, calls }
}

describe('OpenAIProvider', () => {
  const apiKey = 'sk-lunar-test-key-abcdef'

  it('streams a response, parses deltas, usage, and finish reason', async () => {
    const { fetchImpl, calls } = fakeFetch(
      sse([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 1204, completion_tokens: 482, total_tokens: 1686 } },
        '[DONE]',
      ]),
    )
    const provider = new OpenAIProvider({ apiKey, fetch: fetchImpl })

    const deltas: string[] = []
    const response = await provider.stream(
      { model: 'gpt-5', messages },
      { onText: (delta) => deltas.push(delta) },
    )

    expect(response.message.role).toBe('assistant')
    expect(response.message.content).toBe('Hello')
    expect(response.finishReason).toBe('stop')
    expect(response.usage).toEqual({ inputTokens: 1204, outputTokens: 482, totalTokens: 1686 })
    expect(deltas).toEqual(['Hel', 'lo'])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${apiKey}`)
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body['model']).toBe('gpt-5')
    expect(body['stream']).toBe(true)
    expect(Array.isArray(body['messages'])).toBe(true)
  })

  it('generate() shares the transport path and still returns the full text', async () => {
    const { fetchImpl } = fakeFetch(
      sse([
        { choices: [{ delta: { content: 'Plain ' } }] },
        { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
        '[DONE]',
      ]),
    )
    const provider = new OpenAIProvider({ apiKey, fetch: fetchImpl })
    const response = await provider.generate({ model: 'gpt-5', messages })
    expect(response.message.content).toBe('Plain answer')
    expect(response.usage).toBeUndefined() // no usage reported → never invented
  })

  it('surfaces model-issued tool calls without executing anything', async () => {
    const { fetchImpl } = fakeFetch(
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: 'call_1', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        '[DONE]',
      ]),
    )
    const provider = new OpenAIProvider({ apiKey, fetch: fetchImpl })
    const response = await provider.generate({ model: 'gpt-5', messages })
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls?.[0]?.name).toBe('shell')
    expect(response.toolCalls?.[0]?.arguments).toEqual({ cmd: 'ls' })
  })

  it('throws a configuration error when the API key is missing (no network call)', async () => {
    const { fetchImpl, calls } = fakeFetch(sse([]))
    const provider = new OpenAIProvider({ fetch: fetchImpl })
    await expect(provider.generate({ model: 'gpt-5', messages })).rejects.toThrow(
      ConfigurationError,
    )
    expect(calls).toHaveLength(0)
  })

  it('maps 401 to a ProviderError that never leaks the key', async () => {
    const { fetchImpl } = fakeFetch(
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
        status: 401,
      }),
    )
    const provider = new OpenAIProvider({ apiKey, fetch: fetchImpl })
    try {
      await provider.generate({ model: 'gpt-5', messages })
      throw new Error('expected ProviderError')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError)
      const text = JSON.stringify(error)
      expect(text).not.toContain(apiKey)
      expect((error as ProviderError).message).toContain('Invalid API key')
      expect((error as ProviderError).hint).toContain('LUNAR_API_KEY')
    }
  })

  it('maps 429 to a rate-limit error', async () => {
    const { fetchImpl } = fakeFetch(
      new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 }),
    )
    const provider = new OpenAIProvider({ apiKey, fetch: fetchImpl })
    await expect(provider.generate({ model: 'gpt-5', messages })).rejects.toThrow(/Rate limited/)
  })

  it('maps 404 to an unsupported-model error', async () => {
    const { fetchImpl } = fakeFetch(
      new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }),
    )
    const provider = new OpenAIProvider({ apiKey, fetch: fetchImpl })
    try {
      await provider.generate({ model: 'gpt-9000', messages })
      throw new Error('expected ProviderError')
    } catch (error) {
      expect((error as ProviderError).hint).toContain('LUNAR_MODEL')
    }
  })

  it('maps network failures to a retry-oriented ProviderError', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    const provider = new OpenAIProvider({ apiKey, fetch: fetchImpl })
    try {
      await provider.generate({ model: 'gpt-5', messages })
      throw new Error('expected ProviderError')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).message).toContain('Unable to contact OpenAI')
      expect((error as ProviderError).hint).toContain('network')
    }
  })

  it('rejects malformed provider payloads as ProviderError', async () => {
    const { fetchImpl } = fakeFetch(sse(['{not valid json']))
    const provider = new OpenAIProvider({ apiKey, fetch: fetchImpl })
    await expect(provider.generate({ model: 'gpt-5', messages })).rejects.toThrow(
      /Malformed response/,
    )
  })
})

describe('AnthropicProvider', () => {
  const apiKey = 'sk-ant-lunar-test-key-abcdef'

  it('streams a response with usage from message_start/message_delta', async () => {
    const { fetchImpl, calls } = fakeFetch(
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 7 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]),
    )
    const provider = new AnthropicProvider({ apiKey, fetch: fetchImpl })

    const deltas: string[] = []
    const response = await provider.stream(
      { model: 'claude-sonnet-4-5', messages },
      { onText: (delta) => deltas.push(delta) },
    )

    expect(response.message.content).toBe('Hi there')
    expect(response.finishReason).toBe('stop')
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
    expect(deltas).toEqual(['Hi ', 'there'])

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(apiKey)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body['system']).toBe('You are Lunar.')
    expect(body['stream']).toBe(true)
    expect(body['max_tokens']).toBeGreaterThan(0)
  })

  it('reports tool_use as a tool call', async () => {
    const { fetchImpl } = fakeFetch(
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', content_block: { type: 'tool_use', name: 'shell' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]),
    )
    const provider = new AnthropicProvider({ apiKey, fetch: fetchImpl })
    const response = await provider.generate({ model: 'claude-sonnet-4-5', messages })
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls?.[0]?.name).toBe('shell')
  })

  it('maps missing credentials to a configuration error', async () => {
    const provider = new AnthropicProvider()
    await expect(provider.generate({ model: 'claude-sonnet-4-5', messages })).rejects.toThrow(
      ConfigurationError,
    )
  })

  it('turns stream-level error events into ProviderError', async () => {
    const { fetchImpl } = fakeFetch(
      sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]),
    )
    const provider = new AnthropicProvider({ apiKey, fetch: fetchImpl })
    await expect(provider.generate({ model: 'claude-sonnet-4-5', messages })).rejects.toThrow(
      /Overloaded/,
    )
  })
})

describe('GeminiProvider', () => {
  const apiKey = 'AIzaSyLunarTestKey1234567890abcdef'

  it('streams a response, mapping model role and usage metadata', async () => {
    const { fetchImpl, calls } = fakeFetch(
      sse([
        {
          candidates: [
            { content: { parts: [{ text: 'Gemini ' }], role: 'model' }, finishReason: 'STOP' },
          ],
        },
        {
          candidates: [{ content: { parts: [{ text: 'says hi' }], role: 'model' } }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 },
        },
      ]),
    )
    const provider = new GeminiProvider({ apiKey, fetch: fetchImpl })

    const deltas: string[] = []
    const response = await provider.stream(
      { model: 'gemini-3-pro', messages },
      { onText: (delta) => deltas.push(delta) },
    )

    expect(response.message.content).toBe('Gemini says hi')
    expect(response.finishReason).toBe('stop')
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 })
    expect(deltas).toEqual(['Gemini ', 'says hi'])

    // The key travels in a header — never in the URL.
    expect(calls[0]?.url).toContain(':streamGenerateContent?alt=sse')
    expect(calls[0]?.url).not.toContain(apiKey)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe(apiKey)
    const body = JSON.parse(String(calls[0]?.init.body)) as { contents: Array<{ role: string }> }
    expect(body.contents[0]?.role).toBe('user')
  })

  it('maps missing credentials to a configuration error', async () => {
    const provider = new GeminiProvider()
    await expect(provider.generate({ model: 'gemini-3-pro', messages })).rejects.toThrow(
      ConfigurationError,
    )
  })

  it('maps a blocked prompt to a ProviderError', async () => {
    const { fetchImpl } = fakeFetch(sse([{ promptFeedback: { blockReason: 'SAFETY' } }]))
    const provider = new GeminiProvider({ apiKey, fetch: fetchImpl })
    await expect(provider.generate({ model: 'gemini-3-pro', messages })).rejects.toThrow(/blocked/)
  })
})

describe('cancellation reaches the transport', () => {
  it('passes the abort signal through to fetch', async () => {
    const controller = new AbortController()
    const { fetchImpl, calls } = fakeFetch(
      sse([{ choices: [{ delta: { content: 'never' } }] }, '[DONE]']),
    )
    const provider = new OpenAIProvider({ apiKey: 'sk-x', fetch: fetchImpl })
    await provider.generate({ model: 'gpt-5', messages }, { signal: controller.signal })
    expect(calls[0]?.init.signal).toBe(controller.signal)
  })

  it('preserves the abort error instead of wrapping it', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const fetchImpl: FetchLike = async (_url, _init) => {
      controller.abort()
      throw abortError
    }
    const provider = new OpenAIProvider({ apiKey: 'sk-x', fetch: fetchImpl })
    await expect(
      provider.generate({ model: 'gpt-5', messages }, { signal: controller.signal }),
    ).rejects.toBe(abortError)
    expect(controller.signal.aborted).toBe(true)
  })
})
