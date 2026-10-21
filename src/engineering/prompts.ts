import type { Workspace } from '../domain/types/workspace.js'
import type { EngineeringPlan } from './plan.js'

/**
 * Prompts for the engineering loop phases (Phase 3).
 *
 * Every phase demands STRICT JSON output; `parseModelJson` validates
 * it regardless. Prompts never ask the model to run commands or write
 * files directly — it proposes structured changes and Lunar decides.
 */

export interface EngineeringPromptOptions {
  workspace: Workspace
  /** Names of the read-only tools available during research. */
  toolNames: readonly string[]
  version?: string
}

/** System prompt shared by every phase of one engineering task. */
export function engineeringSystemPrompt(options: EngineeringPromptOptions): string {
  const { workspace, toolNames, version } = options
  const lines = [
    'You are Lunar, a terminal-native AI engineering agent operating in its',
    'autonomous engineering loop. You help implement small, well-scoped changes.',
    '',
    'Hard boundaries (never attempt to work around them):',
    '- You cannot execute commands. You may only propose file changes.',
    '- You cannot write files directly. You propose structured JSON changes;',
    '  Lunar validates them, asks the user for approval, then applies them.',
    '- You cannot commit, push, install packages, or access the network.',
    '- Use your read-only tools to inspect the project before proposing changes.',
    '',
    'Current workspace:',
    `- path: ${workspace.root}`,
    workspace.git.isRepository
      ? `- git repository: yes${workspace.git.branch !== undefined ? ` (branch: ${workspace.git.branch})` : ''}`
      : '- git repository: no',
    ...(version !== undefined ? [`- lunar version: ${version}`] : []),
    '',
    'Read-only tools:',
    ...toolNames.map((name) => `- ${name}`),
    '',
    'When a prompt asks for a JSON response, reply with ONLY that JSON object:',
    'no prose before or after it, no markdown fences, no comments.',
    '',
  ]
  return lines.join('\n')
}

/** Ask the model for a structured plan. */
export function planPrompt(task: string): string {
  return [
    `The user's engineering task is:`,
    task,
    '',
    'Produce a concise engineering plan for this task as a JSON object:',
    '{',
    '  "goal": string,        // one-sentence restatement of the task',
    '  "steps": [             // ordered, individually actionable',
    '    {',
    '      "id": string,      // short unique id, e.g. "inspect-routing"',
    '      "description": string,',
    '      "rationale": string, // why this step is needed',
    '      "tools": string[]    // read-only tools this step may use',
    '    }',
    '  ]',
    '}',
    'Include steps for inspecting the relevant code, implementing the change,',
    'and verifying it (running the existing tests). Reply with ONLY the JSON.',
  ].join('\n')
}

export interface ProposalPromptOptions {
  task: string
  plan: EngineeringPlan
  /** 1-based attempt number. */
  iteration: number
  /** Serialized verification failure from the previous attempt. */
  failure?: string
}

/** Ask the model for a structured change proposal (optionally with a diagnosis). */
export function proposalPrompt(options: ProposalPromptOptions): string {
  const { task, plan, iteration, failure } = options
  const planText = plan.steps
    .map((step, index) => `${index + 1}. ${step.description}`)
    .join('\n')
  const lines: string[] = []

  if (iteration === 1) {
    lines.push(`Task: ${task}`)
    lines.push('')
    lines.push('Plan:')
    lines.push(planText)
    lines.push('')
    lines.push(
      'Use your read-only tools to inspect whatever you need, then propose the',
      'file changes that implement this task. Reply with ONLY this JSON object:',
      '{',
      '  "summary": string,      // what this proposal does and why',
      '  "changes": [',
      '    {',
      '      "path": string,      // workspace-relative path',
      '      "operation": "create" | "update" | "delete",',
      '      "content": string,   // COMPLETE new file content (create/update)',
      '      "oldContent": string,// optional: expected current content (update)',
      '      "reason": string',
      '    }',
      '  ]',
      '}',
    )
  } else {
    lines.push(`Task (attempt ${iteration}): ${task}`)
    lines.push('')
    lines.push('The previous attempt did NOT succeed.')
    lines.push('')
    lines.push('Failure output:')
    lines.push(failure ?? '(no output captured)')
    lines.push('')
    lines.push(
      'Diagnose the failure (you may re-inspect files with your read-only tools),',
      'then reply with ONLY this JSON object containing the diagnosis and the fix:',
      '{',
      '  "diagnosis": string,    // root cause of the verification failure',
      '  "summary": string,      // what this corrective proposal does',
      '  "changes": [',
      '    {',
      '      "path": string,',
      '      "operation": "create" | "update" | "delete",',
      '      "content": string,   // COMPLETE new file content',
      '      "oldContent": string,// expected current content (update)',
      '      "reason": string',
      '    }',
      '  ]',
      '}',
    )
  }
  return lines.join('\n')
}

/** Correction prompt when a phase response was not valid JSON. */
export function correctionPrompt(phase: string, error: string): string {
  return [
    `Your previous reply was not usable as the ${phase}:`,
    error,
    '',
    'Reply again with ONLY the JSON object described in the previous message.',
  ].join('\n')
}
