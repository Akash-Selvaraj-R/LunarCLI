# LunarCLI

**AI engineering agent for your terminal.**

```text
◐ LUNARCLI
```

LunarCLI is an autonomous AI software-engineering agent that runs directly
inside your developer terminal. You describe what you want in plain
language; Lunar reasons about it with a configured LLM, shows its answer
as it streams, and (in later phases) will inspect your repository, plan
the work, edit files, run tests, and verify the result.

> **Status: Phase 3 — Autonomous Engineering Loop.**
> Lunar can inspect your project with structured, read-only tools AND,
> in explicit `--engineer` mode, run a **bounded autonomous loop**: it
> plans the change, proposes structured file edits, shows you a diff,
> asks for approval, applies atomically, runs controlled verification,
> and — on failure — diagnoses and proposes a fix. Git commit/push and
> unrestricted network access are **not implemented**. See
> [Roadmap](#roadmap).

## Vision

The long-term workflow:

```text
USER REQUEST
     ↓
UNDERSTAND → PLAN → INSPECT → ACT → OBSERVE → VERIFY
     ↓
FIX / ITERATE → COMPLETE
```

The goal is to be able to say:

```bash
lunar "fix the authentication bug and make sure all tests pass"
```

and have Lunar do the work — safely, transparently, and inside your
existing terminal workflow.

## Current Status (Phase 3 — Autonomous Engineering Loop)

Implemented:

- Everything from Phase 2: multi-turn tool loop with read-only tools
  (`list_directory`, `read_file`, `search_files`, `find_files`,
  `git_status`, `git_diff`, `git_log`, `git_branch`), permission
  system, workspace path security
- **Structured plans**: the model produces a Zod-validated
  `EngineeringPlan` (goal + steps) before anything happens; invalid
  output is a controlled error, not prose
- **Proposed changes**: the model proposes `FileChange`s
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
- **Test runner**: repository-aware command detection (`npm test`,
  `cargo test`, `go test ./...`, `pytest`, `make test`), structured
  results (exit code, pass/fail counts when parseable, duration) with
  raw output preserved for diagnosis
- **Verification**: applied changes are confirmed on disk and the test
  command must pass — a successful file write alone is not success
- **Failure diagnosis & bounded retry**: on verification failure the
  model diagnoses (structured, Zod-validated) and proposes a fix that
  re-enters PROPOSE → VALIDATE → APPROVE → APPLY; the loop stops after
  `maxIterations` (default 3) — never `while (true)`
- **Hard limits everywhere**: iterations, mutations per task, command
  executions, command duration, output size, file size — enforced in
  code, configurable in `config.json`
- **Observability**: every phase, approval, mutation, and command
  execution emits an event (with duration), visible with `--debug`

### Usage

```bash
lunar "explain this project"           # one-shot Q&A (unchanged)
lunar "add a health endpoint" --engineer   # autonomous loop (asks before editing)
lunar "add a health endpoint" --engineer --yes  # trusted mode: no prompts
```

### The loop

```text
PLAN → PROPOSE → VALIDATE → PERMISSION → APPLY → DIFF → TEST/VERIFY
                                                          │
                              FAIL → DIAGNOSE → FIX ──────┘ (bounded)
```

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

### Tools

| Tool                           | Risk      | Status                              |
| ------------------------------ | --------- | ----------------------------------- |
| `list_directory`               | safe      | enabled                             |
| `read_file`                    | read-only | enabled                             |
| `file_exists`                  | safe      | enabled                             |
| `search_files`                 | safe      | enabled                             |
| `find_files`                   | safe      | enabled                             |
| `git_status`                   | safe      | enabled                             |
| `git_diff`                     | read-only | enabled                             |
| `git_log`                      | safe      | enabled                             |
| `git_branch`                   | read-only | enabled                             |
| file create/update/delete      | mutating  | via `--engineer` **after approval** |
| shell / `run_command`          | dangerous | **not registered** (allowlisted cmds only) |
| git commit/push/checkout/reset | dangerous | **not implemented**                 |

Mutations are not registered tools the model can call. They are
structured proposals that pass validation → permission → human
approval before a single byte is written.

### Phase 3 boundaries (deliberate)

```text
Lunar can:  inspect the repo, plan, propose edits, apply approved
            edits atomically, run allowlisted verification commands
Lunar can't: commit/push git, run arbitrary shell, access the network,
             delete directories, mutate anything without approval
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
lunar                                # interactive terminal UI
lunar "explain this project"         # one-shot: answer a single question
lunar "add a /health endpoint" --engineer   # autonomous engineering loop
lunar "add a /health endpoint" --engineer --yes  # trusted mode (no prompts)
lunar --help                         # usage
lunar --version                      # version
lunar --debug                        # verbose diagnostics (timings, args)
lunar --cwd <path>                   # operate in a different directory
lunar doctor                         # installation health check
```

Example interactive session (Phase 2):

```text
lunar › what files are in this project?

◐ thinking...

◇ list_directory
  path: .
✓ 12 entries in .

◇ read_file
  package.json

✓ 51 lines in package.json

Lunar › This is a TypeScript CLI project …
```

### Configuration

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

API keys belong in your environment or an untracked config file — LunarCLI
never logs secrets and no keys are committed to this repository.

## Architecture

Layered so Phase 1 can add the agent runtime without a rewrite:

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

From Phase 0 onward, these rules hold:

- No secrets in logs, code, or the repository
- No shell execution from user input or model output
- No LLM shell access, no file modification, no git mutation
- Every tool execution goes through risk classification and the
  centralized `PermissionManager`; future approvals and sandboxing
  (safety phase) plug into the same interface

## Roadmap

```text
Phase 0 — Foundation                ✓
[x] CLI
[x] Terminal UI
[x] Configuration
[x] Workspace detection
[x] Provider abstraction
[x] Testing infrastructure

Phase 1 — Agent Core                ✓
[x] Agent loop
[x] Context management
[x] Conversation state
[x] Provider integration + streaming
[x] Cancellation
[x] Tool-call foundation (no execution)

Phase 2 — Engineering Tools        ✓
[x] Filesystem inspection (list/read/exists)
[x] Search (text search + file finder)
[x] Git inspection (status/diff/log/branch)
[x] Tool-call loop (multi-turn, capped)
[x] Permission system (risk classification)
[x] Workspace path security

Phase 3 — Autonomous Loop            ✓
[x] Structured plan generation (Zod-validated)
[x] Proposed file changes (create/update/delete)
[x] Diff preview (unified, bounded)
[x] Mutation approval (prompt / --yes / deny)
[x] Atomic file mutation (temp → rename)
[x] Controlled command execution (allowlist, no shell)
[x] Repository-aware test runner
[x] Verification (filesystem + tests)
[x] Failure diagnosis (structured, re-enters the loop)
[x] Bounded retry + hard limits

Phase 4 — Safety
[ ] Command risk classification (per-command, not per-executable)
[ ] Sandboxed execution
[ ] Interactive permission rules (allowlist per project)

Phase 5 — Memory & Sessions
[ ] Session persistence
[ ] Long-term memory

Phase 6 — MCP & Integrations
[ ] MCP client
[ ] IDE integration
[ ] Web research

Phase 7 — Production
[ ] Packaging and distribution
[ ] Hardening and telemetry
```

## Contributing

Issues and pull requests are welcome. Keep changes scoped, add tests for
behavior changes, and make sure `npm run typecheck && npm run lint && npm test && npm run build`
passes. Do not commit secrets.

## License

[MIT](LICENSE)
