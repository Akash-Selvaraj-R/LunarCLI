# Security

Lunar's Phase 2 security model rests on one sentence:

> The model can request; Lunar decides.

## Guarantees

```text
Shell execution:        DISABLED — no tool runs a shell or process
                        command the model influences.
Filesystem mutation:    DISABLED — no write/edit/delete/move/copy tool
                        exists.
Git mutation:           DISABLED — only read-only git inspection
                        (status/diff/log/branch) exists.
```

These are structural, not policy-text: the tools are not registered,
the executor refuses unregistered names, and the PermissionManager
refuses mutating/dangerous risk levels even if a tool were somehow
registered.

## Layered defenses

```text
1. Tool registry        only read-only tools exist at all
2. PermissionManager    risk policy: safe/read_only → allow,
                        mutating/dangerous → deny (centralized)
3. Zod validation       malformed model JSON never reaches a tool
4. Path security        every filesystem/search path is resolved and
                        containment-checked before any disk access
5. Output limits        file size, line range, directory entries,
                        search results, diff size, serialized result
                        cap, and a hard tool-iteration limit
6. Redaction            secrets never appear in logs, errors, or debug
                        output (key names and secret-shaped values)
```

## Workspace path security

`resolveWorkspacePath` (in `src/tools/path-security.ts`) is the only
door to the filesystem:

- Relative paths resolve against the workspace root; the resolved
  candidate must be contained in the root (`path.relative` — correct on
  Windows drives and separators, not POSIX-only assumptions).
- Symlinks/junctions are resolved with `realpath` (or the nearest
  existing ancestor for not-yet-existing paths) and containment is
  re-checked against the _real_ root — a symlink inside the workspace
  pointing outside is rejected.
- On Windows, containment compares case-folded paths, matching the
  case-insensitive filesystem.
- NUL bytes and empty paths are rejected outright.

**Documented limitation**: a symlink whose _target_ does not exist
cannot be realpath-resolved, so such paths are validated lexically
only. Phase 2 tools only read, so the worst case is a failed read —
never a write outside the workspace. This limitation will be revisited
when mutation tools arrive in a later phase.

## Attack coverage

The test suite includes explicit attack cases (not just happy paths):

```text
../ and ../../ traversal          absolute outside paths
Windows foreign drive letters     backslash traversal
symlink/junction escapes          NUL bytes and empty paths
malformed tool arguments          unknown/unregistered tools
mutating tools (even registered)  tool-loop overflow
oversized files/dirs/searches     secret redaction in tool errors
secret leakage across the loop    cancellation during tool execution
```

## What the model sees

The model receives: the system prompt (identity, workspace path, git
branch, tool list), the conversation, and tool results. It does not
receive environment variables, API keys, or any file content it did not
explicitly read through a workspace-bounded tool. API keys never appear
in logs — the logger and error paths redact both key names and
secret-shaped values.
