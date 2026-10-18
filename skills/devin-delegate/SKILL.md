---
name: devin-delegate
description: >-
  Delegate a coding task to the Devin CLI (`devin`) as a background implementer, then review its
  diff and land it yourself. Use this whenever the user wants to hand implementation work to Devin -
  phrasings like "have Devin implement X", "delegate this to Devin", "run it through the Devin CLI",
  or "use Devin to implement/fix/refactor" - or wants to run a queue of coding tasks through Devin
  while staying the reviewer. DO NOT USE for tasks small enough to do inline, when the user wants
  the code written directly without delegating, or for Devin cloud sessions.
license: MIT
compatibility: Requires the `devin` CLI installed and signed in (`devin auth login`, confirmed with `devin auth status`), Node 18+, and git. The orchestrator must be able to run shell commands and read files.
metadata:
  version: 0.5.0
---

# Devin Delegate

You are the **orchestrator**. Delegate a bounded coding task to a separate **implementer**, the local
Devin CLI, then review what it produced and land it yourself. You write the brief and own the
judgment; Devin makes changes in its own session in the working tree; you verify and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- The `devin` CLI is not installed or not signed in.
- You want a Devin cloud session (`--cloud`). This skill drives the local agent only, so the diff
  lands in a working tree you can review.
- The brief needs Devin itself to run the gates (tests, builds) and you cannot opt in to a wider
  permission mode. See [Autonomy and permissions](#autonomy-and-permissions).

## Prerequisites (check once)

1. Install the Devin CLI and confirm `devin --version` succeeds.
2. Sign in with `devin auth login`; confirm with `devin auth status`.
3. Work in, or point `--cd` at, the target git repository.

## Choose the model

The relay always passes `--model`, and defaults to `swe-2-high`. The SWE-2 ids `swe-2-high`,
`swe-2-medium`, and `swe-2-max` are the ones `devin models list` tags `Free`; most other models are
billed from the account's credits. The relay refuses any model outside that list unless you add
`--allow-paid`, so a run never spends credits by accident. Aliases such as `swe` are not on the
list; pass the exact id. Run `devin models list` to see what your account offers and what it costs.
Only pass `--allow-paid` when the human asked for a paid model.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write a brief

Devin sees only the text you send. It cannot read your conversation: the brief must stand alone
with the goal, current state, what to change, what to leave untouched, and a report contract. Keep
each brief to a single task. Under the default permission mode Devin can edit files with its file
tools and run read-only commands, but not shell commands that write files or run test runners: tell
it to edit only with its file tools, not to run the gates, and run them yourself in review. Write
the brief to a file and pass it as `--brief`. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

For **Codex orchestration of background work**, install and configure the separate
**codex-background** support utility first. If its MCP tools or registry are missing, stop and
report the setup requirement; do not silently fall back to model-driven polling. Then invoke its
registered `delegate_run` MCP tool once in place of the shell example below.
Follow that skill for structured common arguments, unchanged provider flags and reattachment by
runId. Keep the request pending until completion, then continue this skill's review and landing
steps. Other orchestrators keep the shell workflow below.

Use the bundled relay. It runs `devin -p --prompt-file <brief>` in print mode, exports Devin's
trajectory, and writes `result.json`.

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# choose a free model:               add --model swe-2-medium
# choose a paid model:               add --model <id> --allow-paid   (spends credits)
# read-only answer or review pass:   add --read-only  (permission mode auto)
# hard time limit (watchdog):        add --timeout 2h   (the 30m default suits brief runs)
# resume a session:                  add --session <id>  or  --resume-last
# see all options:                   node .../relay.mjs --help
```

The child's cwd pins the workspace. The relay writes artifacts under the system temp dir by
default and never commits. See [references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

Codex using codex-background keeps the original MCP request pending: no model-driven sleep,
status or log polling. Use `delegate_wait` only to reattach after an interrupted request.

The relay blocks until Devin finishes. Run it with the orchestrator's background-command facility,
or background it in the shell and poll for `result.json`. A pre-run usage error (including a paid
model without `--allow-paid`) exits 2 and writes no result; a missing `devin` exits 127 and writes
`status: "devin_unavailable"`.

Completion means the process exited and `result.json` exists. Devin's printed response is the
`finalMessage` field of `result.json`.

### 4. Review - do not trust the self-report

- Re-run the project's gates yourself.
- Read the diff against the brief, starting with `touchedFiles`.
- Run relevant guard skills if installed.

See [references/review-and-land.md](references/review-and-land.md).

### 5. Land it

If the work is good, commit it. The relay never commits; the diff and `result.json` are the record.
Run `git status` and `git diff` first to confirm exactly what changed. If the diff is wrong or
incomplete, re-dispatch a corrected brief and review again.

## Autonomy and permissions

The relay maps onto Devin's own `--permission-mode`:

- **Write run (default): `accept-edits`.** Devin auto-approves read-only tools and workspace edits.
- **`--read-only`: `auto`.** Devin auto-approves read-only tools only.
- **`--permission-mode smart`** additionally auto-runs actions a fast model judges safe, and
  **`--permission-mode dangerous`** auto-approves all tools, including shell commands that can
  commit, push, or write outside the repository. Both are explicit per-dispatch opt-ins; neither is a
  default or a lane dial.

Print mode cannot ask for confirmation. When Devin wants a tool its mode does not approve, it
rejects the call, prints a warning on stderr, and ends the run with exit 0 and no response. The
relay detects that and reports `status: "failed"` with an `error` that says so. Under `accept-edits`
read-only commands such as `git status` run, but in live runs a file write through the shell
(`printf ... > file`) and a test-runner style command were rejected, and `smart` rejected the
latter too in one attempt. Brief Devin to edit only with its file tools, and plan for the
orchestrator to run the gates.

`--read-only` is Devin's own classification of read-only tools; the relay does not add a separate
write tripwire. Dispatch read-only work from a clean tree and expect `touchedFiles: []`.

Devin also has a `--sandbox` flag (research preview) that restricts shell-command writes to the
workspace. This relay does not pass it.

Print mode also cannot show Devin's workspace trust prompt and fails in an untrusted directory, so
the relay always passes `--respect-workspace-trust false`. Dispatching to `--cd` is the trust
decision: only point it at a tree whose Devin rules and skills you are willing to load.

## Authorization model

Delegation is something the human opts into. Once briefed, Devin works as a tool you approved use
of. The boundary is: **do not accept conclusions from the self-report**; verify everything on disk.
Paid models and the `smart` or `dangerous` modes are the human's call, not yours. For anything
touching credentials, production data, or irreversible operations, stop and ask the human first.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - structure, scope, gates,
  brief delivery.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - flags, the model guard,
  artifacts, `result.json`, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) - what to verify before calling
  the diff done.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues,
  constraint carry-forward, progress tracking, and the final coherence pass.
