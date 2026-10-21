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

> **Status: Phase 2 — Engineering Tools.**
> Lunar can hold real conversations with a configured LLM provider and
> now **inspect your project through structured, read-only tools** —
> list directories, read files, search text, find files, and inspect
> git state — with a multi-turn tool loop, permission gating, and
> workspace boundaries. It **cannot** execute commands or modify
> anything; those tools do not exist. See [Roadmap](#roadmap).

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

## Current Status (Phase 2 — Engineering Tools)

Implemented:

- Interactive conversation with a configured LLM provider
  (`lunar` → `lunar › …`, streamed responses) and one-shot mode
  (`lunar "explain this project"`)
- **Tool calling**: the model can request read-only inspection tools,
  Lunar validates and executes them, results go back to the model, and
  the model continues reasoning — multiple tool rounds per request,
  hard-capped (20 rounds) so a loop can never run away
- **Filesystem inspection**: `list_directory`, `read_file` (with line
  ranges and size limits), `file_exists`
- **Search**: `search_files` (fixed-string; ripgrep when installed,
  controlled Node fallback otherwise) and `find_files` (glob or name
  substring) — both workspace-bounded and result-capped
- **Git inspection**: `git_status`, `git_diff` (size-capped with
  truncation notice), `git_log` (bounded), `git_branch` — read-only,
  via a fixed-argument adapter that never uses a shell
- **Permission system**: every tool carries a risk level
  (safe/read-only/mutating/dangerous); a centralized
  `PermissionManager` allows safe+read-only and denies
  mutating+dangerous
- **Workspace path security**: realpath-based containment checks that
  stop `../` traversal, absolute-path escapes, foreign Windows drives,
  and symlink/junction escapes
- Tool activity is visible in the terminal (`◇ tool` / `✓ result`);
  `--debug` shows per-tool arguments (redacted), duration, and result
  size
- Tool failures are structured (`file_not_found`, `invalid_input`,
  `path_outside_workspace`, …) and become tool results the model can
  react to — a failing tool never crashes the agent
- Provider tool formats (OpenAI `tool_calls`, Anthropic
  `tool_use`/`tool_result`, Gemini `functionCall`/`functionResponse`)
  are mapped inside provider adapters only
- Everything from Phase 1: streaming, cancellation (Ctrl+C during model
  requests _and_ tool execution), conversation history, structured
  errors, secret redaction, deterministic tests

### Tools

| Tool                           | Risk      | Status       |
| ------------------------------ | --------- | ------------ |
| `list_directory`               | safe      | enabled      |
| `read_file`                    | read-only | enabled      |
| `file_exists`                  | safe      | enabled      |
| `search_files`                 | safe      | enabled      |
| `find_files`                   | safe      | enabled      |
| `git_status`                   | safe      | enabled      |
| `git_diff`                     | read-only | enabled      |
| `git_log`                      | safe      | enabled      |
| `git_branch`                   | read-only | enabled      |
| shell / `run_command`          | dangerous | **disabled** |
| `write_file` / `edit_file`     | mutating  | **disabled** |
| `delete_file`                  | mutating  | **disabled** |
| git commit/push/checkout/reset | dangerous | **disabled** |

Disabled tools do not exist as registered tools at all: a model that
requests one receives a structured "unknown tool" result, and nothing
happens on your machine.

### Phase 2 limits (deliberate)

```text
Lunar can:  list/read/search files in the workspace, inspect git state
Lunar can't: run commands, write/edit/delete files, mutate git
```

The model receives only the workspace identity (path, git repo/branch),
the conversation, and the output of tools it invoked — all resolved
inside the workspace. There is no LLM → shell and no LLM → filesystem
mutation path of any kind. See [docs/architecture/security.md](docs/architecture/security.md).

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
lunar "explain this project" # one-shot: answer a single question
lunar --help                # usage
lunar --version             # version
lunar --debug               # verbose diagnostics (incl. tool timings)
lunar --cwd <path>          # operate in a different directory
lunar doctor                # installation health check
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
├── agent/        Agent runtime: loop, context, system prompt, events
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
├── agent-loop.md The tool-call loop and its invariants
├── tools.md      Tool anatomy, the Phase 2 tool set, limits
└── security.md   Threat model, layered defenses, path security
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

Phase 3 — Autonomous Loop
[ ] Observe → Act → Verify loop
[ ] Failure recovery
[ ] Automatic debugging
[ ] Task completion verification

Phase 4 — Safety
[ ] Permission engine
[ ] Command risk classification
[ ] Approval flows
[ ] Sandboxed execution

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
