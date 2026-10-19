#!/usr/bin/env node
/**
 * LunarCLI entry point.
 *
 * Responsibilities: read the version, wire real handlers into the
 * program, and translate any thrown error into a clean human-readable
 * report. All actual behavior lives in the command modules.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { describeConfig, loadConfig } from '../config/config.js'
import { LunarError } from '../domain/errors/index.js'
import { createLogger } from '../logging/logger.js'
import { detectWorkspace } from '../workspace/detector.js'
import { printError } from './output.js'
import { buildProgram } from './program.js'
import { runDoctor } from './commands/doctor.js'
import { runInteractive } from './commands/interactive.js'
import { runTask } from './commands/task.js'

/** Read the package version relative to this file (works in src/ and dist/). */
function readVersion(): string {
  const packagePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'package.json',
  )
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string }
  return pkg.version ?? '0.0.0'
}

async function main(): Promise<void> {
  const version = readVersion()

  const program = buildProgram(version, {
    run: async ({ debug, cwd, task }) => {
      const config = loadConfig({ cli: { ...(debug ? { debug: true } : {}) } })
      const logger = createLogger({ level: config.debug ? 'debug' : 'info' })
      const workspace = detectWorkspace(cwd)

      logger.debug('Configuration loaded', { config: describeConfig(config) })
      logger.debug('Workspace detected', { root: workspace.root, git: workspace.git })

      if (task !== undefined) {
        await runTask({ task, config, workspace, version })
      } else {
        await runInteractive({ config, workspace, version, logger })
      }
    },
    doctor: async ({ debug, cwd }) => {
      const config = loadConfig({ cli: { ...(debug ? { debug: true } : {}) } })
      const logger = createLogger({ level: config.debug ? 'debug' : 'info' })
      await runDoctor({ config, cwd, version, logger })
    },
  })

  await program.parseAsync(process.argv)
}

function reportError(error: unknown, debug: boolean): void {
  if (error instanceof LunarError) {
    printError(error.message, error.hint)
    if (debug && error.stack !== undefined) {
      printError(error.stack)
    }
    return
  }

  const message = error instanceof Error ? error.message : String(error)
  printError(message)
  if (debug && error instanceof Error && error.stack !== undefined) {
    printError(error.stack)
  }
}

main().catch((error: unknown) => {
  reportError(error, process.argv.includes('--debug'))
  process.exitCode = 1
})
