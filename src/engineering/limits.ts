/**
 * Hard limits for the autonomous engineering loop (Phase 3).
 *
 * No autonomy is unbounded: every dimension of the loop — correction
 * attempts, mutations, command executions, command duration, output
 * size, and file size — has a cap that Lunar enforces itself. The
 * limits are configuration, not model goodwill.
 */

export interface EngineeringLimits {
  /** Max correct-and-verify attempts per task (default 3). */
  readonly maxIterations: number
  /** Max file mutations across the whole task (default 20). */
  readonly maxMutations: number
  /** Max controlled command executions across the task (default 10). */
  readonly maxCommands: number
  /** Max commands running at the same time (default 1). */
  readonly maxConcurrentCommands: number
  /** Hard cap on one command's runtime (default 120 s). */
  readonly commandTimeoutMs: number
  /** Cap on captured stdout/stderr per command (default 128 KB each). */
  readonly maxOutputBytes: number
  /** Cap on the content of any single mutated file (default 256 KB). */
  readonly maxFileBytes: number
  /** Max changes in one proposal (default 10). */
  readonly maxChangesPerProposal: number
  /** Extra attempts when the model's JSON is invalid (default 2). */
  readonly jsonRetries: number
  /** Executables the command layer may run (empty → built-in defaults). */
  readonly allowedCommands: readonly string[]
}

export const DEFAULT_ENGINEERING_LIMITS: EngineeringLimits = {
  maxIterations: 3,
  maxMutations: 20,
  maxCommands: 10,
  maxConcurrentCommands: 1,
  commandTimeoutMs: 120_000,
  maxOutputBytes: 128_000,
  maxFileBytes: 256 * 1024,
  maxChangesPerProposal: 10,
  jsonRetries: 2,
  allowedCommands: [],
}

/**
 * Executables the command layer accepts when no explicit allowlist is
 * configured. Deliberately conservative: interpreters, package managers,
 * and test/build tools — never shells, never OS utilities that can
 * mutate broadly (rm, del, format, …).
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'python',
  'python3',
  'pytest',
  'cargo',
  'go',
  'make',
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'dotnet',
  'mvn',
  'gradle',
]

/** Merge partial overrides over the defaults. */
export function resolveLimits(overrides: Partial<EngineeringLimits> = {}): EngineeringLimits {
  return { ...DEFAULT_ENGINEERING_LIMITS, ...overrides }
}
