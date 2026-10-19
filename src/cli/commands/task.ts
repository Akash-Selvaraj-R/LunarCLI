import type { LunarConfig } from '../../config/schema.js'
import type { Workspace } from '../../domain/types/workspace.js'
import { stdout } from '../output.js'
import { theme } from '../../ui/theme.js'

export interface TaskOptions {
  task: string
  config: LunarConfig
  workspace: Workspace
  version: string
}

/**
 * `lunar "<task>"` — Phase 0 behavior: acknowledge the task and explain
 * that the agent runtime arrives in Phase 1. Nothing is executed.
 *
 * TODO(Phase 1): hand the task to the agent runtime (planning, tool
 * calling, observe/act/verify loop).
 */
export async function runTask(options: TaskOptions): Promise<void> {
  const { task, workspace, version } = options

  stdout('')
  stdout(`${theme.brand('◐')} ${theme.bold('LunarCLI')} ${theme.muted(`v${version}`)}`)
  stdout('')
  stdout(theme.warning('Lunar runtime is coming in Phase 1.'))
  stdout('')
  stdout(`Received task: ${theme.text(task)}`)
  stdout(`Workspace:      ${theme.text(workspace.name)}`)
  stdout('')
  stdout(
    theme.muted('The autonomous agent loop is not implemented yet. See README.md for the roadmap.'),
  )
  stdout('')
}
