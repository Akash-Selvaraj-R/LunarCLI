/**
 * Structured application error hierarchy.
 *
 * Every expected failure mode in LunarCLI maps to a `LunarError` subclass with
 * a stable machine-readable `code` and an optional human-readable `hint`.
 * The CLI layer renders these nicely; debug mode additionally shows the
 * original stack and details.
 */

export type LunarErrorCode =
  'CLI_ERROR' | 'CONFIGURATION_ERROR' | 'PROVIDER_ERROR' | 'WORKSPACE_ERROR' | 'NOT_IMPLEMENTED'

export interface LunarErrorOptions {
  /** Actionable suggestion shown to the user. */
  hint?: string
  /** Additional structured context (never contains secrets). */
  details?: Record<string, unknown>
  cause?: unknown
}

/** Base class for all expected LunarCLI errors. */
export class LunarError extends Error {
  readonly code: LunarErrorCode
  readonly hint?: string
  readonly details?: Record<string, unknown>

  constructor(code: LunarErrorCode, message: string, options: LunarErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.code = code
    if (options.hint !== undefined) this.hint = options.hint
    if (options.details !== undefined) this.details = options.details
  }
}

/** Invalid or missing configuration (file, env vars, or CLI flags). */
export class ConfigurationError extends LunarError {
  constructor(message: string, options: LunarErrorOptions = {}) {
    super('CONFIGURATION_ERROR', message, options)
  }
}

/** An LLM provider failed, is unknown, or is not yet available. */
export class ProviderError extends LunarError {
  constructor(message: string, options: LunarErrorOptions = {}) {
    super('PROVIDER_ERROR', message, options)
  }
}

/** Workspace or git detection failed. */
export class WorkspaceError extends LunarError {
  constructor(message: string, options: LunarErrorOptions = {}) {
    super('WORKSPACE_ERROR', message, options)
  }
}

/** CLI misuse (bad flags, missing paths, unknown commands). */
export class CLIError extends LunarError {
  constructor(message: string, options: LunarErrorOptions = {}) {
    super('CLI_ERROR', message, options)
  }
}

/** A deliberately unimplemented feature (Phase 0 placeholders). */
export class NotImplementedError extends LunarError {
  constructor(message: string, options: LunarErrorOptions = {}) {
    super('NOT_IMPLEMENTED', message, options)
  }
}
