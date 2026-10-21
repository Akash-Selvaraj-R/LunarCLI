/**
 * Network policy (Phase 4).
 *
 * Phase 4 establishes a deny-by-default network boundary. There is no
 * general HTTP access, no browser, and no web tool; network-capable
 * executables (curl, wget, ssh, …) are hard-denied, and commands that
 * carry URL-like arguments are flagged as network-capable so the
 * classifier can escalate their risk.
 *
 * Future network allowlisting must be added HERE, as a separate,
 * explicit capability — never by weakening the default.
 */

/** The network policy mode. Only deny-by-default exists today. */
export type NetworkMode = 'deny'

/** The default (and only) network policy. */
export const DEFAULT_NETWORK_MODE: NetworkMode = 'deny'

/** Human-readable label for approval UX and doctor output. */
export function networkLabel(mode: NetworkMode = DEFAULT_NETWORK_MODE): string {
  return mode === 'deny' ? 'DENIED' : 'ALLOWED'
}

/**
 * URL-shaped arguments (http/https/git/ssh/ftp scp-style) — the classic
 * exfiltration and remote-install vector. A command carrying one is
 * treated as network-capable regardless of its executable.
 */
const URL_PATTERNS: RegExp[] = [
  /^(https?|ftps?|sftp|git|ssh|file):\/\//i,
  // scp-style git remotes: git@host:owner/repo.git
  /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$/,
]

/** Whether an argument looks like a network endpoint. */
export function isNetworkArgument(arg: string): boolean {
  return URL_PATTERNS.some((pattern) => pattern.test(arg.trim()))
}

/** Whether any argument is URL-shaped. */
export function hasNetworkArgument(args: readonly string[]): boolean {
  return args.some(isNetworkArgument)
}
