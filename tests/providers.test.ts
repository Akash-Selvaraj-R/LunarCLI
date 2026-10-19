import { describe, expect, it } from 'vitest'

import { NotImplementedError, ProviderError } from '../src/domain/errors/index.js'
import { ProviderRegistry, createDefaultRegistry } from '../src/providers/registry.js'
import type { LLMProvider } from '../src/providers/types.js'

function stubProvider(id: string): LLMProvider {
  return {
    id,
    name: id,
    models: [],
    generate: async () => {
      throw new Error('not used in tests')
    },
  }
}

describe('ProviderRegistry', () => {
  it('registers and resolves providers', () => {
    const registry = new ProviderRegistry()
    const provider = stubProvider('test')
    registry.register(provider)
    expect(registry.has('test')).toBe(true)
    expect(registry.get('test')).toBe(provider)
  })

  it('rejects duplicate ids', () => {
    const registry = new ProviderRegistry()
    registry.register(stubProvider('dup'))
    expect(() => registry.register(stubProvider('dup'))).toThrow(ProviderError)
  })

  it('throws a helpful ProviderError for unknown ids', () => {
    const registry = new ProviderRegistry()
    registry.register(stubProvider('alpha'))
    expect(() => registry.get('missing')).toThrow(ProviderError)
    try {
      registry.get('missing')
    } catch (error) {
      expect((error as ProviderError).hint).toContain('alpha')
    }
  })

  it('lists providers in registration order', () => {
    const registry = new ProviderRegistry()
    registry.register(stubProvider('one'))
    registry.register(stubProvider('two'))
    expect(registry.list().map((p) => p.id)).toEqual(['one', 'two'])
  })
})

describe('createDefaultRegistry', () => {
  it('includes the built-in providers', () => {
    const registry = createDefaultRegistry()
    expect(registry.has('openai')).toBe(true)
    expect(registry.has('anthropic')).toBe(true)
    expect(registry.has('gemini')).toBe(true)
  })

  it('provides models metadata for each built-in provider', () => {
    const registry = createDefaultRegistry()
    for (const provider of registry.list()) {
      expect(provider.models.length).toBeGreaterThan(0)
      expect(provider.name.length).toBeGreaterThan(0)
    }
  })
})

describe('provider stubs (Phase 0)', () => {
  const registry = createDefaultRegistry()

  it('generate() is not implemented yet and says so', () => {
    const provider = registry.get('openai')
    expect(() =>
      provider.generate({
        model: 'gpt-5',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    ).toThrow(NotImplementedError)
  })

  it('validates the request before hitting the not-implemented path', () => {
    const provider = registry.get('anthropic')
    expect(() => provider.generate({ model: 'claude-sonnet-4-5', messages: [] })).toThrow(
      ProviderError,
    )
  })

  it('rejects an empty model id', () => {
    const provider = registry.get('gemini')
    expect(() =>
      provider.generate({
        model: '',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    ).toThrow(ProviderError)
  })
})
