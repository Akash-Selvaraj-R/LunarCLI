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
import { PermissionManager, PHASE3_ASK_POLICY, PHASE3_AUTO_POLICY } from '../permissions/permission-manager.js'
import { resolveProvider } from '../providers/resolve.js'
import { createDefaultToolRegistry } from '../tools/defaults.js'
import { detectWorkspace } from '../workspace/detector.js'
import { AgentRuntime } from '../agent/runtime.js'
import { autoApprove, readlineApprover, readlineCommandApprover } from '../engineering/approval.js'
import { resolveLimits } from '../engineering/limits.js'
import { createSandbox } from '../engineering/sandbox.js'
import { EngineeringLoop } from '../engineering/loop.js'
import { resolveSecuritySettings } from '../security/settings.js'
import { printError } from './output.js'
import { buildProgram } from './program.js'
import { runDoctor } from './commands/doctor.js'
import { runEngineer } from './commands/engineer.js'
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
    run: async ({ debug, cwd, task, engineer, yes }) => {
      const config = loadConfig({ cli: { ...(debug ? { debug: true } : {}) } })
      const logger = createLogger({ level: config.debug ? 'debug' : 'info' })
      const workspace = detectWorkspace(cwd)

      logger.debug('Configuration loaded', { config: describeConfig(config) })
      logger.debug('Workspace detected', { root: workspace.root, git: workspace.git })

      // Resolve the provider before launching so configuration problems
      // surface as a clear, actionable error (no half-started UI).
      const resolved = resolveProvider(config)
      logger.debug('Provider resolved', { provider: resolved.provider.id, model: resolved.model })

      // ── Phase 3: autonomous engineering loop ──────────────────────
      if (engineer === true) {
        if (task === undefined || task === '') {
          printError(
            '--engineer requires a task.',
            'Usage: lunar "<task>" --engineer [--yes]',
          )
          process.exitCode = 1
          return
        }
        const trusted = yes === true
        const security = resolveSecuritySettings(config.security)
        const loop = new EngineeringLoop({
          provider: resolved.provider,
          model: resolved.model,
          workspace,
          logger,
          version,
          limits: resolveLimits(config.engineering),
          // Same centralized risk system as Phase 2 tools: 'ask' by
          // default, explicit trusted mode only via --yes.
          permissions: new PermissionManager(trusted ? PHASE3_AUTO_POLICY : PHASE3_ASK_POLICY),
          approval: trusted ? autoApprove : readlineApprover(),
          // Phase 4 command pipeline: trusted mode auto-approves only
          // REVIEW-class commands; dangerous still prompts, denied
          // stays denied. Non-interactive stdin fails closed.
          trusted,
          commandApproval: readlineCommandApprover(),
          sandbox: createSandbox(security.sandbox, { logger }),
        })
        process.exitCode = await runEngineer({ task, loop, version, logger })
        return
      }

      const agent = new AgentRuntime({
        provider: resolved.provider,
        model: resolved.model,
        workspace,
        logger,
        version,
        // Phase 2: read-only engineering tools behind the permission gate.
        tools: createDefaultToolRegistry(),
        permissions: new PermissionManager(),
      })

      if (task !== undefined) {
        await runTask({ task, config, workspace, version, logger, agent })
      } else {
        await runInteractive({ config, workspace, version, logger, agent })
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
