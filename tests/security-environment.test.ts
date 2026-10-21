import { afterEach, describe, expect, it } from 'vitest'

import { filterEnvironment } from '../src/security/environment.js'

/**
 * Environment isolation (Phase 4 security matrix): engineering commands
 * inherit an allowlist, not the parent environment. Secrets — including
 * Lunar's own provider credentials — are structurally absent.
 */

const saved = new Map<string, string | undefined>()

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

function setEnv(key: string, value: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key])
  process.env[key] = value
}

describe('filterEnvironment — allowlist filtering', () => {
  it('preserves the variables toolchains legitimately need', () => {
    const { env } = filterEnvironment({ PATH: '/usr/bin', HOME: '/home/dev', LANG: 'en_US' })
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/home/dev')
    expect(env['LANG']).toBe('en_US')
  })

  it('drops API keys, tokens, and cloud credentials by default', () => {
    const { env } = filterEnvironment({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-secret',
      ANTHROPIC_API_KEY: 'sk-secret2',
      GITHUB_TOKEN: 'ghp_secret',
      GH_TOKEN: 'ghp_secret',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_SESSION_TOKEN: 'aws-session',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json',
      AZURE_CLIENT_SECRET: 'az-secret',
      SSH_AUTH_SOCK: '/tmp/ssh',
      STRIPE_SECRET_KEY: 'sk_live',
      RANDOM_CI_TOKEN: 'ci-secret',
    })
    expect(env['OPENAI_API_KEY']).toBeUndefined()
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['GH_TOKEN']).toBeUndefined()
    expect(env['AWS_ACCESS_KEY_ID']).toBeUndefined()
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(env['AWS_SESSION_TOKEN']).toBeUndefined()
    expect(env['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined()
    expect(env['AZURE_CLIENT_SECRET']).toBeUndefined()
    expect(env['SSH_AUTH_SOCK']).toBeUndefined()
    expect(env['STRIPE_SECRET_KEY']).toBeUndefined()
    expect(env['RANDOM_CI_TOKEN']).toBeUndefined()
    expect(env['PATH']).toBe('/usr/bin')
  })

  it('never passes Lunar’s own provider credentials through', () => {
    setEnv('LUNAR_API_KEY', 'lunar-secret-key')
    setEnv('LUNAR_PROVIDER', 'openai')
    const { env } = filterEnvironment(process.env)
    expect(env['LUNAR_API_KEY']).toBeUndefined()
    expect(env['LUNAR_PROVIDER']).toBeUndefined()
  })

  it('drops unlisted variables even when they do not look secret', () => {
    // Conservative: not on the allowlist means not passed — an unknown
    // CI variable is filtered BY DEFAULT, not leaked by omission from a
    // blocklist.
    const { env } = filterEnvironment({ PATH: '/usr/bin', SOME_INTERNAL_VAR: 'x' })
    expect(env['SOME_INTERNAL_VAR']).toBeUndefined()
  })

  it('reports removed sensitive NAMES (never values) for the audit trail', () => {
    const { removedSensitive, removedCount } = filterEnvironment({
      PATH: '/usr/bin',
      MY_API_KEY: 'value-that-must-not-appear',
      HARMLESS: 'x',
    })
    expect(removedSensitive).toContain('MY_API_KEY')
    expect(removedCount).toBe(2)
    expect(JSON.stringify({ removedSensitive })).not.toContain('value-that-must-not-appear')
  })
})
