import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ConfigurationError } from '../domain/errors/index.js'
import { redactSecrets } from '../utils/redact.js'
import { DEFAULT_CONFIG, ENV_VARS } from './defaults.js'
import { validateConfig } from './schema.js'
import type { LunarConfig, LunarConfigInput } from './schema.js'

/**
 * Configuration loader.
 *
 * Precedence (highest wins):
 *
 *   CLI arguments
 *       ↓
 *   environment variables (LUNAR_*)
 *       ↓
 *   configuration file (~/.lunar/config.json)
 *       ↓
 *   defaults
 */

export interface LoadConfigOptions {
  /** Overrides from CLI arguments (highest precedence). */
  cli?: LunarConfigInput
  /** Environment to read (defaults to process.env). */
  env?: NodeJS.ProcessEnv
  /** Configuration file path (defaults to ~/.lunar/config.json). */
  configPath?: string
}

/** Default per-user configuration file location. */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.lunar', 'config.json')
}

/** Parse `LUNAR_DEBUG`-style boolean strings. */
function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new ConfigurationError(`Cannot parse boolean value: "${value}"`, {
    hint: 'Use true/false, 1/0, yes/no, or on/off.',
  })
}

/** Read and parse the configuration file, if present. */
function loadConfigFile(configPath: string): LunarConfigInput {
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch {
    return {} // Missing file is fine — defaults apply.
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConfigurationError(`Configuration file is not valid JSON: ${configPath}`, {
      cause: error,
      hint: `Fix the JSON syntax in ${configPath} or delete the file.`,
    })
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigurationError(`Configuration file must contain a JSON object: ${configPath}`)
  }

  const { debug, provider, model, apiKey, engineering } = parsed as Record<string, unknown>
  return {
    ...(typeof debug === 'boolean' ? { debug } : {}),
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof apiKey === 'string' ? { apiKey } : {}),
    // Passed through as-is (cast): the schema validates the section and
    // rejects wrong types with a precise error instead of silence.
    ...(engineering !== undefined
      ? { engineering: engineering as LunarConfigInput['engineering'] }
      : {}),
  }
}

/** Extract configuration from environment variables. */
function loadFromEnv(env: NodeJS.ProcessEnv): LunarConfigInput {
  const input: LunarConfigInput = {}
  const provider = env[ENV_VARS.provider]
  const model = env[ENV_VARS.model]
  const apiKey = env[ENV_VARS.apiKey]
  const debug = parseBoolean(env[ENV_VARS.debug])
  if (provider !== undefined && provider !== '') input.provider = provider
  if (model !== undefined && model !== '') input.model = model
  if (apiKey !== undefined && apiKey !== '') input.apiKey = apiKey
  if (debug !== undefined) input.debug = debug
  return input
}

/** Drop undefined values so they don't clobber lower-precedence layers. */
function definedOnly(input: LunarConfigInput): LunarConfigInput {
  const result: LunarConfigInput = {}
  if (input.provider !== undefined) result.provider = input.provider
  if (input.model !== undefined) result.model = input.model
  if (input.apiKey !== undefined) result.apiKey = input.apiKey
  if (input.debug !== undefined) result.debug = input.debug
  if (input.engineering !== undefined) result.engineering = input.engineering
  return result
}

/**
 * Load configuration by merging all layers in precedence order and
 * validating the result.
 */
export function loadConfig(options: LoadConfigOptions = {}): LunarConfig {
  const env = options.env ?? process.env
  const configPath = options.configPath ?? defaultConfigPath()

  const fileConfig = loadConfigFile(configPath)
  const envConfig = loadFromEnv(env)
  const cliConfig = definedOnly(options.cli ?? {})

  const merged = {
    ...DEFAULT_CONFIG,
    ...definedOnly(fileConfig),
    ...envConfig,
    ...cliConfig,
    // The engineering section merges per key (CLI wins over file) so a
    // single `--engineer` flag never wipes configured limits.
    ...(fileConfig.engineering !== undefined || cliConfig.engineering !== undefined
      ? { engineering: { ...fileConfig.engineering, ...cliConfig.engineering } }
      : {}),
  }

  return validateConfig(merged)
}

/** Render a configuration object for debug logs, with secrets redacted. */
export function describeConfig(config: LunarConfig): Record<string, unknown> {
  return redactSecrets(config) as Record<string, unknown>
}
