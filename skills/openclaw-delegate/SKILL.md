---
name: openclaw-delegate
description: >-
  Delegate a coding task to OpenClaw (`openclaw`) as a background implementer, then review its diff
  and land it yourself. Use this whenever the user wants to hand implementation work to OpenClaw -
  phrasings like "have OpenClaw implement X", "delegate this to OpenClaw", "run it through the
  OpenClaw agent", or "use openclaw to implement/fix/refactor" - or wants to run a queue of coding
  tasks through OpenClaw while staying the reviewer. DO NOT USE for tasks small enough to do inline,
  when the user wants the code written directly without delegating, or for OpenClaw's gateway,
  channels, messaging, or cron automations.
license: MIT
compatibility: Requires the `openclaw` CLI installed (`npm install -g openclaw`) with a model provider configured (`openclaw configure`, confirmed with `openclaw models status`), Node 18+, and git. The orchestrator must be able to run shell commands and read files. Shell examples assume bash/zsh (macOS/Linux, or Git Bash/WSL on Windows).
metadata:
  version: 0.5.0
---

# OpenClaw Delegate

You are the **orchestrator**. Delegate a bounded coding task to a separate **implementer**, the local
OpenClaw CLI, then review what it produced and land it yourself. You write the brief and own the
judgment; OpenClaw edits the working tree in a one-shot embedded agent turn; you verify and commit.

The loop needs only a shell command and file access, so any comparable orchestrator can drive it.

## When NOT to use this

- The task is small enough to do inline; delegation overhead is not worth it.
- The `openclaw` CLI is not installed, or no model provider is configured.
- You need a read-only answer or review pass that is **enforced**. The installed `agent exec` has no
  read-only flag, so the relay refuses `--read-only`. Use an implementer that has one.
- You need to resume or continue a session. `agent exec` keeps no session between runs, so the relay
  offers no `--session` or `--resume-last`; send a complete brief each time.
- You want OpenClaw's gateway, channels, messaging, or automations. This skill drives one coding
  turn in a working tree.

## Prerequisites (check once)

1. Install OpenClaw and confirm `openclaw --version` succeeds.
2. Configure a model provider (`openclaw configure`) and confirm with `openclaw models status`.
   If that command reports that the agent database needs a migration, the human has to run
   `openclaw doctor --fix`; it changes OpenClaw's own state, so do not run it for them.
3. Work in, or point `--cd` at, the target git repository.

## Choose the model and the account

With no `--model`, OpenClaw uses its own configured default. Pass `--model provider/model` to pick
another, and `--effort <level>` for OpenClaw's `--thinking` level. Run `openclaw models` (see its
`--help`) to see what the account offers. The relay has no paid-model guard: OpenClaw's own
configuration decides what a provider call costs.

OpenClaw keeps its config and logins under `$OPENCLAW_STATE_DIR` and `$OPENCLAW_CONFIG_PATH`
(default `~/.openclaw`), or `~/.openclaw-<name>` for `openclaw --profile <name>`. The relay passes
its environment through unchanged, so exporting those variables before the relay selects the
account. The relay never reads or writes that directory.

## The loop

Run these five steps per task. Steps 1, 4, and 5 require judgment; 2 and 3 are mechanical.

### 1. Write a brief

OpenClaw sees only the text you send, plus whatever it loads on its own (workspace files such as
`AGENTS.md`). It cannot read your conversation: the brief must stand alone with the goal, current
state, what to change, what to leave untouched, and a report contract. Keep each brief to a single
task. Write it to a file and pass it as `--brief`. See
[references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

For **Codex orchestration of background work**, install and configure the separate
**codex-background** support utility first. If its MCP tools or registry are missing, stop and
report the setup requirement; do not silently fall back to model-driven polling. Then invoke its
registered `delegate_run` MCP tool once in place of the shell example below.
Follow that skill for structured common arguments, unchanged provider flags and reattachment by
runId. Keep the request pending until completion, then continue this skill's review and landing
steps. Other orchestrators keep the shell workflow below.

Use the bundled relay. It runs `openclaw agent exec --message-file - --json` with the brief on
stdin, captures the JSON envelope, and writes `result.json`.

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# pick a model:                      add --model openai/gpt-5.6-luna
# set thinking level:                add --effort high
# hard time limit (watchdog):        add --timeout 2h   (the 30m default suits brief runs)
# see all options:                   node .../relay.mjs --help
```

The relay writes artifacts under the system temp dir by default and never commits. See
[references/dispatch-and-poll.md](references/dispatch-and-poll.md).

### 3. Wait for completion

Codex using codex-background keeps the original MCP request pending: no model-driven sleep,
status or log polling. Use `delegate_wait` only to reattach after an interrupted request.

The relay blocks until OpenClaw finishes. Run it with the orchestrator's background-command facility,
or background it in the shell and poll for `result.json`. A pre-run usage error exits 2 and writes no
result; a missing `openclaw` exits 127 and writes `status: "openclaw_unavailable"`.

Completion means the process exited and `result.json` exists. OpenClaw's final response is the
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

OpenClaw `agent exec` has **no read-only flag** and no relay-level sandbox control. Its documented
defaults, which apply only where the user's own OpenClaw config leaves a setting unset:

- the `coding` tool profile is selected;
- the agent sandbox is off;
- filesystem tools are restricted to the working directory (`--cd`);
- the run uses the execution policy a headless turn needs.

Anything the user's config sets wins, so a configured sandbox, shell environment, or tool profile
is never downgraded. A shell command the agent runs is **not** confined to the working directory.
The relay does not pass any sandbox or policy flag and does not edit that config. It refuses
`--read-only`, and lanes cannot set `readOnly` for OpenClaw. These defaults come from OpenClaw's
documentation for a newer release than the one the relay was written against; the installed
`openclaw agent exec --help` is the source of truth for flags.

Dispatch from a clean tree and check `git log` after the run, since nothing stops OpenClaw from
running `git commit` itself unless the brief forbids it.

## Authorization model

Delegation is something the human opts into. Once briefed, OpenClaw works as a tool you approved use
of. The boundary is: **do not accept conclusions from the self-report**; verify everything on disk.
Any model that spends a metered balance is the human's call, not yours. For anything touching
credentials, production data, or irreversible operations, stop and ask the human first.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md) - structure, scope, gates,
  brief delivery.
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md) - flags, artifacts,
  `result.json`, and failure recovery.
- [references/review-and-land.md](references/review-and-land.md) - what to verify before calling
  the diff done.
- [references/multi-task-queues.md](references/multi-task-queues.md) - sequential queues,
  constraint carry-forward, progress tracking, and the final coherence pass.
