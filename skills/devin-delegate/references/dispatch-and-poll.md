# Dispatch and poll

`scripts/relay.mjs` wraps Devin's print mode, exports its trajectory, and writes a `result.json`.
Run one command, then read one file.

## Before the first run

```bash
command -v devin
devin --version
devin auth status
devin models list
```

Sign in with `devin auth login` if `devin auth status` does not report you as logged in. A run that
cannot reach Devin's service fails with `status: "failed"`; read `stderrTail`.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read the brief from stdin. |
| `--cd <dir>` | Working root and child process cwd (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials (`model`, `timeout`, `readOnly`); fails if the lane's `implementer` is not `devin`. Explicit flags win. |
| `--model <id>` | Devin model id (default: `swe-2-high`). Token-validated: letters, digits, `. _ : / -`. |
| `--allow-paid` | Allow a model outside the free list. Without it, any other model exits 2 before dispatch. |
| `--read-only` | Devin's `auto` permission mode: read-only tools only. Conflicts with any other `--permission-mode`. |
| `--permission-mode <m>` | `accept-edits` (default), `auto`, `smart`, or `dangerous`. `auto` is the same as `--read-only`. |
| `--session <id>` | Resume a specific Devin session (`-r <id>`); send only the delta brief. |
| `--resume-last` | Continue the most recent Devin session for this cwd (`-c`); send only the delta brief. Mutually exclusive with `--session`. |
| `--timeout <dur>` | Relay watchdog (default: `30m`; h/m/s strings). Devin has no timeout flag. |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

## The model guard

The relay always passes `--model`. The free list is the exact ids `swe-2-high`, `swe-2-medium`, and
`swe-2-max`, which `devin models list` tags `Free`; every other model, alias, and the paid
`-lightning` SWE-2 variants needs `--allow-paid`. The check is a fixed list in `relay.mjs`
(`FREE_MODELS`), not a live lookup: it cannot see a pricing change on Devin's side. If
`devin models list` stops tagging an id `Free`, update `FREE_MODELS`. On `--session` or
`--resume-last` the relay still passes `--model`, so a resumed session is switched to the selected
model instead of keeping a saved paid one. `result.json` records `model` and `allowPaid`, and
`actualModel` as reported by the trajectory.

A lane can set `model`, but never `allowPaid`: a lane whose model is not free still needs
`--allow-paid` on each dispatch.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`; an
`--out-dir` inside the worktree can make the artifacts appear there:

- `brief.txt` - the exact brief, passed to Devin with `--prompt-file`.
- `final.txt` - Devin's printed response (stdout); absent if it printed nothing.
- `trajectory.json` - Devin's own `--export` of the session (an ATIF document with `session_id`,
  agent metadata, every step with its tool calls and observations, and `final_metrics`). This is
  the event record. It also contains the system prompt, rules, and skills Devin loaded.
- `stderr.txt` - complete stderr.
- `result.json` - the stable `delegate-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"devin"`), `status` (`completed` | `failed` | `timeout` | `aborted` |
  `devin_unavailable`), `exitCode`, and `signal` (`null` unless the child died on a signal).
- `workdir`, `model`, `actualModel`, `allowPaid`, `permissionMode`, `readOnly`, `resumed`,
  `devinVersion`, `startedAt`, and `finishedAt`.
- `sessionId` - the trajectory's `session_id`; pass it back with `--session` to resume.
- `usage` - the trajectory's `final_metrics` (token totals and step count), or `null`.
- `finalMessage` - Devin's printed response, trimmed.
- `touchedFiles` - `git status --porcelain` lines for the **final working tree under `--cd` only**,
  not an attribution of Devin's edits: anything already dirty before dispatch shows up too.
  Dispatch from a clean tree when you want the list to read as "what Devin changed". `null` means
  git could not report; `[]` means git ran and the tree is clean.
- `briefPath`, nullable `finalPath`, nullable `eventsPath` (the `trajectory.json` path, `null` when
  Devin wrote none), and `stderrPath`.
- `stderrTail` - the last 20 non-empty stderr lines on any run that did not complete.
- `error` - present on a rejected tool call, preflight failures, when the relay watchdog fires,
  and on an `aborted` run.

## Waiting for completion

The relay blocks. Use the orchestrator's background-command facility, or background it in a shell
and poll for `result.json`. The run is done only when the process exits and the file contains a
`status`. The result file is written atomically, so a partial read is impossible.

A pre-run usage error exits 2 and writes no result. A missing `devin` exits 127 and writes
`status: "devin_unavailable"`.

## When a run misbehaves

- **Exit 2 naming `--allow-paid`:** the model is not on the free list. Pick a free SWE-2 id, or
  get the human's go-ahead and add `--allow-paid`.
- **`status: "devin_unavailable"` (exit 127):** `devin` is not on PATH. Install it, sign in, and
  re-dispatch.
- **`status: "failed"` with `error` "devin rejected a tool call":** print mode refused a tool its
  permission mode does not approve and ended the run with no response. Edits made before the
  refusal are still in the tree; check `touchedFiles`, and `trajectory.json` shows the rejected
  call. On a write run it is usually a shell command that writes a file or runs a test or build:
  add the `<tooling>` block from [writing-the-brief.md](writing-the-brief.md), drop any gate
  instructions and run the gates yourself, or, if the human agrees, re-dispatch with
  `--permission-mode smart` or `dangerous`. On a read-only run, rephrase
  the brief so it does not ask for edits or side-effecting commands.
- **`status: "failed"`:** read `stderrTail` and `stderrPath`. Common causes: an unknown `--model`
  (Devin prints `Unknown model` and exits 1), expired credentials, or a service error.
- **`status: "failed"` with an `error` mentioning `version preflight`:** the bounded
  `devin --version` probe failed or hung, so Devin was never dispatched.
- **`status: "aborted"`:** the relay itself was killed and forwarded the kill to Devin. The result
  is written before the relay exits; inspect the working tree before re-dispatching.
- **`status: "timeout"`:** the `--timeout` watchdog killed the run; `error` reads
  `devin did not finish within --timeout <dur>; killed by the relay watchdog`. Increase `--timeout`
  or split the task.
- **Empty `finalMessage` on a completed run:** inspect `touchedFiles` and the diff, and the last
  agent steps in `trajectory.json`. Add a `<structured_output_contract>` to the next brief.

## Recovering lost work

`trajectory.json` records every step Devin took, with each tool call and its result. Devin rewrites
it after each turn, so a run killed mid-turn may have none. If finished work is lost, read it
before re-dispatching: it identifies which files and commands were involved.

## What the relay runs

The launch is equivalent to:

```bash
devin -p --prompt-file <out-dir>/brief.txt \
  --model <id> \
  --permission-mode <accept-edits|auto|smart|dangerous> \
  --respect-workspace-trust false \
  --export <out-dir>/trajectory.json \
  [-r <id> | -c]
```

The child process cwd pins the workspace; stdin is closed. The relay spawns `devin` without a shell
on every platform, which assumes a native executable; a native Windows launch has not been run.
Before dispatch the relay runs a bounded `devin --version` preflight (10s cap) so a hung or broken
CLI fails fast and explicitly.

## The commit boundary

The relay never commits. Devin edits the working tree; the orchestrator reviews, re-runs the gates,
and commits. See [review-and-land.md](review-and-land.md).
