import { createMessage } from '../domain/models/session.js'
import type { Message } from '../domain/types/index.js'
import type { Workspace } from '../domain/types/workspace.js'
import type { Conversation } from '../conversation/conversation.js'

/**
 * Context assembly — everything the provider receives for one turn.
 *
 * Separated from the agent so prompt/context policy can change without
 * touching the loop, and so context is unit-testable in isolation.
 *
 * Phase 1 includes only information that actually exists: system
 * instructions, workspace identity, and conversation history. Tool
 * definitions and model metadata are attached here in later phases.
 */
export interface AgentContext {
  readonly systemPrompt: string
  readonly messages: readonly Message[]
  readonly workspace: Workspace
}

export interface BuildContextOptions {
  conversation: Conversation
  workspace: Workspace
  systemPrompt: string
}

/** Assemble the context for the next model call. */
export function buildAgentContext(options: BuildContextOptions): AgentContext {
  return {
    systemPrompt: options.systemPrompt,
    messages: options.conversation.getMessages(),
    workspace: options.workspace,
  }
}

/**
 * Flatten a context into the message list handed to the provider:
 * the system prompt first, then the conversation in order.
 */
export function contextToMessages(context: AgentContext): Message[] {
  return [createMessage('system', context.systemPrompt), ...context.messages]
}
