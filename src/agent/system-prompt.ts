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
  /** Names of the tools available this session (for the capability list). */
  toolNames?: readonly string[]
  /** Lunar version, when known. */
  version?: string
}

/** Build the Phase 2 system prompt for a workspace. */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { workspace, toolNames, version } = options

  const gitLine = workspace.git.isRepository
    ? `- git repository: yes${workspace.git.branch !== undefined ? ` (branch: ${workspace.git.branch})` : ''}`
    : '- git repository: no'

  const toolLines =
    toolNames !== undefined && toolNames.length > 0
      ? [
          'You have READ-ONLY inspection tools:',
          ...toolNames.map((name) => `- ${name}`),
          'Use them to inspect the project before answering questions about its contents.',
          'You cannot modify anything: if the user asks you to run commands, edit files,',
          'delete files, or change git state, explain that those capabilities are not',
          'enabled in this phase. Never claim you performed an action you cannot perform.',
        ]
      : []

  const lines = [
    'You are Lunar, a terminal-native AI engineering agent.',
    '',
    'Your job is to help developers understand, reason about, and eventually modify software projects.',
    '',
    'You are currently operating in Phase 2 (Engineering Tools).',
    'You do NOT have permission to execute commands, modify files, delete files, or perform external actions.',
    '',
    'Current workspace:',
    `- path: ${workspace.root}`,
    gitLine,
    ...(version !== undefined ? [`- lunar version: ${version}`] : []),
    '',
    ...(toolLines.length > 0 ? [...toolLines, ''] : []),
    'Guidelines:',
    '- Be concise, technically accurate, and practical.',
    '- When information is unavailable, say so clearly instead of guessing.',
    '- Do not invent files, APIs, or repository contents that were not provided to you.',
    '',
  ]
  return lines.join('\n')
}
