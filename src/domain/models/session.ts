import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { Message, Session } from '../types/index.js'

/** Zod schema mirroring the `Message` domain type, for runtime validation. */
export const MessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
})

/** Zod schema mirroring the `Session` domain type, for runtime validation. */
export const SessionSchema = z.object({
  id: z.uuid(),
  createdAt: z.number().int().nonnegative(),
  workspaceRoot: z.string().min(1),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  messages: z.array(MessageSchema),
})

/** Create a validated message with a fresh id and timestamp. */
export function createMessage(role: Message['role'], content: string): Message {
  return MessageSchema.parse({ id: randomUUID(), role, content, timestamp: Date.now() })
}

export interface CreateSessionOptions {
  workspaceRoot: string
  providerId?: string
  modelId?: string
}

/** Create a fresh, empty session bound to a workspace. */
export function createSession(options: CreateSessionOptions): Session {
  const session: Session = {
    id: randomUUID(),
    createdAt: Date.now(),
    workspaceRoot: options.workspaceRoot,
    ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
    ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    messages: [],
  }
  return SessionSchema.parse(session)
}

/** Immutably append a message to a session. */
export function appendMessage(session: Session, message: Message): Session {
  return {
    ...session,
    messages: [...session.messages, MessageSchema.parse(message)],
  }
}
