# LunarCLI

**AI engineering agent for your terminal.**

```text
◐ LUNARCLI
```

LunarCLI is an autonomous AI software-engineering agent that runs directly
inside your developer terminal. You describe what you want in plain
language; Lunar inspects your repository, plans the work, edits files, runs
tests, diagnoses failures, and verifies the result.

> **Status: Phase 0 — Foundation.**
> The autonomous coding runtime is **not implemented yet**. Today LunarCLI
> gives you a working CLI, an interactive terminal UI, configuration,
> workspace detection, and the provider/agent abstractions that later
> phases build on. See [Roadmap](#roadmap).

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

## Current Status (Phase 0 — Foundation)

Implemented:

- `lunar` launches an interactive terminal UI (Ink + React)
- `lunar --help` / `--version` / `--debug` / `--cwd <path>`
- `lunar "task"` accepts a task and acknowledges it (no execution yet)
- `lunar doctor` installation sanity check
- Workspace + Git repository detection (branch, project root)
- Zod-validated configuration with clear precedence
  (CLI → environment → config file → defaults)
- Provider-independent LLM abstraction with a registry and
  Phase 0 stubs for OpenAI, Anthropic, and Gemini
- Structured error hierarchy and leveled logging with secret redaction
- Domain types for sessions, messages, tasks, and tools (Phase 1 contract)
- Full test suite, strict TypeScript, ESLint, Prettier

Not implemented (by design, in later phases): the agent loop, tool
execution, file modification, shell access, permissions, memory, MCP.

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
lunar                       # interactive terminal UI
lunar --help                # usage
lunar --version             # version
lunar --debug               # verbose diagnostics on stderr
lunar --cwd <path>          # operate in a different directory
lunar doctor                # installation health check
lunar "fix the auth bug"    # acknowledge a task (execution: Phase 1)
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
  "debug": false
}
```

API keys belong in your environment or an untracked config file — LunarCLI
never logs secrets and no keys are committed to this repository.

## Architecture

Layered so Phase 1 can add the agent runtime without a rewrite:

```text
src/
├── cli/          CLI entry point, argument parsing, commands
├── app/          Interactive application root (Ink)
├── ui/           Terminal UI components, theme, styles
├── domain/       Types, errors, models — the stable contract
├── config/       Zod schema, defaults, layered config loader
├── providers/    LLM abstraction, registry, Phase 0 stubs
├── workspace/    Workspace + git detection
├── permissions/  Permission engine placeholder (Phase 4)
├── logging/      Leveled logger with secret redaction
└── utils/        Small shared helpers
```

Dependency rule: `cli` and `app` depend on `domain`/`config`/`providers`;
nothing outside `providers/` imports a concrete LLM SDK.

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

Even in Phase 0 these rules hold:

- No secrets in logs, code, or the repository
- No shell execution from user input
- No LLM shell access, no automatic file modification
- Future tool execution will run behind an explicit `PermissionManager`
  abstraction that cannot be bypassed

## Roadmap

```text
Phase 0 — Foundation
[x] CLI
[x] Terminal UI
[x] Configuration
[x] Workspace detection
[x] Provider abstraction
[x] Testing infrastructure

Phase 1 — Agent Core
[ ] Agent loop
[ ] Context management
[ ] Planning
[ ] Tool calling
[ ] Conversation state

Phase 2 — Engineering Tools
[ ] File tools
[ ] Search
[ ] Shell execution
[ ] Git tools
[ ] Test runner

Phase 3 — Autonomous Engineering
[ ] Observe → Act → Verify loop
[ ] Failure recovery
[ ] Automatic debugging
[ ] Task completion verification

Phase 4 — Safety
[ ] Permission engine
[ ] Command risk classification
[ ] Approval flows
[ ] Sandboxed execution

Phase 5 — Advanced
[ ] MCP
[ ] Memory
[ ] Multiple agents
[ ] Web research
[ ] Worktrees
[ ] Session persistence
```

## Contributing

Issues and pull requests are welcome. Keep changes scoped, add tests for
behavior changes, and make sure `npm run typecheck && npm run lint && npm test && npm run build`
passes. Do not commit secrets.

## License

[MIT](LICENSE)
