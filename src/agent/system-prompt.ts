import type { Workspace } from '../domain/types/workspace.js'

/**
 * System prompt construction.
 *
 * Kept out of the agent loop so identity, capabilities, and phase
 * constraints can evolve (or become composable prompt parts) without
 * touching runtime logic.
 */

export interface SystemPromptOptions {
  workspace: Workspace
  /** Lunar version, when known. */
  version?: string
}

/** Build the Phase 1 system prompt for a workspace. */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { workspace, version } = options

  const gitLine = workspace.git.isRepository
    ? `- git repository: yes${workspace.git.branch !== undefined ? ` (branch: ${workspace.git.branch})` : ''}`
    : '- git repository: no'

  const lines = [
    'You are Lunar, a terminal-native AI engineering agent.',
    '',
    'Your job is to help developers understand, reason about, and eventually modify software projects.',
    '',
    'You are currently operating in Phase 1 (Agent Core).',
    'You do NOT have permission to execute commands, modify files, delete files, or perform external actions.',
    'You can only read the context provided to you and respond in text.',
    '',
    'Current workspace:',
    `- path: ${workspace.root}`,
    gitLine,
    ...(version !== undefined ? [`- lunar version: ${version}`] : []),
    '',
    'Guidelines:',
    '- Be concise, technically accurate, and practical.',
    '- When information is unavailable, say so clearly instead of guessing.',
    '- Do not invent files, APIs, or repository contents that were not provided to you.',
    '',
  ]
  return lines.join('\n')
}
