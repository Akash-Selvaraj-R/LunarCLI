import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { describeConfig, loadConfig } from '../src/config/config.js'
import { validateConfig } from '../src/config/schema.js'
import { ConfigurationError } from '../src/domain/errors/index.js'

const missingConfig = path.join(os.tmpdir(), 'lunar-test-missing-config.json')
const tempFiles: string[] = []

function writeConfigFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-config-test-'))
  tempFiles.push(dir)
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, content)
  return file
}

afterEach(() => {
  while (tempFiles.length > 0) {
    fs.rmSync(tempFiles.pop()!, { recursive: true, force: true })
  }
})

describe('loadConfig precedence', () => {
  it('applies defaults when nothing is configured', () => {
    const config = loadConfig({ env: {}, configPath: missingConfig })
    expect(config).toEqual({ debug: false })
  })

  it('reads LUNAR_* environment variables', () => {
    const config = loadConfig({
      env: {
        LUNAR_PROVIDER: 'openai',
        LUNAR_MODEL: 'gpt-5',
        LUNAR_API_KEY: 'sk-test',
        LUNAR_DEBUG: 'true',
      },
      configPath: missingConfig,
    })
    expect(config).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-test',
      debug: true,
    })
  })

  it('CLI arguments override environment variables', () => {
    const config = loadConfig({
      env: { LUNAR_PROVIDER: 'anthropic', LUNAR_DEBUG: 'true' },
      cli: { provider: 'openai' },
      configPath: missingConfig,
    })
    expect(config.provider).toBe('openai')
    // debug is not overridden by CLI, so the env value survives.
    expect(config.debug).toBe(true)
  })

  it('an absent CLI debug flag does not clobber LUNAR_DEBUG', () => {
    const config = loadConfig({
      env: { LUNAR_DEBUG: '1' },
      cli: {},
      configPath: missingConfig,
    })
    expect(config.debug).toBe(true)
  })

  it('environment variables override the configuration file', () => {
    const configPath = writeConfigFile(
      JSON.stringify({ provider: 'gemini', model: 'gemini-3-pro' }),
    )
    const config = loadConfig({
      env: { LUNAR_PROVIDER: 'openai' },
      configPath,
    })
    expect(config.provider).toBe('openai')
    expect(config.model).toBe('gemini-3-pro')
  })

  it('the configuration file overrides defaults', () => {
    const configPath = writeConfigFile(JSON.stringify({ debug: true, provider: 'anthropic' }))
    const config = loadConfig({ env: {}, configPath })
    expect(config).toEqual({ debug: true, provider: 'anthropic' })
  })

  it('CLI arguments override the configuration file', () => {
    const configPath = writeConfigFile(JSON.stringify({ provider: 'gemini' }))
    const config = loadConfig({ env: {}, cli: { provider: 'openai' }, configPath })
    expect(config.provider).toBe('openai')
  })
})

describe('loadConfig validation', () => {
  it('throws ConfigurationError on invalid JSON in the config file', () => {
    const configPath = writeConfigFile('{not json')
    expect(() => loadConfig({ env: {}, configPath })).toThrow(ConfigurationError)
  })

  it('throws ConfigurationError when the config file is not an object', () => {
    const configPath = writeConfigFile('[1, 2, 3]')
    expect(() => loadConfig({ env: {}, configPath })).toThrow(ConfigurationError)
  })

  it('throws ConfigurationError on an unparseable LUNAR_DEBUG value', () => {
    expect(() => loadConfig({ env: { LUNAR_DEBUG: 'maybe' }, configPath: missingConfig })).toThrow(
      ConfigurationError,
    )
  })

  it('throws ConfigurationError when values fail the schema', () => {
    const configPath = writeConfigFile(JSON.stringify({ provider: '' }))
    expect(() => loadConfig({ env: {}, configPath })).toThrow(ConfigurationError)
  })

  it('accepts standard boolean spellings for LUNAR_DEBUG', () => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      expect(loadConfig({ env: { LUNAR_DEBUG: value }, configPath: missingConfig }).debug).toBe(
        true,
      )
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(loadConfig({ env: { LUNAR_DEBUG: value }, configPath: missingConfig }).debug).toBe(
        false,
      )
    }
  })
})

describe('validateConfig', () => {
  it('rejects unknown-shaped input at the type boundary', () => {
    expect(() => validateConfig({ debug: 'yes' })).toThrow(ConfigurationError)
    expect(() => validateConfig(null)).toThrow(ConfigurationError)
  })
})

describe('describeConfig (secret redaction)', () => {
  it('never exposes the API key', () => {
    const config = loadConfig({
      env: { LUNAR_API_KEY: 'sk-super-secret' },
      configPath: missingConfig,
    })
    const described = describeConfig(config)
    expect(described['apiKey']).toBe('[redacted]')
    expect(JSON.stringify(described)).not.toContain('sk-super-secret')
  })
})
