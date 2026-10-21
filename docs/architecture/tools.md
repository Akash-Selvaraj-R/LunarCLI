# Tools

Phase 2 gives Lunar a small, composable, strictly read-only tool set.
Tools live in `src/tools/`; the registry is the single source of truth
for what the model can request.

## Tool anatomy

```ts
interface Tool {
  name: string
  description: string // provider-facing, includes the risk level
  risk: ToolRisk // safe | read_only | mutating | dangerous
  inputSchema: ZodType // raw model JSON is validated before execute
  execute(call, context): Promise<ToolResult>
  summarize?(call, result): string // one-line UI summary
}
```

- **Zod first**: raw model arguments are parsed with the tool's Zod
  schema inside the executor. Malformed input (`{"path": 123}`) never
  reaches `execute`.
- **JSON Schema for providers**: the registry derives each tool's
  provider-facing JSON Schema from its Zod schema (`z.toJSONSchema`), so
  the schema exists exactly once.
- **Structured results**: tools return structured output (objects, not
  pre-formatted strings); serialization for the model happens in one
  place (`serialize.ts`), bounded by a character cap with an explicit
  truncation marker.

## The Phase 2 tool set

| Tool             | Risk      | What it does                                              |
| ---------------- | --------- | --------------------------------------------------------- |
| `list_directory` | safe      | List a directory (bounded depth and entry count)          |
| `read_file`      | read-only | Read a text file (size limits, optional line range)       |
| `file_exists`    | safe      | Check whether a path exists and its type                  |
| `search_files`   | safe      | Fixed-string text search (ripgrep or Node fallback)       |
| `find_files`     | safe      | Find files by glob or name substring                      |
| `git_status`     | safe      | Branch, clean flag, staged/unstaged/untracked lists       |
| `git_diff`       | read-only | Current uncommitted diff (size-capped, truncation notice) |
| `git_log`        | safe      | Recent commits (default 10, max 50)                       |
| `git_branch`     | read-only | Local branches and the current branch                     |

Tools that do **not** exist — and are not registered anywhere:

```text
shell / run_command / exec        write_file / edit_file / create_file
delete_file / move_file / copy_file
git commit / git push / git checkout / git reset
```

A model that requests one of these gets a `tool_not_found` failure as a
tool result. It cannot run, because it does not exist and the executor
refuses unregistered names.

## The executor is the only path

```text
ToolCall → registry.require(name) → permissions.check(risk)
  → Zod parse → tool.execute → serialize (bounded)
```

No code path invokes a `Tool` without going through `ToolExecutor`.
Tool failures (unknown tool, denied, invalid input, not found, output
limit, cancelled) are returned as failed `ToolResult`s with a machine-
readable `kind` so the model can adapt ("file not found — try another
path") instead of the turn dying.

## Search implementation notes

- `search_files` prefers ripgrep when installed, spawned with a fixed
  argument vector (`shell: false`), the query passed after `-e` and the
  root after `--` so it can never be read as an option or command. A
  controlled Node.js walker provides identical fixed-string semantics
  when ripgrep is absent.
- All searches are workspace-bounded, result-capped, and skip
  `.git`/`node_modules`. Nothing the model supplies becomes a command
  line.

## Git implementation notes

- Git tools go through `src/git/runner.ts`, which spawns the `git`
  executable with an explicitly constructed argument array, never a
  shell, with a timeout, an output cap, and abort support.
- There is deliberately **no generic runCommand export** — the module
  knows the `git` executable and nothing else.
