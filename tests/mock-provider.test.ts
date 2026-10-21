import { describe, expect, it } from 'vitest'

import { ProviderError } from '../src/domain/errors/index.js'
import { MockProvider } from '../src/providers/mock.js'
import type { LLMRequest } from '../src/providers/types.js'

const request: LLMRequest = {
  model: 'mock-1',
  messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 0 }],
}

describe('MockProvider', () => {
  it('is deterministic and needs no API key', async () => {
    const provider = new MockProvider()
    const a = await provider.generate(request)
    const b = await provider.generate(request)
    expect(a.message.content).toBe(b.message.content)
    expect(provider.requiresApiKey).toBe(false)
    expect(provider.defaultModel).toBe('mock-1')
  })

  it('records every request for assertions', async () => {
    const provider = new MockProvider()
    await provider.generate(request)
    await provider.generate(request)
    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[0]).toBe(request)
  })

  it('returns scripted responses, usage, and finish reasons', async () => {
    const provider = new MockProvider({
      response: 'scripted',
      usage: { inputTokens: 3, outputTokens: 2 },
      finishReason: 'length',
    })
    const response = await provider.generate(request)
    expect(response.message.content).toBe('scripted')
    expect(response.finishReason).toBe('length')
    expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  })

  it('reports no usage when none is configured (never invented)', async () => {
    const response = await new MockProvider().generate(request)
    expect(response.usage).toBeUndefined()
  })

  it('rejects with the scripted error', async () => {
    const provider = new MockProvider({ error: new ProviderError('scripted failure') })
    await expect(provider.generate(request)).rejects.toThrow('scripted failure')
  })

  it('streams scripted deltas in order', async () => {
    const provider = new MockProvider({ deltas: ['one ', 'two ', 'three'] })
    const seen: string[] = []
    const response = await provider.stream(request, { onText: (d) => seen.push(d) })
    expect(seen).toEqual(['one ', 'two ', 'three'])
    expect(response.message.content).toBe('one two three')
  })

  it('honours cancellation mid-delay', async () => {
    const provider = new MockProvider({ delayMs: 1000 })
    const controller = new AbortController()
    const promise = provider.generate(request, { signal: controller.signal })
    setTimeout(() => controller.abort(), 5)
    await expect(promise).rejects.toThrow()
  })
})
