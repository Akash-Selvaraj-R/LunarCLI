# LunarCLI

**AI engineering agent for your terminal.**

```text
☾ LUNAR
```

LunarCLI is an AI engineering agent that runs in your terminal.

It can inspect a repository, reason about the codebase, create a
structured engineering plan, propose file changes, show a diff, obtain
permission, apply approved changes atomically, run controlled
verification, diagnose failures, and perform bounded corrective
iterations.

> **Status: Phase 3 — Autonomous Engineering Loop.**
> In explicit `--engineer` mode, Lunar runs a **bounded autonomous
> loop**: it plans the change, proposes structured file edits, shows you
> a diff, asks for approval, applies atomically, runs controlled
> verification, and — on failure — diagnoses and proposes a fix. Git
> commit/push and unrestricted network access are **not implemented**.
> See [Roadmap](#roadmap).

```text
Current release: v0.4.0
Phase: 3 — Autonomous Engineering Loop
```

## Installation

Requires Node.js >= 20.

```bash
# From source (development)
git clone <repo-url> lunar-cli
cd lunar-cli
npm install
npm run build
npm link        # makes `lunar` available on your PATH
```

## Usage

```bash
lunar                                      # interactive terminal UI
lunar "explain this project"               # one-shot: answer a single question
lunar "add a /health endpoint" --engineer   # autonomous engineering loop
lunar "add a /health endpoint" --engineer --yes  # trusted mode (see below)
lunar --help                               # usage
lunar --version                            # version (v0.4.0)
lunar --debug                              # verbose diagnostics (timings, args)
lunar --cwd <path>                         # operate in a different directory
lunar doctor                               # installation health check
```

- `--engineer` activates the bounded engineering loop: plan → propose →
  validate → approve → apply → verify, with diagnosis and a bounded
  retry on failure. Lunar asks before touching any file.
- `--yes` enables trusted auto-approval: permitted mutations are applied
  without a prompt, while dangerous operations remain denied according
  to the Phase 3 permission system. It is **not** unrestricted
  execution.

Example interactive session:

```text
☾ Lunar › what files are in this project?

☾ thinking...

◇ list_directory
  path: .
✓ 12 entries in .

Lunar › This is a TypeScript CLI project …
```

## The Lunar Engineering Loop

`--engineer` runs this loop:

```text
USER REQUEST
     ↓
   PLAN
     ↓
  PROPOSE
     ↓
  VALIDATE
     ↓
 PERMISSION
     ↓
   APPLY
     ↓
DIFF / VERIFY
     │
     ├── PASS → COMPLETE
     │
     └── FAIL
          ↓
       DIAGNOSE
          ↓
        FIX
          ↓
      VERIFY
          ↓
     bounded retry
```

The safety boundary: nothing reaches disk without passing validation
and the permission/approval gate, and a task stops after `maxIterations`
corrective attempts — never `while (true)`.

### Phase 3 limits (defaults; all configurable)

```text
maxIterations            3    corrective attempts per task
maxMutations            20    file writes per task
maxCommands             10    command executions per task
commandTimeoutMs   120000    hard kill after 2 minutes
maxOutputBytes      128000    per stream (stdout/stderr)
maxFileBytes        262144    per mutated file
maxChangesPerProposal   10    per proposal
jsonRetries              2    extra attempts on invalid model JSON
```

## Current Status (Phase 3 — Autonomous Engineering Loop)

Implemented:

- Everything from Phase 2: multi-turn tool loop with read-only tools,
  permission system, workspace path security
- **Structured planning**: the model produces a Zod-validated
  `EngineeringPlan` (goal + steps) before anything happens; invalid
  output is a controlled error, not prose
- **Proposed mutations**: the model proposes `FileChange`s
  (`create`/`update`/`delete` with path, content, reason) as JSON —
  it never writes files itself
- **Change validation**: workspace-boundary path checks (traversal,
  absolute escapes, symlink escapes), existence rules (update/delete
  must exist, create must not overwrite), `oldContent` conflict
  detection, per-file and per-proposal size caps
- **Diff preview**: unified diffs (LCS-based, bounded) shown before
  any mutation
- **Mutation approval**: nothing is applied without an explicit human
  decision (`Apply changes? [y/N]`); `--yes` enables a trusted
  auto-approve mode; deletes are called out as irreversible
- **Atomic mutation**: temp file → write → rename; stop-on-first-error;
  single files only (no directory deletion)
- **Controlled command execution**: structured `executable + args[]`
  requests — allowlisted bare executables, no shell, workspace-bound
  cwd, hard timeouts with process kill, bounded stdout/stderr capture
- **Repository-aware test runner**: command detection (`npm test`,
  `cargo test`, `go test ./...`, `pytest`, `make test`), structured
  results (exit code, pass/fail counts when parseable, duration) with
  raw output preserved for diagnosis
- **Verification**: applied changes are confirmed on disk and the test
  command must pass — a successful file write alone is not success
- **Failure diagnosis & bounded retry**: on verification failure the
  model diagnoses (structured, Zod-validated) and proposes a fix that
  re-enters PROPOSE → VALIDATE → APPROVE → APPLY; the loop stops after
  `maxIterations` (default 3)
- **Hard limits everywhere**: iterations, mutations per task, command
  executions, command duration, output size, file size — enforced in
  code, configurable in `config.json`
- **Observability**: every phase, approval, mutation, and command
  execution emits an event (with duration), visible with `--debug`

### Tools

Read-only tools — callable by the model during any run:

| Tool           | Risk      | Status  |
| -------------- | --------- | ------- |
| `list_directory` | safe    | enabled |
| `read_file`      | read-only | enabled |
| `file_exists`    | safe    | enabled |
| `search_files`   | safe    | enabled |
| `find_files`     | safe    | enabled |
| `git_status`     | safe    | enabled |
| `git_diff`       | read-only | enabled |
| `git_log`        | safe    | enabled |
| `git_branch`     | read-only | enabled |

Structured engineering proposals — `--engineer` mode only, after
validation and approval:

| Operation                    | Risk      | Status                                       |
| ---------------------------- | --------- | -------------------------------------------- |
| file create/update/delete    | mutating  | via `--engineer` **after approval**          |
| verification command execution | dangerous | allowlisted executables only, no shell     |
| shell / `run_command`        | dangerous | **not registered** (allowlisted cmds only)   |
| git commit/push/checkout/reset | dangerous | **not implemented**                        |

Mutations are not registered tools the model can directly invoke.
They are structured proposals that pass validation, permission,
approval, and controlled mutation before touching disk.

### Phase 3 boundaries (deliberate)

```text
Lunar can:
- inspect repositories
- plan engineering work
- propose changes
- show diffs
- apply approved file changes
- run controlled verification
- diagnose failures
- retry within bounded limits

Lunar cannot:
- perform git commit/push
- execute arbitrary shell commands
- access the network autonomously
- recursively delete directories
- mutate files without the appropriate permission flow
```

## Configuration

Configuration is resolved with the following precedence (highest wins):

```text
CLI arguments
    ↓
environment variables (LUNAR_*)
    ↓
configuration file (~/.lunar/config.json)
    ↓
defaults
```

Environment variables:

| Variable         | Description                                   |
| ---------------- | --------------------------------------------- |
| `LUNAR_PROVIDER` | Provider id (`openai`, `anthropic`, `gemini`) |
| `LUNAR_MODEL`    | Model id                                      |
| `LUNAR_API_KEY`  | API key (never hardcode or commit it)         |
| `LUNAR_DEBUG`    | `true`/`false` debug diagnostics              |

Example `~/.lunar/config.json`:

```json
{
  "provider": "openai",
  "model": "gpt-5",
  "debug": false,
  "engineering": {
    "maxIterations": 3,
    "maxMutations": 20,
    "maxCommands": 10,
    "allowedCommands": ["npm", "node"]
  }
}
```

The optional `engineering` section tunes the Phase 3 loop limits (see
[Phase 3 limits](#phase-3-limits-defaults-all-configurable)). Unknown
keys are rejected so typos surface as errors.

The version shown by `lunar --version`, `lunar doctor`, and the CLI
banners is derived from `package.json` — there is no second hard-coded
copy.

API keys belong in your environment or an untracked config file —
LunarCLI never logs secrets and no keys are committed to this
repository.

## Architecture

Layered so new phases can be added without a rewrite:

```text
src/
├── cli/          CLI entry point, argument parsing, commands
├── app/          Interactive application root (Ink)
├── ui/           Terminal UI components, theme, styles
├── agent/        Agent runtime: loop, context, system prompt, events
├── engineering/  Phase 3: plan, changes, diff, mutation, command,
│                 test-runner, verification, approval, retry, loop
├── conversation/ In-memory conversation history (session-backed)
├── domain/       Types, errors, models — the stable contract
├── config/       Zod schema, defaults, layered config loader
├── providers/    LLM abstraction, registry, HTTP/SSE adapters
├── tools/        Read-only tools, registry, executor, path security
├── git/          Controlled read-only git adapter (no shell)
├── permissions/  Permission manager (risk → allow/deny)
├── workspace/    Workspace + git detection
├── logging/      Leveled logger with secret redaction
└── utils/        Small shared helpers

docs/architecture/
├── agent-loop.md       The tool-call loop and its invariants
├── tools.md            Tool anatomy, the Phase 2 tool set, limits
├── engineering-loop.md Phase 3: plan → propose → approve → verify
└── security.md         Threat model, layered defenses, path security
```

Dependency rule: `cli` and `app` depend on `domain`/`config`/`providers`/`agent`;
the agent depends on `providers` only through the `LLMProvider` interface —
nothing outside `providers/` imports a concrete LLM SDK, and nothing
outside `tools/` touches the filesystem on the model's behalf.

## Development

```bash
npm run dev         # run from source with hot reload via tsx
npm run typecheck   # strict TypeScript check
npm run lint        # ESLint
npm run format      # Prettier
npm test            # Vitest
npm run build       # compile to dist/
```

Quality gates (all must pass before merging):

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

### Security baseline

These rules hold from Phase 0 onward:

- No secrets in logs, code, or the repository
- No shell execution from user input or model output
- Every tool execution goes through risk classification and the
  centralized `PermissionManager`; future approvals and sandboxing
  (Phase 4) plug into the same interface
- In Phase 3, file mutation and command execution are only reachable
  through the validated proposal path — never as direct model tools

## Roadmap

Phases 0–3 are implemented. The following are **future** phases, not
implemented capabilities:

```text
Phase 4 — Safety                          (future)
[ ] Command risk classification (per-command, not per-executable)
[ ] Sandboxed execution
[ ] Interactive permission rules (allowlist per project)

Phase 5 — Memory & Sessions               (future)
[ ] Session persistence
[ ] Long-term memory

Phase 6 — MCP & Integrations              (future)
[ ] MCP client
[ ] IDE integration
[ ] Web research

Phase 7 — Production                      (future)
[ ] Packaging and distribution
[ ] Hardening and telemetry
```

Released phases:

```text
Phase 0 — Foundation                ✓  CLI, UI, config, workspace,
                                       provider abstraction, tests
Phase 1 — Agent Core                ✓  Agent loop, context, streaming,
                                       cancellation, tool-call foundation
Phase 2 — Engineering Tools        ✓  Read-only tools, tool-call loop,
                                       permissions, path security
Phase 3 — Autonomous Loop            ✓  Structured plan, proposed changes,
                                       diff, approval, atomic mutation,
                                       controlled commands, test runner,
                                       verification, bounded retry
```

## Contributing

Issues and pull requests are welcome. Keep changes scoped, add tests for
behavior changes, and make sure `npm run typecheck && npm run lint && npm test && npm run build`
passes. Do not commit secrets.

## License

[MIT](LICENSE)
