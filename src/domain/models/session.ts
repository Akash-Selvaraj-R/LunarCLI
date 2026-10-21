import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { Message, Session, ToolCall } from '../types/index.js'

/** Zod schema mirroring the `Message` domain type, for runtime validation. */
export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
})

export const MessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
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

/** Extra fields carried by assistant messages that requested tools. */
export interface AssistantMessageExtras {
  toolCalls?: readonly ToolCall[]
}

/** Extra fields carried by tool messages reporting a call result. */
export interface ToolMessageExtras {
  toolCallId?: string
  toolName?: string
}

/** Create a validated message with a fresh id and timestamp. */
export function createMessage(
  role: Message['role'],
  content: string,
  extras: AssistantMessageExtras & ToolMessageExtras = {},
): Message {
  return MessageSchema.parse({
    id: randomUUID(),
    role,
    content,
    timestamp: Date.now(),
    ...(extras.toolCalls !== undefined ? { toolCalls: extras.toolCalls } : {}),
    ...(extras.toolCallId !== undefined ? { toolCallId: extras.toolCallId } : {}),
    ...(extras.toolName !== undefined ? { toolName: extras.toolName } : {}),
  })
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
