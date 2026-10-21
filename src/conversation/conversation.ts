import { appendMessage, createSession } from '../domain/models/session.js'
import type { Message, Session } from '../domain/types/index.js'

/**
 * Conversation history for a session (Phase 1: in-memory only — the
 * session disappears when Lunar exits).
 *
 * Ordering is preserved strictly: every `addMessage` appends to the end,
 * and `getMessages` returns the history in insertion order so the
 * provider always sees `system (context) → user → assistant → …`.
 */
export interface ConversationOptions {
  workspaceRoot: string
  providerId?: string
  modelId?: string
}

export class Conversation {
  private session: Session

  constructor(options: ConversationOptions) {
    this.session = createSession(options)
  }

  /** Stable id of the backing session. */
  get id(): string {
    return this.session.id
  }

  /** Append a message, preserving order. */
  addMessage(message: Message): Message {
    this.session = appendMessage(this.session, message)
    return message
  }

  /** The full history in insertion order. */
  getMessages(): readonly Message[] {
    return this.session.messages
  }

  /** Drop all messages (the session identity is kept). */
  clear(): void {
    this.session = { ...this.session, messages: [] }
  }
}
