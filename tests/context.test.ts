import { describe, expect, it } from 'vitest'

import { buildAgentContext, contextToMessages } from '../src/agent/context.js'
import { buildSystemPrompt } from '../src/agent/system-prompt.js'
import { createMessage } from '../src/domain/models/session.js'
import { Conversation } from '../src/conversation/conversation.js'
import type { Workspace } from '../src/domain/types/workspace.js'

const repoWorkspace: Workspace = {
  cwd: '/repo',
  root: '/repo',
  name: '~/repo',
  git: { isRepository: true, root: '/repo', branch: 'main' },
}

const plainWorkspace: Workspace = {
  cwd: '/scratch',
  root: '/scratch',
  name: '/scratch',
  git: { isRepository: false },
}

describe('buildSystemPrompt', () => {
  it('establishes Lunar identity and Phase 2 constraints', () => {
    const prompt = buildSystemPrompt({ workspace: repoWorkspace })
    expect(prompt).toContain('You are Lunar, a terminal-native AI engineering agent.')
    expect(prompt).toContain('Phase 2')
    expect(prompt).toContain('do NOT have permission to execute commands')
    expect(prompt).toContain('modify files')
    expect(prompt).toContain('say so clearly')
  })

  it('advertises the available tools and the read-only promise', () => {
    const prompt = buildSystemPrompt({
      workspace: repoWorkspace,
      toolNames: ['list_directory', 'read_file'],
    })
    expect(prompt).toContain('READ-ONLY inspection tools')
    expect(prompt).toContain('list_directory')
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('Never claim you performed an action you cannot perform')
  })

  it('mentions no tools when none are available', () => {
    const prompt = buildSystemPrompt({ workspace: repoWorkspace })
    expect(prompt).not.toContain('READ-ONLY inspection tools')
  })

  it('includes real workspace metadata only', () => {
    const prompt = buildSystemPrompt({ workspace: repoWorkspace })
    expect(prompt).toContain('- path: /repo')
    expect(prompt).toContain('branch: main')
    // Phase 1 knows nothing else about the repo — no invented files.
    expect(prompt).not.toContain('package.json')
    expect(prompt).not.toContain('src/')
  })

  it('reports non-git workspaces honestly', () => {
    const prompt = buildSystemPrompt({ workspace: plainWorkspace })
    expect(prompt).toContain('- path: /scratch')
    expect(prompt).toContain('- git repository: no')
    expect(prompt).not.toContain('branch:')
  })

  it('includes the version only when provided', () => {
    expect(buildSystemPrompt({ workspace: repoWorkspace })).not.toContain('lunar version')
    expect(buildSystemPrompt({ workspace: repoWorkspace, version: '0.2.0' })).toContain(
      'lunar version: 0.2.0',
    )
  })

  it('is deterministic for the same inputs', () => {
    const a = buildSystemPrompt({ workspace: repoWorkspace })
    const b = buildSystemPrompt({ workspace: repoWorkspace })
    expect(a).toBe(b)
  })
})

describe('buildAgentContext', () => {
  it('carries system prompt, conversation messages, and workspace', () => {
    const conversation = new Conversation({ workspaceRoot: '/repo' })
    conversation.addMessage(createMessage('user', 'hello'))

    const context = buildAgentContext({
      conversation,
      workspace: repoWorkspace,
      systemPrompt: 'PROMPT',
    })

    expect(context.systemPrompt).toBe('PROMPT')
    expect(context.workspace).toBe(repoWorkspace)
    expect(context.messages).toHaveLength(1)
    expect(context.messages[0]?.content).toBe('hello')
  })

  it('captures history at assembly time; rebuilding picks up new messages', () => {
    const conversation = new Conversation({ workspaceRoot: '/repo' })
    const build = () =>
      buildAgentContext({
        conversation,
        workspace: repoWorkspace,
        systemPrompt: 'PROMPT',
      })

    const before = build()
    expect(before.messages).toHaveLength(0)

    conversation.addMessage(createMessage('user', 'later'))
    expect(before.messages).toHaveLength(0) // snapshot semantics
    expect(build().messages).toHaveLength(1) // fresh assembly sees it
  })
})

describe('contextToMessages', () => {
  it('puts the system prompt first, then history in order', () => {
    const conversation = new Conversation({ workspaceRoot: '/repo' })
    conversation.addMessage(createMessage('user', 'q1'))
    conversation.addMessage(createMessage('assistant', 'a1'))
    conversation.addMessage(createMessage('user', 'q2'))

    const context = buildAgentContext({
      conversation,
      workspace: repoWorkspace,
      systemPrompt: 'SYSTEM TEXT',
    })
    const messages = contextToMessages(context)

    expect(messages).toHaveLength(4)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toBe('SYSTEM TEXT')
    expect(messages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages.map((m) => m.content)).toEqual(['SYSTEM TEXT', 'q1', 'a1', 'q2'])
  })

  it('does not persist the system message into conversation history', () => {
    const conversation = new Conversation({ workspaceRoot: '/repo' })
    conversation.addMessage(createMessage('user', 'q1'))
    const context = buildAgentContext({
      conversation,
      workspace: repoWorkspace,
      systemPrompt: 'SYSTEM TEXT',
    })
    contextToMessages(context)
    expect(conversation.getMessages().every((m) => m.role !== 'system')).toBe(true)
  })
})
