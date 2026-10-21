/**
 * Environment isolation (Phase 4).
 *
 * Engineering commands never inherit the parent process environment.
 * They receive a MINIMAL ALLOWLIST — not a denylist — so that an
 * unlisted variable (a new CI secret, a cloud credential Lunar has
 * never heard of) is filtered by default rather than leaked by
 * omission from a blocklist.
 *
 * A defense-in-depth denylist additionally drops any allowlisted name
 * that looks secret-bearing, and Lunar's own provider credentials
 * (LUNAR_*) are structurally absent because only allowlisted names
 * pass. `LUNAR_API_KEY` is NEVER available to engineering commands.
 *
 * The filtered object replaces the child's environment wholesale
 * (`spawn({ env })`), so nothing is inherited through the back door.
 */

/** Names that engineering toolchains legitimately need. */
const BASE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Execution lookup (unchanged from the parent — required to resolve
  // allowlisted executables at all).
  'PATH',
  'PATHEXT',
  // Home/cache locations (npm, cargo, go and friends write caches).
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  // Temp directories.
  'TEMP',
  'TMP',
  'TMPDIR',
  // Windows system context (some runtimes require it).
  'SYSTEMROOT',
  'WINDIR',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  // Locale/terminal — affect tool output only.
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
])

/** Drop even allowlisted names that look secret-bearing. */
const SECRET_NAME_PATTERN = /(api[-_ ]?key|token|secret|password|passwd|credential|private[-_ ]?key|auth)/i

export interface FilteredEnvironment {
  /** The exact environment handed to the child process. */
  readonly env: Record<string, string>
  /** Names of dropped variables that LOOK secret-bearing (names only — never values). */
  readonly removedSensitive: readonly string[]
  /** Total number of dropped variables. */
  readonly removedCount: number
}

/**
 * Filter a source environment down to the allowlist. Only string
 * values pass; everything else is dropped.
 */
export function filterEnvironment(source: NodeJS.ProcessEnv): FilteredEnvironment {
  const env: Record<string, string> = {}
  const removedSensitive: string[] = []
  let removedCount = 0

  for (const [key, value] of Object.entries(source)) {
    const allowed = BASE_ALLOWLIST.has(key.toUpperCase()) || BASE_ALLOWLIST.has(key)
    if (allowed && typeof value === 'string' && !SECRET_NAME_PATTERN.test(key)) {
      env[key] = value
      continue
    }
    removedCount += 1
    // Names only — the audit trail never carries values.
    if (SECRET_NAME_PATTERN.test(key)) removedSensitive.push(key)
  }

  return { env, removedSensitive, removedCount }
}
