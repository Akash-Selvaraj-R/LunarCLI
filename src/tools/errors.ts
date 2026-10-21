import { LunarError } from '../domain/errors/index.js'

/**
 * Structured tool failures.
 *
 * A tool failure is NOT an application crash: the executor converts it
 * into a failed `ToolResult` that the model can reason about ("file not
 * found — try another path"). Only truly unexpected throwables become a
 * generic execution error.
 */

export type ToolErrorKind =
  /** The model supplied arguments that failed schema validation. */
  | 'invalid_input'
  /** No tool with that name is registered (or it is disabled). */
  | 'tool_not_found'
  /** The requested file/directory does not exist. */
  | 'file_not_found'
  /** The requested path resolves outside the workspace. */
  | 'path_outside_workspace'
  /** The path exists but is the wrong kind (e.g. a directory where a file was expected). */
  | 'not_a_file'
  /** The operation is not permitted in this context (e.g. git tool outside a repo). */
  | 'permission_denied'
  /** Output or input exceeded a configured limit. */
  | 'output_limit'
  /** The underlying operation failed (I/O error, git failure, …). */
  | 'execution_error'
  /** The operation timed out or was aborted. */
  | 'cancelled'

export interface ToolErrorOptions {
  hint?: string
  details?: Record<string, unknown>
  cause?: unknown
}

/** A structured, model-presentable tool failure. */
export class ToolError extends LunarError {
  readonly kind: ToolErrorKind

  constructor(kind: ToolErrorKind, message: string, options: ToolErrorOptions = {}) {
    super('TOOL_ERROR', message, {
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })
    this.kind = kind
  }
}

/** Narrowing helper. */
export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError
}
