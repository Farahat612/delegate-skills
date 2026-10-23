---
name: hermes-delegate
description: >-
  Delegate a coding task to Hermes Agent (`hermes`) as a background implementer, then review its
  diff and land it yourself. Use this whenever the user wants to hand implementation work to Hermes -
  phrasings like "have Hermes implement X", "delegate this to Hermes", "run it through Hermes Agent",
  or "use Hermes to implement/fix/refactor" - or wants to run a queue of coding tasks through Hermes
  while staying the reviewer. DO NOT USE for tasks small enough to do inline, when the user wants
  the code written directly without delegating, or for chatting with Hermes, its gateway, cron jobs,
  or messaging platforms.
license: MIT
compatibility: Requires the `hermes` CLI (Hermes Agent) installed with a model provider signed in (`hermes model` or `hermes auth add <provider>`, confirmed with `hermes status`), Node 18+, and git. The orchestrator must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.5.0
---

# Hermes Delegate

You are the **orchestrator**. Delegate a bounded coding task to a separate **implementer**, the local
Hermes Agent CLI, then review what it produced and land it yourself. You write the brief and own the
judgment; Hermes edits the working tree in its own session; you verify and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- The `hermes` CLI is not installed, or no model provider is signed in.
- You need a read-only answer or review pass that is **enforced**. Hermes has no read-only mode and no
  sandbox, so the relay refuses `--read-only`. Use an implementer that has one.
- You want Hermes's messaging gateway, cron jobs, or chat surfaces. This skill drives one coding
  run in a working tree.

## Prerequisites (check once)

1. Install Hermes Agent and confirm `hermes --version` succeeds.
2. Sign in to a model provider (`hermes model`, or `hermes auth add <provider>`) and confirm with
   `hermes status` and `hermes auth list`. A provider whose credential is exhausted or rate-limited
   fails the run; Hermes then tries its configured fallback chain (`hermes fallback list`).
3. Work in, or point `--cd` at, the target git repository.

## Choose the model and the account

With no `--model`, Hermes uses its own configured model and fallback chain, which can change which
provider answers (and bills) between runs. Pass `--model <id>` and `--provider <name>` when the
brief needs a specific one, and `--effort <level>` for Hermes's `--reasoning` level. The relay has no
paid-model guard: Hermes's own configuration decides what a provider call costs, so check
`hermes auth list` before a large queue.

Hermes keeps its login, config, and sessions under `$HERMES_HOME` (default `~/.hermes`). The relay
passes its environment through unchanged, so exporting `HERMES_HOME` before the relay selects the
account. The relay never reads or writes that directory.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write a brief

Hermes sees only the text you send, plus whatever it loads on its own (its memory, rules, and the
`AGENTS.md` in the working directory). It cannot read your conversation: the brief must stand alone
with the goal, current state, what to change, what to leave untouched, and a report contract. Keep
each brief to a single task. Write it to a file and pass it as `--brief`. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

For **Codex orchestration of background work**, install and configure the separate
**codex-background** support utility first. If its MCP tools or registry are missing, stop and
report the setup requirement; do not silently fall back to model-driven polling. Then invoke its
registered `delegate_run` MCP tool once in place of the shell example below.
Follow that skill for structured common arguments, unchanged provider flags and reattachment by
runId. Keep the request pending until completion, then continue this skill's review and landing
steps. Other orchestrators keep the shell workflow below.

Use the bundled relay. It runs `hermes chat --query-file <brief> -Q --format stream-json`, captures
the event stream, and writes `result.json`.

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# pick a model and provider:         add --model glm-5.2 --provider zai
# set reasoning effort:              add --effort high
# bypass dangerous-command prompts:  add --yolo   (explicit opt-in)
# hard time limit (watchdog):        add --timeout 2h   (the 30m default suits brief runs)
# resume a session:                  add --session <id>  or  --resume-last
# see all options:                   node .../relay.mjs --help
```

The relay writes artifacts under the system temp dir by default and never commits. See
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

Codex using codex-background keeps the original MCP request pending: no model-driven sleep,
status or log polling. Use `delegate_wait` only to reattach after an interrupted request.

The relay blocks until Hermes finishes. Run it with the orchestrator's background-command facility,
or background it in the shell and poll for `result.json`. A pre-run usage error exits 2 and writes no
result; a missing `hermes` exits 127 and writes `status: "hermes_unavailable"`.

Completion means the process exited and `result.json` exists. Hermes's final response is the
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

Hermes has **no sandbox and no read-only mode**. A run edits files and runs shell commands with your
own permissions, and the relay cannot fence it. What it does have:

- **Single-query guard (default).** Nobody can answer an approval prompt in a one-shot run, so Hermes
  itself blocks the commands its dangerous-command patterns match (recursive deletes and the like)
  and reports the block to the model. Ordinary edits and commands run. This is Hermes's own
  behaviour, controlled by `approvals.single_query_mode` in its config; the relay does not touch
  that config.
- **`--yolo` (opt-in).** Passes Hermes's own `--yolo` and bypasses those prompts entirely. It is the
  human's call, not yours, and never a default or a lane dial.
- **No `--read-only`.** The relay exits 2 on it rather than imply a guarantee. Lanes cannot set
  `readOnly` for Hermes either.

Hermes also loads its tools, memory, rules, and the working directory's `AGENTS.md` as normal, and
may reach the network through its web and browser toolsets. The relay does not restrict toolsets.
Dispatch from a clean tree and check `git log` after the run, since nothing stops Hermes from
running `git commit` itself unless the brief forbids it.

## Authorization model

Delegation is something the human opts into. Once briefed, Hermes works as a tool you approved use
of. The boundary is: **do not accept conclusions from the self-report**; verify everything on disk.
`--yolo` and any model that spends a metered balance are the human's call, not yours. For anything
touching credentials, production data, or irreversible operations, stop and ask the human first.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - structure, scope, gates,
  brief delivery.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - flags, artifacts,
  `result.json`, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) - what to verify before calling
  the diff done.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues,
  constraint carry-forward, progress tracking, and the final coherence pass.
