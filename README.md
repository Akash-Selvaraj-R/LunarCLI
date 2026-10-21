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

> **Status: Phase 1 — Agent Core.**
> Lunar can now hold real conversations with a configured LLM provider —
> interactively and in one-shot mode — with streaming, cancellation, and
> conversation history. It **cannot** execute commands or modify files;
> it has no tools. See [Roadmap](#roadmap).

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

## Current Status (Phase 1 — Agent Core)

Implemented:

- Interactive conversation with a configured LLM provider
  (`lunar` → `lunar › …`, streamed responses)
- One-shot mode: `lunar "explain this project"` runs the agent once and
  prints the answer
- Agent runtime (`src/agent/`) fully separated from the terminal UI —
  testable without Ink
- Conversation state (in-memory session; history is carried into every
  subsequent request; the session disappears when Lunar exits)
- Context assembly: system prompt + workspace identity + conversation
  history (no file scanning, no repository indexing)
- Real provider adapters over plain HTTP with SSE streaming:
  OpenAI, Anthropic, Google Gemini — plus a deterministic `mock`
  provider for tests and keyless smoke runs
- Structured provider error handling: missing provider, missing API key,
  invalid API key, rate limiting, unsupported model, network failure,
  malformed responses — each with an actionable hint
- Graceful cancellation: Ctrl+C during generation cancels the request
  and returns to the prompt; Ctrl+D exits cleanly
- Tool-calling **foundation** (registry, definitions, call/result types)
  that executes **nothing** — an unexpected model tool call is refused
- Secret redaction in logs, errors, and debug output (key names and
  secret-shaped values)
- Full test suite (unit + driven-terminal interactive tests), strict
  TypeScript, ESLint, Prettier

Not implemented (by design, in later phases): tool execution, shell
access, file modification, planning, autonomous loops, permissions,
memory, MCP.

### Phase 1 limits (deliberate)

```text
Lunar can:  read the context it was given, talk to the model, show answers
Lunar can't: run commands, read/write files, mutate git, browse the web
```

The model receives only the workspace identity (path, git repo/branch)
and the conversation. There is no LLM → shell and no LLM → filesystem
path of any kind.

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
lunar "explain this project" # send a one-shot task to the agent
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
├── tools/        Tool architecture (registry only — nothing executes)
├── workspace/    Workspace + git detection
├── permissions/  Permission engine placeholder (Phase 4)
├── logging/      Leveled logger with secret redaction
└── utils/        Small shared helpers
```

Dependency rule: `cli` and `app` depend on `domain`/`config`/`providers`/`agent`;
the agent depends on `providers` only through the `LLMProvider` interface —
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

From Phase 0 onward, these rules hold:

- No secrets in logs, code, or the repository
- No shell execution from user input
- No LLM shell access, no automatic file modification
- Future tool execution will run behind an explicit `PermissionManager`
  abstraction that cannot be bypassed

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

Phase 2 — Engineering Tools
[ ] File tools
[ ] Search
[ ] Shell execution
[ ] Git tools
[ ] Test runner

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
