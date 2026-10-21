import process from 'node:process'

import type { Agent } from '../../agent/agent.js'
import type { LunarConfig } from '../../config/schema.js'
import type { Workspace } from '../../domain/types/workspace.js'
import type { Logger } from '../../logging/logger.js'
import { clearLine, printError, stdout, stdoutChunk } from '../output.js'
import { infoRow } from '../../ui/styles.js'
import { theme } from '../../ui/theme.js'

export interface TaskOptions {
  task: string
  config: LunarConfig
  workspace: Workspace
  version: string
  logger: Logger
  /** Configured agent runtime (provider resolved before launch). */
  agent: Agent
}

/**
 * `lunar "<task>"` — one-shot mode: send the task to the agent and
 * print the response, streaming it when the provider supports streaming.
 * Nothing is executed on the machine.
 */
export async function runTask(options: TaskOptions): Promise<void> {
  const { task, workspace, version, logger, agent } = options
  logger.debug('One-shot task received', { characters: task.length })

  stdout('')
  stdout(`${theme.brand('◐')} ${theme.bold('LUNARCLI')} ${theme.muted(`v${version}`)}`)
  stdout('')
  stdout(infoRow('workspace', theme.text(workspace.name)))
  if (workspace.git.isRepository && workspace.git.branch !== undefined) {
    stdout(infoRow('branch', theme.text(workspace.git.branch)))
  }
  stdout(infoRow('provider', theme.text(agent.providerId)))
  stdout(infoRow('model', theme.text(agent.modelId)))
  stdout('')

  stdout(`${theme.brand('◐')} ${theme.muted('thinking...')}`)

  // Ctrl+C during generation cancels the request instead of crashing.
  const controller = new AbortController()
  const onSigint = (): void => controller.abort()
  process.on('SIGINT', onSigint)

  let firstDelta = true
  const clearThinking = (): void => {
    if (!firstDelta) return
    firstDelta = false
    // Replace the "thinking..." line with real activity.
    if (process.stdout.isTTY === true) clearLine()
    else stdout('')
  }
  const result = await agent.run(task, {
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'tool_call') {
        // Compact tool activity: one line per call, args dimmed.
        clearThinking()
        stdout(`${theme.accent('◇')} ${event.name}`)
        const args = Object.entries(event.arguments)
          .filter(([, value]) => value !== undefined)
          .slice(0, 3)
          .map(
            ([key, value]) =>
              `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
          )
        if (args.length > 0) stdout(theme.muted(`  ${args.join('  ')}`))
        return
      }
      if (event.type === 'tool_result') {
        const prefix = event.success ? theme.success('✓') : theme.error('✗')
        stdout(`${prefix} ${theme.muted(event.summary)}`)
        return
      }
      if (event.type === 'delta') {
        clearThinking()
        stdoutChunk(event.text)
        return
      }
      // Providers without streaming deliver the whole text at once.
      if (event.type === 'response' && firstDelta) {
        clearThinking()
        stdoutChunk(event.text)
      }
    },
  })
  process.off('SIGINT', onSigint)

  // Finish whatever line is currently on screen.
  if (firstDelta)
    clearLine() // only the "thinking..." line remains
  else stdout('') // close the streamed answer line
  stdout('')

  if (result.status === 'cancelled') {
    stdout(theme.warning('^C'))
    stdout(theme.muted('Request cancelled.'))
    stdout('')
    return
  }

  if (result.status === 'error' && result.error !== undefined) {
    printError(result.error.message, result.error.hint)
    process.exitCode = 1
    return
  }

  if (options.config.debug && result.usage !== undefined) {
    stdout(
      theme.muted(
        `tokens      input ${result.usage.inputTokens} · output ${result.usage.outputTokens} · total ${result.usage.totalTokens}`,
      ),
    )
    stdout('')
  }
}
