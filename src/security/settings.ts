import type { SandboxMode } from '../engineering/sandbox.js'
import type { NetworkMode } from './network-policy.js'
import { DEFAULT_NETWORK_MODE } from './network-policy.js'

/**
 * Security settings (Phase 4).
 *
 * Resolves the (strictly validated) `security` configuration section
 * into runtime settings. There are no switches here that disable a
 * core boundary: `sandbox` selects the enforcement level (including a
 * fail-closed "deny"), `network` only accepts deny-by-default, and
 * `environment` only accepts filtered execution.
 */

export interface SecuritySettingsInput {
  readonly sandbox?: SandboxMode
  readonly network?: NetworkMode
  readonly environment?: 'filtered'
}

export interface SecuritySettings {
  readonly sandbox: SandboxMode
  readonly network: NetworkMode
  readonly environment: 'filtered'
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  sandbox: 'auto',
  network: DEFAULT_NETWORK_MODE,
  environment: 'filtered',
}

/** Merge validated configuration over the defaults. */
export function resolveSecuritySettings(
  input: SecuritySettingsInput | undefined = {},
): SecuritySettings {
  return {
    sandbox: input.sandbox ?? DEFAULT_SECURITY_SETTINGS.sandbox,
    network: input.network ?? DEFAULT_SECURITY_SETTINGS.network,
    environment: input.environment ?? DEFAULT_SECURITY_SETTINGS.environment,
  }
}
