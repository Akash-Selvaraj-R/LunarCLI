# LunarCLI

**AI engineering agent for your terminal.**

```text
☾ LUNAR
```

LunarCLI is an AI engineering agent that runs in your terminal.

It can inspect a repository, reason about the codebase, create a
structured engineering plan, propose file changes, show a diff, obtain
permission, apply approved changes atomically, run controlled
verification through a full security pipeline, diagnose failures, and
perform bounded corrective iterations.

> **Status: Phase 3 + Phase 4 — Autonomous Loop with Security
> Pipeline.** In explicit `--engineer` mode, Lunar runs a **bounded
> autonomous loop**: it plans the change, proposes structured file
> edits, shows you a diff, asks for approval, applies atomically, runs
> controlled verification (normalized → classified → policy-checked →
> sandbox-constrained), and — on failure — diagnoses and proposes a
> fix. Git commit/push, arbitrary shell, and unrestricted network
> access are **hard-denied**. See [Roadmap](#roadmap).

```text
Current release: v0.5.0
Phase: 4 — Safety & Sandboxing
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
lunar --version                            # version (v0.5.0)
lunar --debug                              # verbose diagnostics (timings, args)
lunar --cwd <path>                         # operate in a different directory
lunar doctor                               # installation health check + security posture
```

- `--engineer` activates the bounded engineering loop: plan → propose →
  validate → approve → apply → verify, with diagnosis and a bounded
  retry on failure. Lunar asks before touching any file.
- `--yes` enables trusted auto-approval: mutations that the permission
  system already considers auto-approvable are applied without a
  prompt, and REVIEW-class commands (dependency installs, builds) are
  auto-approved. DANGEROUS commands (inline code execution, `npx`)
  **still prompt**, and hard-denied commands (shells, `curl`,
  `git push`, …) **stay denied**. It is **not** unrestricted
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

Every verification command passes the Phase 4 security pipeline before
it runs:

```text
CommandRequest
  ↓ normalize      canonical form; paths/NUL/reserved names rejected
  ↓ hard deny      shells, curl/wget, git push/commit, rm, …
  ↓ classify       per-command risk (npm test ≠ npm publish)
  ↓ policy         global + project overlay → allow / ask / deny
  ↓ permission     'ask' → interactive prompt (default deny)
  ↓ sandbox        workspace cwd + FILTERED environment + timeout
  ↓ resolve        bare name → one absolute path (batch files refused)
  ↓ execute        shell:false, process-tree kill on timeout
```

The model never determines whether a command is safe — Lunar does.
See [Security](#security-pipeline-phase-4) below and
`docs/architecture/security.md` for the complete model.

### Limits (defaults; all configurable)

```text
maxIterations            3    corrective attempts per task
maxMutations            20    file writes per task
maxCommands             10    command executions per task
maxConcurrentCommands    1    commands running at the same time
commandTimeoutMs   120000    hard kill after 2 minutes
maxOutputBytes      128000    per stream (stdout/stderr)
maxFileBytes        262144    per mutated file
maxChangesPerProposal   10    per proposal
jsonRetries              2    extra attempts on invalid model JSON
```

## Security pipeline (Phase 4)

Lunar treats the model as **untrusted input**. The model proposes;
Lunar validates, classifies, evaluates policy, requests approval when
required, constrains execution in a sandbox, and only then runs a
command. The security boundary exists outside the model.

### Command classification

Every command is classified by its **normalized form** — executable
AND arguments, never the executable alone (`npm test` and
`npm publish` are different commands):

```text
safe        npm test, npm run lint, cargo test, go test, node --version,
            git status/diff/log/branch
review      npm install, cargo build, python script.py, node script.js,
            unknown executables — require approval (auto-approved
            with --yes)
dangerous   node -e, python -c, npx, npm exec, git config — always
            require explicit approval, even with --yes
denied      bash/sh/cmd/powershell, curl/wget/ssh, git push/commit/
            reset/checkout/merge, rm/del, sudo, taskkill, certutil —
            cannot be overridden by allowlist, project policy, --yes,
            or approval
```

### Policy precedence

```text
1. hard deny        absolute — shells, transfer tools, git mutation
2. global policy    built-in risk → decision mapping
3. project policy   .lunar/policy.json (may tighten, never override
                    hard deny or auto-allow dangerous)
4. user approval    the interactive gate for 'ask' decisions
```

### Environment isolation

Engineering commands never inherit the parent environment. They
receive a minimal allowlist (`PATH`, `HOME`, `TEMP`, …); everything
else is dropped — including `LUNAR_API_KEY` (Lunar's own provider
credentials never reach a command) and any variable that looks
secret-bearing (`*_API_KEY`, `*_TOKEN`, `AWS_*`, …).

### Sandbox

The sandbox is reported honestly — never overstated:

```text
Sandbox: RESTRICTED FALLBACK   workspace-bound cwd, filtered
                               environment, hard timeout with
                               process-tree termination, bounded
                               output. No OS-level filesystem or
                               network isolation.
```

A fail-closed mode is available (`"security": { "sandbox": "deny" }`):
when no full sandbox exists (i.e. always in Phase 4), command
execution is refused outright rather than pretending to be isolated.

### Network

Denied by default. `curl`, `wget`, `ssh` and network transfer tools
are hard-denied; URL-shaped arguments escalate a command's risk. There
is no HTTP tool, no browser, and no configuration value that opens the
network.

### Project command policy (`.lunar/policy.json`)

A repository may ship per-command decisions:

```json
{
  "commands": {
    "npm test": "allow",
    "npm run lint": "allow",
    "npm install": "deny"
  }
}
```

This file is repository content and therefore **untrusted**: it may
tighten decisions or auto-approve REVIEW-class commands, but it can
never override a hard deny or auto-approve a DANGEROUS command.
Malformed policies fail closed — the loop refuses to start.

## Current Status (Phase 3 + Phase 4)

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
  cwd, hard timeouts with process-tree kill, bounded stdout/stderr
  capture
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
  executions, concurrency, command duration, output size, file size —
  enforced in code, configurable in `config.json`
- **Observability**: every phase, approval, mutation, and command
  execution emits an event (with duration), visible with `--debug`
- **Command normalization (Phase 4)**: canonical executable/args/cwd
  before classification; paths, NUL bytes, reserved names, and
  oversized arguments are structurally rejected
- **Per-command risk classification (Phase 4)**: safe/review/
  dangerous/denied evaluated on the normalized command (executable AND
  arguments), with a structured rule table and a hard-deny list that
  cannot be overridden
- **Command policy engine (Phase 4)**: global policy + project policy
  overlay with documented precedence; `--yes` auto-approves only
  REVIEW-class commands and never bypasses a hard deny
- **Project command policy (Phase 4)**: `.lunar/policy.json` (strict
  schema, fail-closed, untrusted — may only tighten or widen review)
- **Environment filtering (Phase 4)**: allowlist-based; secrets and
  Lunar's own credentials never reach a command
- **Sandbox abstraction (Phase 4)**: platform-neutral provider,
  honest security levels (restricted fallback, fail-closed deny mode),
  process-tree termination on timeout
- **Security audit events (Phase 4)**: every command decision emits a
  structured event (proposed → normalized → classified →
  policy_evaluated → permission → sandbox_prepared → started →
  completed/blocked)
- **Expanded approval UX (Phase 4)**: command prompts show risk,
  sandbox, network posture, and a plain-language reason

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
| verification command execution | classified | policy-classified, sandboxed, allowlisted, no shell |
| shell / `run_command`        | dangerous | **not registered** (allowlisted cmds only)   |
| git commit/push/checkout/reset | dangerous | **not implemented**                        |

Mutations are not registered tools the model can directly invoke.
They are structured proposals that pass validation, permission,
approval, and controlled mutation before touching disk.

### Boundaries (deliberate)

```text
Lunar can:
- inspect repositories
- plan engineering work
- propose changes
- show diffs
- apply approved file changes
- run controlled, classified, sandboxed verification
- diagnose failures
- retry within bounded limits

Lunar cannot:
- perform git commit/push (hard-denied)
- execute arbitrary shell commands (shells hard-denied)
- access the network autonomously (denied by default)
- recursively delete directories (rm/del hard-denied)
- read secrets through command execution (environment filtered)
- mutate files without the appropriate permission flow
- let a project policy override a hard deny
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
    "maxConcurrentCommands": 1,
    "allowedCommands": ["npm", "node"]
  },
  "security": {
    "sandbox": "auto",
    "network": "deny",
    "environment": "filtered"
  }
}
```

The optional `engineering` section tunes the loop limits (see
[Limits](#limits-defaults-all-configurable)). The optional `security`
section selects the sandbox enforcement level (`"auto"`/`"restricted"`
use the restricted fallback; `"deny"` refuses execution when no full
sandbox is available), the network policy (only `"deny"` is accepted),
and the environment policy (only `"filtered"` is accepted). Unknown
keys are rejected, and no value can disable a core security boundary.

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
├── engineering/  Phase 3+4: plan, changes, diff, mutation, command,
│                 sandbox, test-runner, verification, approval, retry,
│                 loop
├── security/     Phase 4: normalizer, classifier, policy, project
│                 policy, environment filter, network policy,
│                 executable resolver, settings
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
├── engineering-loop.md Phase 3+4: plan → propose → approve → verify
│                       through the security pipeline
└── security.md         Threat model, command classification, policy
                        precedence, sandbox, environment isolation
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
- No shell execution from user input or model output — commands are
  structured `executable + args[]`, spawned with `shell: false`
- Every tool execution goes through risk classification and the
  centralized `PermissionManager`
- In Phase 3+, file mutation and command execution are only reachable
  through the validated proposal path — never as direct model tools
- In Phase 4, every command passes normalize → classify → policy →
  permission → sandbox → filtered execution; hard-denied commands
  (shells, transfer tools, git mutation, destructive OS operations)
  cannot run regardless of allowlist, project policy, `--yes`, or
  approval
- Engineering commands never inherit the parent environment — Lunar's
  own credentials (`LUNAR_API_KEY`) never reach a command

## Roadmap

Phases 0–4 are implemented. The following are **future** phases, not
implemented capabilities:

```text
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
Phase 4 — Safety & Sandboxing        ✓  Command normalization, per-command
                                       risk classification, command policy
                                       engine, project policy, environment
                                       filtering, sandbox abstraction,
                                       network deny, process-tree
                                       termination, security audit events,
                                       expanded approval UX
```

## Contributing

Issues and pull requests are welcome. Keep changes scoped, add tests for
behavior changes, and make sure `npm run typecheck && npm run lint && npm test && npm run build`
passes. Do not commit secrets.

## License

[MIT](LICENSE)
