# The Engineering Loop (Phase 3)

The engineering loop turns Lunar from "an LLM that can inspect a
repository" into "an agent that can plan a change, propose mutations,
obtain permission, apply them safely, run controlled verification,
diagnose failures, and iterate within hard bounds."

```text
USER ("add a /health endpoint …")
  ↓
PLAN                  Zod-validated EngineeringPlan (goal + steps)
  ↓
PROPOSE               model researches with read-only tools, then
                      replies with structured JSON changes
  ↓
VALIDATE              path safety · existence · conflicts · size caps
  ↓
PERMISSION            PermissionManager risk check → ask/allow/deny
  ↓                    ('ask' → human prompt, default)
APPLY                 MutationManager: atomic writes, stop-on-error
  ↓
DIFF                  unified diff of what just changed (also shown
                      BEFORE apply, as the approval preview)
  ↓
VERIFY                filesystem state + controlled test command
  ↓
  ├─ PASS → LUNAR COMPLETE
  ↓ FAIL
DIAGNOSE              model produces a structured diagnosis
  ↓                    (never mutates by itself)
FIX                   corrective proposal → re-enters PROPOSE
  ↓
VERIFY again          …bounded by maxIterations (default 3)
```

## Module layout

```text
src/engineering/
├── limits.ts        Hard caps (iterations, mutations, commands, sizes)
├── plan.ts          EngineeringPlan/PlanStep schemas + progress helpers
├── operations.ts    FileOperation (create/update/delete)
├── changes.ts       FileChange schema + validation (reuses path security)
├── proposal.ts      ChangeProposal schema (summary + diagnosis + changes)
├── diff.ts          Unified diff (bounded LCS, context hunks)
├── mutation.ts      MutationManager (atomic writes, single files only)
├── command.ts       CommandExecutor (allowlist, no shell, timeout, caps)
├── test-runner.ts   Repo-aware test command detection + TestSummary
├── verification.ts  VerificationManager (filesystem + tests)
├── retry.ts         RetryController (explicit, bounded counter)
├── json.ts          extractJsonObject / parseModelJson (Zod-validated)
├── approval.ts      ApprovalHandler (auto / deny / readline [y/N])
├── prompts.ts       Phase prompts (plan, proposal, correction)
├── events.ts        EngineeringEvent union (observability)
└── loop.ts          EngineeringLoop orchestrator
```

## The safety chain (unchanged from Phase 2)

```text
LLM → structured tool request → validation → permission/risk check
    → controlled execution → observable result
```

Phase 3 does not add a second execution system. Research reuses the
Phase 2 `AgentRuntime` with the read-only tool registry; mutations are
**not tools the model can call** — they are structured proposals that
pass through validation → the same centralized `PermissionManager`
(extended with Phase 3 policies) → a human approval gate → the
`MutationManager`, the single code path that writes to disk.

```text
NEVER:  LLM → exec(modelOutput)
NEVER:  model → filesystem directly
ALWAYS: proposal → validate → approve → apply → verify
```

## Key invariants

1. **Structured model output is validated.** Every phase response is
   parsed with `parseModelJson` (Zod). Malformed or schema-violating
   output produces a controlled error and a bounded correction retry
   (`jsonRetries`), never a crash and never a silent skip.
2. **No mutation without approval.** The default policy is
   `PHASE3_ASK_POLICY` (mutating → `ask`); the loop consults an
   `ApprovalHandler`. `PHASE3_AUTO_POLICY` exists only for an explicit
   `--yes`. Deletes are called out as irreversible.
3. **Writes are atomic.** Temp file in the same directory → write →
   rename. A crash mid-write never leaves a half-written target.
4. **Every dimension is bounded.** `maxIterations` (3), `maxMutations`
   (20), `maxCommands` (10), `commandTimeoutMs` (120 s), output and
   file size caps. The loop enforces them in code — it never relies on
   the model to stop.
5. **Commands are structured.** `executable + args[]`, bare allowlisted
   executables only, `spawn` with `shell: false`, workspace-bound cwd,
   hard kill on timeout, bounded stdout/stderr capture. There is no
   `exec(string)` anywhere.
6. **Verification is real.** Success requires the applied changes to
   exist on disk AND the detected (or configured) test command to exit
   0. A green file write alone is not success.
7. **Diagnosis never mutates.** A failure diagnosis only becomes a new
   proposal, which re-enters the full PROPOSE → VALIDATE → APPROVE →
   APPLY path.
8. **Everything is observable.** Each phase, approval, mutation, and
   command execution emits an `EngineeringEvent`; mutations and
   commands log duration, target, and outcome for `--debug`.

## Test command detection

The loop never invents verification commands. It detects one from the
repository, in order: `package.json` `test` script (skipping the npm
placeholder) → `Cargo.toml` → `go.mod` → `pytest.ini`/`pyproject.toml`
→ `Makefile` `test:` target. When nothing is detected, verification
falls back to filesystem checks only (and says so). A command can be
injected explicitly (`testCommand`) for tests and trusted setups.

## What Phase 3 deliberately does NOT do

- git commit / git push (the user owns repository history)
- unrestricted network access (no curl/wget/browser/HTTP tools)
- recursive directory deletion
- multi-agent systems, memory, MCP, plugins
