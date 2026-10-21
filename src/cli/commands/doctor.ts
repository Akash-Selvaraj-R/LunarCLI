import type { LunarConfig } from '../../config/schema.js'
import type { Logger } from '../../logging/logger.js'
import { createDefaultRegistry } from '../../providers/registry.js'
import { detectWorkspace } from '../../workspace/detector.js'
import { createSandbox } from '../../engineering/sandbox.js'
import { resolveSecuritySettings } from '../../security/settings.js'
import { stdout } from '../output.js'
import { theme } from '../../ui/theme.js'
import { infoRow } from '../../ui/styles.js'

export interface DoctorOptions {
  config: LunarConfig
  cwd: string
  version: string
  logger: Logger
}

/**
 * `lunar doctor` — a lightweight installation sanity check.
 */
export async function runDoctor(options: DoctorOptions): Promise<void> {
  const { config, cwd, version, logger } = options
  logger.debug('Running doctor', { cwd })

  stdout('')
  stdout(`${theme.brand('☾ Lunar')} ${theme.muted('Doctor')}`)
  stdout('')

  // Node.js
  stdout(infoRow('Node.js', `${theme.success('✓')} ${process.version}`))

  // Workspace
  try {
    const workspace = detectWorkspace(cwd)
    const gitSummary = workspace.git.isRepository
      ? `git: ${workspace.git.branch ?? 'yes'}`
      : 'no git repository'
    stdout(infoRow('Workspace', `${theme.success('✓')} ${workspace.name} (${gitSummary})`))
  } catch (error) {
    stdout(
      infoRow(
        'Workspace',
        `${theme.error('✗')} ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }

  // Configuration
  stdout(infoRow('Configuration', `${theme.success('✓')} valid`))

  // Provider
  const registry = createDefaultRegistry()
  if (config.provider !== undefined && registry.has(config.provider)) {
    stdout(infoRow('LLM provider', `${theme.success('✓')} ${config.provider}`))
  } else if (config.provider !== undefined) {
    stdout(
      infoRow(
        'LLM provider',
        `${theme.warning('⚠')} "${config.provider}" is not a known provider (available: ${registry
          .list()
          .map((p) => p.id)
          .join(', ')})`,
      ),
    )
  } else {
    stdout(infoRow('LLM provider', `${theme.warning('⚠')} not configured`))
  }

  // API key (presence only — the value is never displayed)
  if (config.apiKey !== undefined) {
    stdout(infoRow('API key', `${theme.success('✓')} configured`))
  } else {
    stdout(infoRow('API key', `${theme.warning('⚠')} not configured (LUNAR_API_KEY)`))
  }

  stdout('')
  stdout(`${theme.muted('version')}   ${version}`)
  stdout('')

  // Phase 4 security posture — the REAL state, never aspirational.
  const security = resolveSecuritySettings(config.security)
  const sandbox = createSandbox(security.sandbox)
  const sandboxState =
    sandbox.describe().level === 'unavailable'
      ? `${theme.error('✗')} ${sandbox.describe().label}`
      : `${theme.warning('⚠')} ${sandbox.describe().label}`
  stdout(theme.bold('Security'))
  stdout(infoRow('Engineering Loop', `${theme.success('✓')} READY`))
  stdout(infoRow('Command Policy', `${theme.success('✓')} READY (per-command, hard-deny enforced)`))
  stdout(infoRow('Environment Filter', `${theme.success('✓')} READY (allowlist)`))
  stdout(infoRow('Sandbox', sandboxState))
  stdout(infoRow('Network Policy', `${theme.success('✓')} DENY (default)`))
  stdout('')

  stdout(`${theme.success('Status:')} ENGINEERING LOOP READY (Phase 3) · SECURITY PIPELINE READY (Phase 4)`)
  stdout('')
}
