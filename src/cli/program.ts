import path from 'node:path'

import { Command } from 'commander'

/**
 * CLI definition.
 *
 * Kept free of side effects: `buildProgram` receives its handlers via
 * injection so argument parsing is unit-testable without launching the
 * TUI or touching the filesystem.
 */

export interface CliOptions {
  /** Enable debug diagnostics (only when explicitly requested). */
  debug?: true
  /** Working directory to operate in. */
  cwd: string
}

export interface RunOptions extends CliOptions {
  /** Task text supplied as positional arguments, if any. */
  task?: string
}

export interface CliHandlers {
  /** Default command: interactive UI, or task acknowledgement. */
  run(options: RunOptions): Promise<void>
  /** `lunar doctor`. */
  doctor(options: CliOptions): Promise<void>
}

/** Add the shared global options to a command. */
function withGlobalOptions(command: Command, options: { cwdDefault?: string } = {}): Command {
  const withCwd =
    options.cwdDefault === undefined
      ? command.option('--cwd <path>', 'working directory to operate in')
      : command.option('--cwd <path>', 'working directory to operate in', options.cwdDefault)
  return withCwd.option('--debug', 'enable debug diagnostics')
}

/** Build the `lunar` program. */
export function buildProgram(version: string, handlers: CliHandlers): Command {
  const program = new Command()

  withGlobalOptions(
    program
      .name('lunar')
      .description('LunarCLI — AI engineering agent for your terminal.')
      .version(version, '-V, --version', 'output the version number')
      .argument('[task...]', 'task for the agent (execution arrives in Phase 1)'),
    { cwdDefault: process.cwd() },
  ).action(async (taskParts: string[], options: RunOptions) => {
    const task = taskParts.join(' ')
    await handlers.run({
      ...options,
      cwd: path.resolve(options.cwd),
      ...(task !== '' ? { task } : {}),
    })
  })

  // The subcommand deliberately has no --cwd default so that a global
  // `lunar --cwd X doctor` keeps X.
  withGlobalOptions(
    program.command('doctor').description('diagnose the local LunarCLI installation'),
  ).action(async (_options: CliOptions, command: Command) => {
    // Merge subcommand options over the global ones.
    const globals = command.parent?.opts() ?? {}
    const merged: CliOptions = { ...globals, ...command.opts() }
    await handlers.doctor({ ...merged, cwd: path.resolve(merged.cwd) })
  })

  return program
}
