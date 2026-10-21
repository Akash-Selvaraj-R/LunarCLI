# The Agent Loop

The agent loop is the heart of Lunar: it turns one user request into a
sequence of model calls and tool executions, then a final answer.

```text
USER
  ↓
AGENT RUNTIME
  ↓
LLM PROVIDER  (streaming, abortable)
  ↓
normalized ToolCall[]?
  ├─ no  → final answer → UI → done
  ↓ yes
TOOL REGISTRY        (does the tool exist?)
  ↓
PERMISSION MANAGER   (may it run, given its risk level?)
  ↓
TOOL EXECUTOR        (Zod validation → execute → bounded output)
  ↓
TOOL RESULT          (success or structured failure)
  ↓
appended to conversation history
  ↓
LLM PROVIDER again   (the model reasons over the result)
```

## Invariants

1. **The LLM never directly executes anything.** It can only _request_ a
   tool by returning a normalized `ToolCall`. Lunar decides whether that
   request executes.
2. **Every round-trip is capped.** `maxToolIterations` (default 20)
   bounds the number of tool rounds per user request. When the cap is
   reached the agent says so and stops — it never loops forever.
3. **Failures never crash the loop.** A failing tool produces a failed
   `ToolResult` (file not found, invalid input, permission denied…)
   which becomes conversation history the model can react to. Only
   provider failures end the turn with an error.
4. **Cancellation is end-to-end.** Ctrl+C aborts the in-flight provider
   request _or_ tool execution through a shared `AbortSignal`; the turn
   resolves as `cancelled` and the UI returns to the prompt.
5. **System instructions stay separate.** The system prompt is
   assembled once per run and prepended at call time; it is never
   mutated by tool results. Tool results live only in conversation
   history.

## Conversation shape

A turn with tools looks like this in history (provider-neutral):

```text
SYSTEM    "You are Lunar …"
USER      "Find the auth files and explain login."
ASSISTANT (tool call: find_files)
TOOL      {"paths": ["src/auth/login.ts", …]}
ASSISTANT (tool call: read_file)
TOOL      {"content": "…", "lineCount": 184}
ASSISTANT "Login works by …"
```

Provider adapters translate this shape into each provider's wire
format (OpenAI `tool_calls`/`tool` messages, Anthropic
`tool_use`/`tool_result` content blocks, Gemini
`functionCall`/`functionResponse` parts). That translation lives
entirely inside `src/providers/` — the runtime does not know which
provider produced a tool call.

## Events

The runtime emits a small closed set of events for the UI: `status`
(idle/thinking/responding), `delta` (streamed text), `tool_call`,
`tool_result`, `response`, `error`, `cancelled`. The UI renders; the
agent never does.
