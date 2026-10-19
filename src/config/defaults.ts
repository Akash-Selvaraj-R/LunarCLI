import type { LunarConfigInput } from './schema.js'

/**
 * Built-in configuration defaults — the lowest-precedence layer.
 */
export const DEFAULT_CONFIG: Required<Pick<LunarConfigInput, 'debug'>> = {
  debug: false,
}

/** Environment variable names understood by LunarCLI. */
export const ENV_VARS = {
  provider: 'LUNAR_PROVIDER',
  model: 'LUNAR_MODEL',
  apiKey: 'LUNAR_API_KEY',
  debug: 'LUNAR_DEBUG',
} as const
