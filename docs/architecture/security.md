# Security

Lunar's security model rests on one sentence:

> The model can request; Lunar decides.

## Guarantees

```text
Arbitrary shell execution:  NEVER — no exec(string) exists anywhere.
                            Commands are structured executable+args[],
                            allowlisted, shell:false, timeout-bounded.
Filesystem mutation:        CONTROLLED — the model cannot call a write
                            tool. It proposes structured changes that
                            must pass validation → permission → human
                            approval before Lunar's MutationManager
                            writes (atomically, single files only).
Git mutation:               DISABLED — only read-only git inspection
                            (status/diff/log/branch) exists. Commit and
                            push are not implemented at all.
Network access:             NONE — no curl/wget/browser/HTTP tool.
```

These are structural, not policy-text: mutating tools are not
registered, the executor refuses unregistered names, and the
PermissionManager refuses mutating/dangerous risk levels even if a tool
were somehow registered. The only write path is the engineering loop's
validated, approved proposal flow.

## Layered defenses

```text
1. Tool registry        only read-only tools exist as tools
2. PermissionManager    risk policy (centralized): Phase 2 policy for
                        tools; Phase 3 policies for mutations
                        (mutating → ask by default, allow only with
                        --yes; dangerous → always deny)
3. Zod validation       malformed model JSON never reaches a tool or
                        the mutation path; plans/proposals/diagnoses
                        are schema-checked
4. Path security        every filesystem/search path is resolved and
                        containment-checked before any disk access —
                        including proposed mutation targets
5. Change validation    existence rules (update/delete must exist,
                        create must not overwrite), oldContent
                        conflict detection, per-file and per-proposal
                        size caps, duplicate detection
6. Human approval       nothing mutates without an explicit decision
                        (default deny); deletes flagged irreversible
7. Atomic writes        temp file → write → rename; stop-on-first-
                        error; single files only (no directories)
8. Command layer        allowlisted bare executables, spawn with
                        shell:false, workspace-bound cwd, hard
                        timeout with process kill, bounded output
9. Output limits        file size, line range, directory entries,
                        search results, diff size, serialized result
                        cap, command output caps, hard iteration and
                        retry limits
10. Redaction           secrets never appear in logs, errors, failure
                        context sent back to the model, or debug
                        output
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
only. Phase 2 tools only read, so the worst case there is a failed
read. For Phase 3 mutations the same limitation applies to a
not-yet-existing create target: the create is validated lexically, and
the write goes through the same resolved path. The mutation layer
additionally re-stats targets at apply time and refuses non-file
targets (e.g. directories) — a symlink pointing at a directory cannot
be written or deleted as a file. Remaining risk: creating a file
through a dangling symlink whose lexical location is inside the
workspace. Users running `--engineer` in repositories containing
untrusted symlinks should review the diff before approving.

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
Phase 3:                          traversal in proposals (create/update/
                                  delete), create-over-update overwrite,
                                  stale oldContent conflicts, delete
                                  targeting directories, oversized
                                  proposed content, proposal-size and
                                  mutation-budget exhaustion, path
                                  escape via proposed create
commands:                         path-separator executables, absolute
                                  executable paths, non-allowlisted
                                  executables, shell metacharacter
                                  arguments (never interpreted), cwd
                                  escape, cwd-is-a-file, timeout kill,
                                  output-cap kill, argument count/size
approval:                         rejected proposal writes nothing,
                                  default-deny without a handler,
                                  diagnosis required on corrections
```

## What the model sees

The model receives: the system prompt (identity, workspace path, git
branch, tool list), the conversation, and tool results. It does not
receive environment variables, API keys, or any file content it did not
explicitly read through a workspace-bounded tool. API keys never appear
in logs — the logger and error paths redact both key names and
secret-shaped values.
