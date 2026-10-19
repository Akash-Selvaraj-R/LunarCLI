import { describe, expect, it } from 'vitest'

import {
  CLIError,
  ConfigurationError,
  LunarError,
  NotImplementedError,
  ProviderError,
  WorkspaceError,
} from '../src/domain/errors/index.js'
import { appendMessage, createSession } from '../src/domain/models/session.js'
import { createTask, withTaskStatus } from '../src/domain/models/task.js'
import type { Message } from '../src/domain/types/index.js'
import { errorMessage, redactSecrets } from '../src/utils/redact.js'

describe('error hierarchy', () => {
  it('every error is a LunarError with a stable code', () => {
    const cases: Array<[LunarError, string]> = [
      [new CLIError('a'), 'CLI_ERROR'],
      [new ConfigurationError('b'), 'CONFIGURATION_ERROR'],
      [new ProviderError('c'), 'PROVIDER_ERROR'],
      [new WorkspaceError('d'), 'WORKSPACE_ERROR'],
      [new NotImplementedError('e'), 'NOT_IMPLEMENTED'],
    ]
    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(LunarError)
      expect(error).toBeInstanceOf(Error)
      expect(error.code).toBe(code)
      expect(error.name).toBe(error.constructor.name)
    }
  })

  it('carries hints and details', () => {
    const error = new ConfigurationError('bad', { hint: 'fix it', details: { field: 'debug' } })
    expect(error.hint).toBe('fix it')
    expect(error.details).toEqual({ field: 'debug' })
  })

  it('preserves the cause chain', () => {
    const cause = new Error('root cause')
    const error = new WorkspaceError('wrapped', { cause })
    expect(error.cause).toBe(cause)
  })
})

describe('task model', () => {
  it('creates a pending task', () => {
    const task = createTask('fix the bug')
    expect(task.prompt).toBe('fix the bug')
    expect(task.status).toBe('pending')
    expect(task.updatedAt).toBe(task.createdAt)
  })

  it('transitions status immutably', () => {
    const task = createTask('ship it')
    const inProgress = withTaskStatus(task, 'in_progress')
    expect(task.status).toBe('pending')
    expect(inProgress.status).toBe('in_progress')
  })

  it('rejects an empty prompt at creation', () => {
    expect(() => createTask('')).toThrow()
  })
})

describe('session model', () => {
  it('creates an empty session bound to a workspace', () => {
    const session = createSession({ workspaceRoot: '/repo', providerId: 'openai' })
    expect(session.messages).toEqual([])
    expect(session.workspaceRoot).toBe('/repo')
    expect(session.providerId).toBe('openai')
  })

  it('appends messages immutably', () => {
    const session = createSession({ workspaceRoot: '/repo' })
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    }
    const updated = appendMessage(session, message)
    expect(session.messages).toHaveLength(0)
    expect(updated.messages).toHaveLength(1)
    expect(updated.messages[0]).toEqual(message)
  })

  it('rejects invalid messages', () => {
    const session = createSession({ workspaceRoot: '/repo' })
    expect(() =>
      appendMessage(session, { id: 'not-a-uuid', role: 'user', content: 'x', timestamp: 0 }),
    ).toThrow()
  })
})

describe('redaction utilities', () => {
  it('masks secret-looking keys at any depth', () => {
    const input = {
      provider: 'openai',
      apiKey: 'sk-secret',
      nested: { AUTH_TOKEN: 'tok', keep: 'visible' },
      list: [{ password: 'hunter2' }],
    }
    const result = redactSecrets(input) as Record<string, unknown>
    expect(result['apiKey']).toBe('[redacted]')
    expect(JSON.stringify(result)).not.toContain('sk-secret')
    expect(JSON.stringify(result)).not.toContain('tok')
    expect(JSON.stringify(result)).not.toContain('hunter2')
    expect(result['provider']).toBe('openai')
    expect((result['nested'] as Record<string, unknown>)['keep']).toBe('visible')
  })

  it('errorMessage handles Errors and non-Errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })
})
