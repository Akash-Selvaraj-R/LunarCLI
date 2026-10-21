import { render } from 'ink'

import { App } from '../../app/app.js'
import type { Agent } from '../../agent/agent.js'
import type { LunarConfig } from '../../config/schema.js'
import type { Workspace } from '../../domain/types/workspace.js'
import type { Logger } from '../../logging/logger.js'

export interface InteractiveOptions {
  config: LunarConfig
  workspace: Workspace
  version: string
  logger: Logger
  /** Configured agent runtime (provider resolved before launch). */
  agent: Agent
}

/**
 * Launch the interactive terminal UI and wait for the user to exit
 * (Ctrl+D, or Ctrl+C at an idle prompt). In non-TTY environments the UI
 * is rendered once and the process exits so pipelines never hang.
 */
export async function runInteractive(options: InteractiveOptions): Promise<void> {
  const { config, workspace, version, logger, agent } = options

  logger.debug('Launching interactive UI', {
    root: workspace.root,
    provider: agent.providerId,
    model: agent.modelId,
  })

  const instance = render(
    <App config={config} workspace={workspace} version={version} logger={logger} agent={agent} />,
    // Ctrl+C is handled inside the app so it can cancel an in-flight
    // request before quitting; Ctrl+D exits at any time.
    { exitOnCtrlC: false },
  )

  if (process.stdin.isTTY !== true) {
    logger.warn('stdin is not a TTY — interactive input is disabled')
    await instance.waitUntilRenderFlush()
    instance.unmount()
  }

  await instance.waitUntilExit()
}
