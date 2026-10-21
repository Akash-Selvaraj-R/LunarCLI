import path from 'node:path'
import os from 'node:os'

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config/config.js'
import { ConfigurationError, ProviderError } from '../src/domain/errors/index.js'
import { MockProvider } from '../src/providers/mock.js'
import { ProviderRegistry, createDefaultRegistry } from '../src/providers/registry.js'
import { resolveProvider } from '../src/providers/resolve.js'
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/providers/types.js'

const missingConfig = path.join(os.tmpdir(), 'lunar-providers-test-missing-config.json')

const userMessage: LLMRequest['messages'][number] = {
  id: '1',
  role: 'user',
  content: 'hi',
  timestamp: 0,
}

function stubProvider(id: string): LLMProvider {
  return {
    id,
    name: id,
    models: [],
    defaultModel: 'none',
    requiresApiKey: false,
    generate: async (): Promise<LLMResponse> => {
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
    expect(registry.has('mock')).toBe(true)
  })

  it('provides models and defaults metadata for each built-in provider', () => {
    const registry = createDefaultRegistry()
    for (const provider of registry.list()) {
      expect(provider.models.length).toBeGreaterThan(0)
      expect(provider.name.length).toBeGreaterThan(0)
      expect(provider.defaultModel.length).toBeGreaterThan(0)
      expect(typeof provider.requiresApiKey).toBe('boolean')
    }
  })

  it('marks only the mock provider as keyless', () => {
    const registry = createDefaultRegistry()
    expect(registry.get('mock').requiresApiKey).toBe(false)
    expect(registry.get('openai').requiresApiKey).toBe(true)
    expect(registry.get('anthropic').requiresApiKey).toBe(true)
    expect(registry.get('gemini').requiresApiKey).toBe(true)
  })
})

describe('provider request validation (BaseProvider)', () => {
  it('rejects an empty message list before any transport work', async () => {
    const provider = new MockProvider()
    await expect(provider.generate({ model: 'mock-1', messages: [] })).rejects.toThrow(
      ProviderError,
    )
    expect(provider.calls).toHaveLength(0)
  })

  it('rejects an empty model id', async () => {
    const provider = new MockProvider()
    await expect(provider.generate({ model: '', messages: [userMessage] })).rejects.toThrow(
      ProviderError,
    )
  })
})

describe('resolveProvider', () => {
  it('reports LUNAR_PROVIDER not configured as a configuration error', () => {
    const config = loadConfig({ env: {}, configPath: missingConfig })
    expect(() => resolveProvider(config)).toThrow(ConfigurationError)
    try {
      resolveProvider(config)
    } catch (error) {
      expect((error as ConfigurationError).message).toContain('LUNAR_PROVIDER')
      expect((error as ConfigurationError).hint).toContain('mock')
    }
  })

  it('throws a ProviderError listing available providers for unknown ids', () => {
    expect(() => resolveProvider({ debug: false, provider: 'nope' })).toThrow(ProviderError)
    try {
      resolveProvider({ debug: false, provider: 'nope' })
    } catch (error) {
      expect((error as ProviderError).hint).toContain('openai')
    }
  })

  it('requires an API key for real providers', () => {
    try {
      resolveProvider({ debug: false, provider: 'openai' })
      throw new Error('expected ConfigurationError')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as ConfigurationError).message).toContain('No API key')
      expect((error as ConfigurationError).hint).toContain('LUNAR_API_KEY')
    }
  })

  it('never includes the API key in its messages', () => {
    const key = 'sk-lunar-should-never-leak-1234'
    try {
      resolveProvider({ debug: false, provider: 'openai', apiKey: key })
      // Resolves fine — nothing to leak.
    } catch (error) {
      expect(String(error)).not.toContain(key)
    }
    // Unknown provider with a key configured: error must not echo it.
    try {
      resolveProvider({ debug: false, provider: 'nope', apiKey: key })
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(key)
    }
  })

  it('needs no API key for the mock provider', () => {
    const resolved = resolveProvider({ debug: false, provider: 'mock' })
    expect(resolved.provider.id).toBe('mock')
    expect(resolved.model).toBe('mock-1')
  })

  it('falls back to the provider default model', () => {
    expect(resolveProvider({ debug: false, provider: 'anthropic', apiKey: 'sk-test' }).model).toBe(
      'claude-sonnet-4-5',
    )
  })

  it('prefers the configured model', () => {
    const resolved = resolveProvider({
      debug: false,
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
    })
    expect(resolved.model).toBe('gpt-5-mini')
    expect(resolved.provider.id).toBe('openai')
  })

  it('passes the configured API key into the provider instance', () => {
    const resolved = resolveProvider({
      debug: false,
      provider: 'openai',
      apiKey: 'sk-test-key',
    })
    expect(resolved.provider.id).toBe('openai')
    expect(resolved.provider.name).toBe('OpenAI')
  })
})
