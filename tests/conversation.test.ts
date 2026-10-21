import { describe, expect, it } from 'vitest'

import { Conversation } from '../src/conversation/conversation.js'
import { createMessage } from '../src/domain/models/session.js'

function makeConversation(): Conversation {
  return new Conversation({ workspaceRoot: '/repo', providerId: 'mock', modelId: 'mock-1' })
}

describe('Conversation', () => {
  it('starts empty with a stable session id', () => {
    const conversation = makeConversation()
    expect(conversation.getMessages()).toEqual([])
    const id = conversation.id
    conversation.addMessage(createMessage('user', 'hi'))
    expect(conversation.id).toBe(id)
  })

  it('adds and retrieves messages in order', () => {
    const conversation = makeConversation()
    conversation.addMessage(createMessage('user', 'first'))
    conversation.addMessage(createMessage('assistant', 'second'))
    conversation.addMessage(createMessage('user', 'third'))

    const messages = conversation.getMessages()
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages.map((m) => m.content)).toEqual(['first', 'second', 'third'])
  })

  it('preserves strict ordering across many appends', () => {
    const conversation = makeConversation()
    for (let i = 0; i < 50; i++) {
      conversation.addMessage(createMessage(i % 2 === 0 ? 'user' : 'assistant', `m${i}`))
    }
    const messages = conversation.getMessages()
    expect(messages).toHaveLength(50)
    messages.forEach((message, index) => {
      expect(message.content).toBe(`m${index}`)
    })
  })

  it('assigns unique ids and increasing timestamps', () => {
    const conversation = makeConversation()
    conversation.addMessage(createMessage('user', 'one'))
    conversation.addMessage(createMessage('user', 'two'))
    const [a, b] = conversation.getMessages()
    expect(a?.id).not.toBe(b?.id)
    expect(a!.timestamp).toBeLessThanOrEqual(b!.timestamp)
  })

  it('clears history but keeps the session identity', () => {
    const conversation = makeConversation()
    conversation.addMessage(createMessage('user', 'keep me not'))
    const id = conversation.id
    conversation.clear()
    expect(conversation.getMessages()).toEqual([])
    expect(conversation.id).toBe(id)

    // Usable again after clearing.
    conversation.addMessage(createMessage('user', 'again'))
    expect(conversation.getMessages()).toHaveLength(1)
  })

  it('rejects malformed messages at the domain boundary', () => {
    const conversation = makeConversation()
    expect(() =>
      conversation.addMessage({ id: 'nope', role: 'user', content: 'x', timestamp: 0 }),
    ).toThrow()
    expect(conversation.getMessages()).toHaveLength(0)
  })
})
