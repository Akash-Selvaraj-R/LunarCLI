import { hasNetworkArgument } from './network-policy.js'
import type { NormalizedCommand } from './normalizer.js'

/**
 * Per-command risk classification (Phase 4).
 *
 * The unit of classification is the NORMALIZED COMMAND — executable
 * AND arguments, working directory, and network shape — never the bare
 * executable name. `npm test` and `npm publish` are different commands;
 * `git status` and `git push` are different commands. The rules live in
 * a structured table (per-executable matchers over subcommands and
 * flags), not in scattered string matching.
 *
 * MODEL OUTPUT IS UNTRUSTED: the model proposes, this classifier —
 * outside the model — decides what the proposal is. Repository content
 * (a hostile README, a malicious package.json) cannot change these
 * rules; at most it changes which command is DETECTED, and every
 * detected command still passes this classification.
 */

/** Command risk levels, from most to least trusted. */
export type CommandRisk = 'safe' | 'review' | 'dangerous' | 'denied'

export interface Classification {
  readonly risk: CommandRisk
  readonly reason: string
  /** Whether the command is treated as network-capable. */
  readonly network: boolean
}

interface RuleOutcome {
  readonly risk: CommandRisk
  readonly reason: string
  readonly network?: boolean
}

interface CommandRule extends RuleOutcome {
  /** args[0] must be one of these (requires at least one arg). */
  readonly firstArgIn?: readonly string[]
  /** args[1] must be one of these (requires at least two args). */
  readonly secondArgIn?: readonly string[]
  /** args[0] must NOT be one of these (requires at least one arg). */
  readonly firstArgNotIn?: readonly string[]
  /** Some argument must exactly equal one of these (flags). */
  readonly anyArgIn?: readonly string[]
  /** Some argument must match this pattern. */
  readonly anyArgMatches?: RegExp
  /** No argument may match this pattern, or the rule is skipped. */
  readonly forbiddenArgs?: RegExp
  /** Argument-count bounds (inclusive). */
  readonly minArgs?: number
  readonly maxArgs?: number
}

interface ExecutableRules {
  /** Applied when no rule matches. */
  readonly fallback: RuleOutcome
  /** Evaluated in order; the first match wins. */
  readonly rules: readonly CommandRule[]
}

// ─── HARD DENY ──────────────────────────────────────────────────────
//
// Never executable through Lunar, regardless of allowlist, project
// policy, `--yes`, or approval. Shells, LOLBins, credential tools,
// network transfer tools, destructive OS operations, privilege
// escalation. This list is checked BEFORE anything else and can only
// change with a code change to Lunar itself.

export const HARD_DENY_EXECUTABLES: ReadonlySet<string> = new Set([
  // Shells and script hosts — the whole point of "never a shell".
  'sh', 'bash', 'zsh', 'ksh', 'csh', 'fish', 'dash', 'ash', 'tcsh',
  'cmd', 'powershell', 'pwsh', 'powershell_ise',
  'wscript', 'cscript', 'mshta',
  // Windows LOLBins used for proxy execution and downloads.
  'rundll32', 'regsvr32', 'certutil', 'bitsadmin', 'reg',
  // Network transfer / remote access.
  'curl', 'wget', 'ftp', 'tftp', 'telnet', 'ssh', 'scp', 'sftp',
  'rsync', 'nc', 'ncat', 'netcat', 'socat', 'ftp',
  // Destructive / recursive filesystem operations.
  'rm', 'rmdir', 'del', 'erase', 'rd', 'format', 'mkfs', 'mkfs.ext4',
  'dd', 'shred',
  // Privilege escalation.
  'sudo', 'su', 'doas', 'pkexec',
  // System control.
  'shutdown', 'reboot', 'halt', 'poweroff', 'powercfg',
  // Killing arbitrary processes is outside Lunar's authority.
  'taskkill', 'kill', 'killall', 'pkill',
  // Launching arbitrary local programs.
  'start', 'explorer', 'open', 'xdg-open',
])

// ─── PER-EXECUTABLE RULES ───────────────────────────────────────────

const SAFE_FLAGS: readonly string[] = ['--version', '-v', '--help', '-h']

const npmRules: ExecutableRules = {
  fallback: { risk: 'review', reason: 'npm subcommand needs review before running.' },
  rules: [
    {
      risk: 'denied',
      reason: 'Registry administration, credentials, and publishing are outside Lunar’s authority.',
      firstArgIn: [
        'publish', 'unpublish', 'deprecate', 'login', 'adduser', 'logout',
        'token', 'owner', 'access', 'profile', 'hook', 'org', 'team',
      ],
    },
    {
      risk: 'denied',
      reason: 'npm explore opens an interactive shell in a package directory.',
      firstArgIn: ['explore'],
    },
    {
      risk: 'dangerous',
      reason: 'npm exec runs arbitrary nested tooling (install-and-execute).',
      firstArgIn: ['exec', 'x'],
    },
    { risk: 'safe', reason: 'Runs the repository test script.', firstArgIn: ['test'] },
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
    {
      risk: 'safe',
      reason: 'Runs a standard project script (test/lint/build/check).',
      firstArgIn: ['run', 'run-script'],
      secondArgIn: ['test', 'lint', 'build', 'check', 'typecheck', 'format'],
      maxArgs: 2,
    },
    {
      risk: 'review',
      reason: 'Runs an arbitrary project script.',
      firstArgIn: ['run', 'run-script'],
    },
    {
      risk: 'review',
      reason: 'Modifies dependencies or package metadata.',
      firstArgIn: [
        'install', 'i', 'ci', 'install-test', 'it', 'update', 'upgrade',
        'outdated', 'audit', 'dedupe', 'rebuild', 'link', 'pack', 'version',
        'ls', 'root', 'prefix', 'query', 'explain', 'licenses', 'ping', 'star', 'unstar',
      ],
    },
  ],
}

const gitRules: ExecutableRules = {
  fallback: {
    risk: 'dangerous',
    reason: 'Git history or working-tree mutation is outside Lunar’s authority.',
  },
  rules: [
    {
      // `git stash list/show` are the read-only stash forms (checked
      // BEFORE the deny rule, which catches pop/apply/drop).
      risk: 'safe',
      reason: 'Read-only stash listing.',
      firstArgIn: ['stash'],
      secondArgIn: ['list', 'show'],
      maxArgs: 2,
    },
    {
      risk: 'denied',
      reason: 'Repository history and working-tree mutation is not implemented in Lunar.',
      firstArgIn: [
        'push', 'commit', 'reset', 'checkout', 'restore', 'clean', 'rebase',
        'merge', 'am', 'cherry-pick', 'revert', 'filter-branch', 'mv', 'rm',
        'submodule', 'clone', 'fetch', 'pull', 'tag', 'apply', 'stash',
      ],
    },
    {
      risk: 'dangerous',
      reason: 'Git configuration changes affect every future repository operation.',
      firstArgIn: ['config'],
    },
    {
      risk: 'dangerous',
      reason: 'Garbage collection rewrites repository objects.',
      firstArgIn: ['gc', 'prune'],
    },
    {
      risk: 'dangerous',
      reason: 'Remote configuration can redirect future fetches.',
      firstArgIn: ['remote'],
    },
    {
      risk: 'safe',
      reason: 'Read-only repository inspection.',
      firstArgIn: ['status', 'diff', 'log', 'show'],
    },
    {
      risk: 'safe',
      reason: 'Read-only branch listing.',
      firstArgIn: ['branch'],
      forbiddenArgs: /-[dDm]/, // -d/-D/-m delete or move branches
    },
    { risk: 'review', reason: 'Repository initialization.', firstArgIn: ['init'] },
  ],
}

const cargoRules: ExecutableRules = {
  fallback: { risk: 'review', reason: 'Cargo subcommand needs review before running.' },
  rules: [
    {
      risk: 'denied',
      reason: 'Registry publishing and credentials are outside Lunar’s authority.',
      firstArgIn: ['publish', 'yank', 'login', 'logout', 'owner', 'token'],
    },
    { risk: 'dangerous', reason: 'cargo run executes arbitrary project code.', firstArgIn: ['run'] },
    { risk: 'safe', reason: 'Runs the Rust test suite.', firstArgIn: ['test'] },
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
    {
      risk: 'safe',
      reason: 'Static checking without producing artifacts.',
      firstArgIn: ['check', 'clippy'],
    },
    {
      risk: 'safe',
      reason: 'Formatting check (no writes without --check it is review).',
      firstArgIn: ['fmt'],
      anyArgIn: ['--check'],
    },
    {
      risk: 'review',
      reason: 'Builds artifacts (build scripts execute project code).',
      firstArgIn: ['build', 'doc', 'bench', 'fmt', 'tree', 'metadata', 'update', 'clean'],
    },
  ],
}

const goRules: ExecutableRules = {
  fallback: { risk: 'review', reason: 'Go subcommand needs review before running.' },
  rules: [
    { risk: 'denied', reason: 'go install downloads and installs executables.', firstArgIn: ['install'] },
    { risk: 'dangerous', reason: 'go run executes arbitrary project code.', firstArgIn: ['run'] },
    { risk: 'safe', reason: 'Runs the Go test suite.', firstArgIn: ['test'] },
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
    { risk: 'safe', reason: 'Read-only environment query.', firstArgIn: ['env', 'list', 'version'] },
    {
      risk: 'review',
      reason: 'Builds or formats project code.',
      firstArgIn: ['build', 'vet', 'fmt', 'mod', 'generate', 'doc'],
    },
  ],
}

const pythonRules: ExecutableRules = {
  fallback: { risk: 'review', reason: 'Runs a Python script — needs review before running.' },
  rules: [
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
    {
      risk: 'safe',
      reason: 'Runs the pytest test suite.',
      firstArgIn: ['-m'],
      secondArgIn: ['pytest', 'unittest'],
    },
    { risk: 'dangerous', reason: 'Inline Python executes arbitrary code.', anyArgMatches: /^(-c|--command)$/ },
    {
      risk: 'dangerous',
      reason: 'Arbitrary module execution (modules may open sockets or spawn processes).',
      firstArgIn: ['-m'],
    },
  ],
}

const nodeRules: ExecutableRules = {
  fallback: { risk: 'review', reason: 'Runs project code — needs review before running.' },
  rules: [
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
    {
      risk: 'dangerous',
      reason: 'Inline JavaScript executes arbitrary code.',
      anyArgMatches: /^(-e|--eval|-p|--print|--input-type)$/,
    },
    { risk: 'review', reason: 'Runs a script file.', minArgs: 1 },
  ],
}

const denoRules: ExecutableRules = {
  fallback: { risk: 'review', reason: 'Deno subcommand needs review before running.' },
  rules: [
    { risk: 'dangerous', reason: 'Runs arbitrary code and may fetch remote modules.', firstArgIn: ['run', 'eval', 'repl', 'install', 'bundle', 'compile'] },
    { risk: 'safe', reason: 'Runs the Deno test suite.', firstArgIn: ['test'] },
    { risk: 'safe', reason: 'Static check / lint without execution.', firstArgIn: ['check', 'lint'] },
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
    { risk: 'safe', reason: 'Format check (read-only).', firstArgIn: ['fmt'], anyArgIn: ['--check'] },
    { risk: 'review', reason: 'Writes formatted files.', firstArgIn: ['fmt'] },
  ],
}

const npxRules: ExecutableRules = {
  fallback: {
    risk: 'dangerous',
    reason: 'Installs and executes arbitrary packages (install-and-execute).',
  },
  rules: [{ risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS }],
}

const makeRules: ExecutableRules = {
  fallback: { risk: 'review', reason: 'Runs a Makefile target — needs review before running.' },
  rules: [
    { risk: 'safe', reason: 'Runs a standard test/lint/check target.', firstArgIn: ['test', 'check', 'lint', 'help'] },
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
  ],
}

const testRunnerRules: ExecutableRules = {
  fallback: { risk: 'safe', reason: 'Test runner.' },
  rules: [{ risk: 'review', reason: 'Interactive or write-capable mode.', anyArgMatches: /^(-i|--interactive|--watch)(=|$)/ }],
}

const buildToolRules: ExecutableRules = {
  fallback: { risk: 'safe', reason: 'Static build/lint tool.' },
  rules: [],
}

const dotnetRules: ExecutableRules = {
  fallback: { risk: 'review', reason: '.NET subcommand needs review before running.' },
  rules: [
    { risk: 'denied', reason: 'Publishing to a registry is outside Lunar’s authority.', firstArgIn: ['publish', 'push', 'nuget'] },
    { risk: 'dangerous', reason: 'Installs or runs global tools.', firstArgIn: ['tool', 'run'] },
    { risk: 'safe', reason: 'Runs the .NET test suite.', firstArgIn: ['test'] },
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
    { risk: 'review', reason: 'Builds project artifacts.', firstArgIn: ['build', 'restore', 'pack', 'clean'] },
  ],
}

const jvmRules: ExecutableRules = {
  fallback: { risk: 'review', reason: 'JVM build subcommand needs review before running.' },
  rules: [
    { risk: 'denied', reason: 'Deploying artifacts is outside Lunar’s authority.', firstArgIn: ['deploy'] },
    { risk: 'safe', reason: 'Runs the JVM test suite.', firstArgIn: ['test', 'verify'] },
    { risk: 'safe', reason: 'Version/help query.', firstArgIn: SAFE_FLAGS },
  ],
}

/** The rule table. Unknown executables fall back to `review`. */
const EXECUTABLE_RULES: Readonly<Record<string, ExecutableRules>> = {
  npm: npmRules,
  pnpm: npmRules,
  yarn: npmRules,
  bun: npmRules,
  npx: npxRules,
  git: gitRules,
  cargo: cargoRules,
  go: goRules,
  node: nodeRules,
  python: pythonRules,
  'python3': pythonRules,
  deno: denoRules,
  make: makeRules,
  pytest: testRunnerRules,
  vitest: testRunnerRules,
  jest: testRunnerRules,
  mocha: testRunnerRules,
  tsc: buildToolRules,
  dotnet: dotnetRules,
  mvn: jvmRules,
  gradle: jvmRules,
}

/** Whether a command matches every condition of a rule. */
function matches(rule: CommandRule, command: NormalizedCommand): boolean {
  const { args } = command
  if (rule.firstArgIn !== undefined && (args.length === 0 || !rule.firstArgIn.includes(args[0] as string))) {
    return false
  }
  if (rule.firstArgNotIn !== undefined && (args.length === 0 || rule.firstArgNotIn.includes(args[0] as string))) {
    return false
  }
  if (rule.secondArgIn !== undefined && (args.length < 2 || !rule.secondArgIn.includes(args[1] as string))) {
    return false
  }
  if (rule.anyArgIn !== undefined && !args.some((arg) => rule.anyArgIn?.includes(arg))) {
    return false
  }
  if (rule.anyArgMatches !== undefined && !args.some((arg) => rule.anyArgMatches?.test(arg))) {
    return false
  }
  if (rule.forbiddenArgs !== undefined && args.some((arg) => rule.forbiddenArgs?.test(arg))) {
    return false
  }
  if (rule.minArgs !== undefined && args.length < rule.minArgs) return false
  if (rule.maxArgs !== undefined && args.length > rule.maxArgs) return false
  return true
}

/** `--force` and friends: escalate a safe classification to review. */
const FORCE_FLAGS = /^(--force(-\w+)?|--yes|-y|--no-verify|--unsafe(-\w+)?)$/

/**
 * Classify a normalized command. Pure function of its input — no
 * environment, no model, no repository state.
 */
export function classifyCommand(command: NormalizedCommand): Classification {
  const network = hasNetworkArgument(command.args)

  // 1. Hard deny — checked before any other consideration.
  if (HARD_DENY_EXECUTABLES.has(command.executable)) {
    return {
      risk: 'denied',
      reason: `"${command.executable}" is blocked outright (shells, transfer tools, and destructive OS operations are never run by Lunar).`,
      network,
    }
  }

  // 2. Per-executable structured rules.
  const table = EXECUTABLE_RULES[command.executable]
  let outcome: RuleOutcome
  if (table === undefined) {
    outcome = {
      risk: 'review',
      reason: `"${command.executable}" is not a known tool — review required.`,
    }
  } else {
    outcome = table.rules.find((rule) => matches(rule, command)) ?? table.fallback
  }
  let risk = outcome.risk
  const reason = outcome.reason

  // 3. Argument-sensitive escalation: URL arguments are a network
  //    vector regardless of the executable (unless already denied).
  if (network && risk !== 'denied') {
    risk = risk === 'dangerous' ? 'dangerous' : 'review'
  }

  // 4. Force-style flags escalate safe → review.
  if (risk === 'safe' && command.args.some((arg) => FORCE_FLAGS.test(arg))) {
    risk = 'review'
    return { risk, reason: 'Force-style flags can bypass tool safeguards.', network }
  }

  return { risk, reason, network }
}
