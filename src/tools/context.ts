import type { Workspace } from '../domain/types/workspace.js'
import type { Logger } from '../logging/logger.js'

/**
 * The only application state tools receive.
 *
 * Tools never see the full application object, provider configuration,
 * or API keys — the workspace, an optional abort signal, and a redacting
 * logger are all a read-only inspection tool needs.
 */
export interface ToolContext {
  readonly workspace: Workspace
  /** Aborts long-running tool work (Ctrl+C during tool execution). */
  readonly signal?: AbortSignal
  readonly logger: Logger
}
