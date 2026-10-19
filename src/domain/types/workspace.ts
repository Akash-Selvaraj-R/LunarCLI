/**
 * Workspace-related domain types.
 */

/** Git repository information detected for a workspace. */
export interface GitInfo {
  readonly isRepository: boolean
  /** Absolute path to the repository root, when inside one. */
  readonly root?: string
  /** Current branch name, when determinable. */
  readonly branch?: string
}

/** The workspace LunarCLI was launched in. */
export interface Workspace {
  /** Absolute path of the directory Lunar was launched from. */
  readonly cwd: string
  /** Project root: the git root when in a repo, otherwise the cwd. */
  readonly root: string
  /** Human-readable display name (home-relative when possible). */
  readonly name: string
  readonly git: GitInfo
}
