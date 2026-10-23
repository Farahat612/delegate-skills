# Dispatch and poll

`scripts/relay.mjs` wraps OpenClaw's `agent exec`, captures its JSON envelope, and writes a
`result.json`. Run one command, then read one file.

## Before the first run

```bash
command -v openclaw
openclaw --version
openclaw models status
openclaw agent exec --help
```

Configure a provider with `openclaw configure` if none works. `openclaw models status` opens
OpenClaw's agent database; if it reports a schema version that needs `openclaw doctor --fix`, that
migration is the human's decision because it rewrites OpenClaw's own state.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read the brief from stdin. At most 4 MiB. |
| `--cd <dir>` | Working root and child process cwd. `agent exec` uses its cwd as both the agent workspace and the tool working directory (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials (`model`, `effort`, `timeout`); fails if the lane's `implementer` is not `openclaw`. Explicit flags win. |
| `--model <provider/model>` | OpenClaw model. Default: OpenClaw's own configured model. Token-validated: letters, digits, `. _ : / -`. |
| `--effort <level>` | Passed as `--thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, `ultra` (where the model supports it). |
| `--timeout <dur>` | Relay watchdog (default: `30m`; h/m/s strings). Also passed to OpenClaw as `--timeout <seconds>`. |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

`--read-only` is refused with exit 2, and there is no `--session` or `--resume-last`.

### Timeouts

OpenClaw's own `--timeout` defaults to 600 seconds per model attempt, so the relay always passes it,
rounded up to whole seconds from the relay `--timeout`. A longer run is therefore not cut short by
OpenClaw's default. OpenClaw's deadline is per attempt and each fallback gets a fresh budget, while
the relay watchdog bounds the whole run. Per OpenClaw's documentation its own deadline ends the
process with exit 2, which the relay reports as `status: "timeout"`.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`; an
`--out-dir` inside the worktree can make the artifacts appear there:

- `brief.txt` - the exact brief, streamed to OpenClaw on stdin (`--message-file -`).
- `final.txt` - the envelope's `final` text; absent if there was none.
- `events.json` - OpenClaw's raw stdout, normally the one JSON envelope.
- `stderr.txt` - complete stderr.
- `result.json` - the stable `delegate-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"openclaw"`), `status` (`completed` | `failed` | `timeout` | `aborted` |
  `openclaw_unavailable`), `exitCode`, and `signal` (`null` unless the child died on a signal).
- `workdir`, `model` (`null` when OpenClaw's own default applies), `actualModel` (the envelope's
  provider and model), `effort`, `autonomy`, `readOnly` (always `false`), `resumed` (always `false`),
  `openclawVersion`, `startedAt`, and `finishedAt`.
- `sessionId` - the envelope's `sessionId`. Informational: `agent exec` keeps no session to resume.
- `usage` and `costUsd` - from the envelope, or `null`.
- `finalMessage` - the envelope's `final` text, trimmed.
- `touchedFiles` - `git status --porcelain` lines for the **final working tree under `--cd` only**,
  not an attribution of OpenClaw's edits: anything already dirty before dispatch shows up too.
  Dispatch from a clean tree when you want the list to read as "what OpenClaw changed". `null`
  means git could not report; `[]` means git ran and the tree is clean.
- `briefPath`, nullable `finalPath`, nullable `eventsPath`, and `stderrPath`.
- `stderrTail` - the last 20 non-empty stderr lines on any run that did not complete.
- `error` - present on a failed envelope, a missing envelope, preflight failures, when a deadline
  fires, and on an `aborted` run.

## How the relay decides a run worked

The envelope is OpenClaw's own verdict. A run is `completed` only when the process exits 0 **and** a
JSON envelope parsed **and** it reports no error (`ok` is not `false`, no `error` object). An
envelope that reports failure while the process exits 0, or an exit 0 with nothing parseable on
stdout, is `failed` with exit code 1. Per OpenClaw's documentation, exit 1 is a model or result
error and exit 2 is its own deadline.

## Waiting for completion

The relay blocks. Use the orchestrator's background-command facility, or background it in a shell
and poll for `result.json`. The run is done only when the process exits and the file contains a
`status`. The result file is written atomically, so a partial read is impossible.

A pre-run usage error exits 2 and writes no result. A missing `openclaw` exits 127 and writes
`status: "openclaw_unavailable"`.

## When a run misbehaves

- **`status: "openclaw_unavailable"` (exit 127):** `openclaw` is not on PATH. Install it, configure
  a provider, and re-dispatch.
- **`status: "failed"` with `error` "openclaw reported a failed run":** the envelope carries the
  provider or model error. Read `error`, `stderrTail`, and `events.json`. Fixing a login or credit
  is the human's job.
- **`status: "failed"` with `error` "no parseable JSON envelope":** OpenClaw exited 0 without the
  documented envelope. Read `events.json` and `stderrPath`; do not trust the tree until reviewed.
- **A stderr message about the agent database schema:** OpenClaw wants `openclaw doctor --fix`. That
  migrates the user's OpenClaw state, so stop and tell the human.
- **`status: "failed"` with an `error` mentioning `version preflight`:** the bounded
  `openclaw --version` probe failed or hung, so OpenClaw was never dispatched.
- **`status: "aborted"`:** the relay itself was killed and forwarded the kill to OpenClaw. The
  result is written before the relay exits; inspect the working tree before re-dispatching.
- **`status: "timeout"`:** the relay watchdog or OpenClaw's own deadline ended the run. `error` says
  which. Increase `--timeout` or split the task.

## What the relay runs

The launch is equivalent to:

```bash
openclaw agent exec --message-file - --json --timeout <seconds> \
  [--model <provider/model>] [--thinking <level>] < <out-dir>/brief.txt
```

The child process cwd is `--cd`. On POSIX the relay spawns `openclaw` without a shell. On Windows
the npm `openclaw.cmd` shim needs `shell:true`; argv then holds only fixed flag names and
token-validated values, and the brief still travels on stdin. A native Windows launch has not been
run. Before dispatch the relay runs a bounded `openclaw --version` preflight (10s cap) so a hung or
broken CLI fails fast and explicitly.

## The commit boundary

The relay never commits. OpenClaw edits the working tree; the orchestrator reviews, re-runs the
gates, and commits. See [review-and-land.md](review-and-land.md).
