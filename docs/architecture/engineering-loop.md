# The Engineering Loop (Phase 3 + Phase 4 security)

The engineering loop turns Lunar from "an LLM that can inspect a
repository" into "an agent that can plan a change, propose mutations,
obtain permission, apply them safely, run controlled verification,
diagnose failures, and iterate within hard bounds."

Phase 4 strengthens the execution boundary: every command now passes
through a full security pipeline — normalization → classification →
policy → permission → sandbox → filtered execution — before anything
spawns. See `docs/architecture/security.md` for the complete model.

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
  ↓                    (Phase 4: normalize → classify → policy →
  ↓                     permission → sandbox → filtered spawn)
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
├── command.ts       CommandExecutor (Phase 4 pipeline: normalize →
│                    classify → policy → permission → sandbox → spawn)
├── sandbox.ts       SandboxProvider abstraction (restricted fallback,
│                    fail-closed deny mode, process-tree termination)
├── test-runner.ts   Repo-aware test command detection + TestSummary
├── verification.ts  VerificationManager (filesystem + tests)
├── retry.ts         RetryController (explicit, bounded counter)
├── json.ts          extractJsonObject / parseModelJson (Zod-validated)
├── approval.ts      ApprovalHandler (auto / deny / readline [y/N])
│                    + CommandApprovalHandler (Phase 4: risk, sandbox,
│                    network posture in the prompt)
├── prompts.ts       Phase prompts (plan, proposal, correction)
├── events.ts        EngineeringEvent union (observability, Phase 4
│                    command security events)
└── loop.ts          EngineeringLoop orchestrator

src/security/        Phase 4 security pipeline
├── normalizer.ts    Command normalization (canonical form, structural
│                    rejection of paths, NUL, reserved names)
├── classifier.ts    Per-command risk classification (executable AND
│                    arguments, hard-deny list, structured rules)
├── policy.ts        CommandPolicy (global + project overlay,
│                    precedence, --yes trusted mode)
├── project-policy.ts .lunar/policy.json loader (fail-closed, strict)
├── environment.ts   Allowlist-based environment filtering
├── network-policy.ts Deny-by-default network policy
├── executable-resolver.ts Bare name → absolute path (no TOCTOU,
│                    batch files fail closed)
└── settings.ts      SecuritySettings resolver
```

## The safety chain

```text
Phase 2:  LLM → structured tool request → validation → permission
          → controlled execution → observable result

Phase 4 (commands): CommandRequest → normalize → classify → policy
          → permission → sandbox (filtered env, workspace cwd, timeout)
          → resolve (absolute path) → spawn (shell:false)
          → observable result
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
NEVER:  command without normalization → classification → policy
ALWAYS: proposal → validate → approve → apply → verify
ALWAYS: command → normalize → classify → policy → sandbox → execute
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
   (20), `maxCommands` (10), `maxConcurrentCommands` (1),
   `commandTimeoutMs` (120 s), output and file size caps. The loop
   enforces them in code — it never relies on the model to stop.
5. **Commands are structured and classified.** `executable + args[]`,
   bare allowlisted executables only, normalized and classified before
   policy evaluation, `spawn` with `shell: false`, filtered
   environment, workspace-bound cwd, hard process-tree kill on
   timeout, bounded stdout/stderr capture. There is no `exec(string)`
   anywhere. Hard-denied commands (shells, curl, git push, …) cannot
   run regardless of allowlist, project policy, `--yes`, or approval.
6. **The environment is filtered.** Engineering commands receive a
   minimal allowlist (PATH, HOME, TEMP, …) — not the parent
   environment. Lunar's own credentials (LUNAR_API_KEY) never reach a
   command.
7. **Verification is real.** Success requires the applied changes to
   exist on disk AND the detected (or configured) test command to exit
   0. A green file write alone is not success.
8. **Diagnosis never mutates.** A failure diagnosis only becomes a new
   proposal, which re-enters the full PROPOSE → VALIDATE → APPROVE →
   APPLY path.
9. **Everything is observable.** Each phase, approval, mutation, and
   command execution emits an `EngineeringEvent`; the Phase 4 command
   pipeline emits structured audit events (proposed → normalized →
   classified → policy_evaluated → permission → sandbox_prepared →
   started → completed/blocked) visible in `--debug` and the CLI.

## Test command detection

The loop never invents verification commands. It detects one from the
repository, in order: `package.json` `test` script (skipping the npm
placeholder) → `Cargo.toml` → `go.mod` → `pytest.ini`/`pyproject.toml`
→ `Makefile` `test:` target. When nothing is detected, verification
falls back to filesystem checks only (and says so). A command can be
injected explicitly (`testCommand`) for tests and trusted setups.
Every detected or injected command passes the full Phase 4 security
pipeline before execution.

## What the loop deliberately does NOT do

- git commit / git push (hard-denied by the classifier; the user owns
  repository history)
- unrestricted network access (network denied by default; no
  curl/wget/browser/HTTP tools; URL arguments escalate risk)
- arbitrary shell execution (no exec(string); shell interpreters are
  hard-denied)
- recursive directory deletion
- autonomous credential access (environment is filtered; LUNAR_API_KEY
  never reaches a command)
- multi-agent systems, memory, MCP, plugins
