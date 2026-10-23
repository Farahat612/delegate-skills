# Dispatch and poll

`scripts/relay.mjs` wraps Hermes's single-query mode, records its stream-json events, and writes a
`result.json`. Run one command, then read one file.

## Before the first run

```bash
command -v hermes
hermes --version
hermes status
hermes auth list
hermes fallback list
```

Sign in with `hermes model` or `hermes auth add <provider>` if no provider works. A credential
marked exhausted or rate-limited in `hermes auth list` fails the run, and Hermes then tries the
fallback chain; a chain that is also exhausted ends the run with a failed result event.

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

`<skill-dir>` is the installed folder containing this skill's `SKILL.md`.

| Flag | Effect |
| --- | --- |
| `--brief <file>` | Brief path. Omit it to read the brief from stdin. |
| `--cd <dir>` | Working root, child process cwd, and Hermes's `--in` directory (default: current directory). |
| `--lane <name>` | Fleet lane from `delegate-setup` config. Applies that lane's dials (`provider`, `model`, `effort`, `timeout`); fails if the lane's `implementer` is not `hermes`. Explicit flags win. |
| `--model <id>` | Hermes model id. Default: Hermes's own configured model. Token-validated: letters, digits, `. _ : / -`. |
| `--provider <name>` | Hermes inference provider. Default: Hermes's own configuration. Same token rule. |
| `--effort <level>` | Passed as `--reasoning`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. |
| `--yolo` | Passes Hermes's `--yolo`: bypass dangerous-command approval prompts. Opt-in only. |
| `--session <id>` | Resume a specific Hermes session (`--resume <id>`); send only the delta brief. |
| `--resume-last` | Resume the most recent session for this directory (`--resume latest`); send only the delta brief. Mutually exclusive with `--session`. |
| `--timeout <dur>` | Relay watchdog (default: `30m`; h/m/s strings). |
| `--out-dir <dir>` | Artifact directory (default: a fresh directory under the system temp dir). |
| `-h`, `--help` | Print the relay's header help. |

`--read-only` is refused with exit 2: Hermes has no read-only mode or sandbox.

## Artifacts and result fields

Artifacts live outside the repo by default, so they do not appear in `touchedFiles`; an
`--out-dir` inside the worktree can make the artifacts appear there:

- `brief.txt` - the exact brief, passed to Hermes with `--query-file`.
- `final.txt` - the result event's `text`; absent if there was none.
- `events.jsonl` - Hermes's raw stdout: stream-json events plus the plain notices Hermes interleaves
  (provider fallback warnings, toolset warnings).
- `stderr.txt` - complete stderr, which ends with a `session_id:` line.
- `result.json` - the stable `delegate-relay.result.v1` contract.

`result.json` fields:

- `schema`, `tool` (`"hermes"`), `status` (`completed` | `failed` | `timeout` | `aborted` |
  `hermes_unavailable`), `exitCode`, and `signal` (`null` unless the child died on a signal).
- `workdir`, `model`, `provider`, `effort` (each `null` when Hermes's own default applies), `yolo`,
  `autonomy`, `readOnly` (always `false`), `resumed`, `hermesVersion`, `startedAt`, and `finishedAt`.
- `sessionId` - from the stream-json `init` and `result` events, or the stderr `session_id:` line;
  pass it back with `--session` to resume.
- `usage` - the result event's `tokens` object, or `null`.
- `finalMessage` - the result event's `text`, trimmed. On a failed run this is Hermes's own error
  text, for example a billing or rate-limit message.
- `touchedFiles` - `git status --porcelain` lines for the **final working tree under `--cd` only**,
  not an attribution of Hermes's edits: anything already dirty before dispatch shows up too.
  Dispatch from a clean tree when you want the list to read as "what Hermes changed". `null` means
  git could not report; `[]` means git ran and the tree is clean.
- `briefPath`, nullable `finalPath`, nullable `eventsPath`, and `stderrPath`.
- `stderrTail` - the last 20 non-empty stderr lines on any run that did not complete.
- `error` - present on a failed result event, a missing result event, preflight failures, when the
  relay watchdog fires, and on an `aborted` run.

## How the relay decides a run worked

The result event is Hermes's own verdict. A run is `completed` only when the process exits 0 **and**
a `result` event arrived **and** its `exit_code` is 0 with no `error`. A result event that reports
failure while the process exits 0, or an exit 0 with no result event at all, is `failed` with
exit code 1.

## Waiting for completion

The relay blocks. Use the orchestrator's background-command facility, or background it in a shell
and poll for `result.json`. The run is done only when the process exits and the file contains a
`status`. The result file is written atomically, so a partial read is impossible.

A pre-run usage error exits 2 and writes no result. A missing `hermes` exits 127 and writes
`status: "hermes_unavailable"`.

## When a run misbehaves

- **`status: "hermes_unavailable"` (exit 127):** `hermes` is not on PATH. Install it, sign in, and
  re-dispatch.
- **`status: "failed"` with a billing, credit, or rate-limit message in `finalMessage`:** the
  provider Hermes picked is exhausted. Check `hermes auth list` and `hermes fallback list`, then
  pick another `--provider` and `--model`. Fixing a login or buying credit is the human's job.
- **`status: "failed"` with `error` "no result event":** Hermes exited 0 without finishing the
  stream-json protocol. Read `events.jsonl` and `stderrPath`; do not trust the tree until reviewed.
- **`status: "failed"`:** read `stderrTail` and `stderrPath`.
- **`status: "failed"` with an `error` mentioning `version preflight`:** the bounded
  `hermes --version` probe failed or hung, so Hermes was never dispatched.
- **`status: "aborted"`:** the relay itself was killed and forwarded the kill to Hermes. The result
  is written before the relay exits; inspect the working tree before re-dispatching.
- **`status: "timeout"`:** the `--timeout` watchdog killed the run; `error` reads
  `hermes did not finish within --timeout <dur>; killed by the relay watchdog`. Increase `--timeout`
  or split the task.
- **A blocked command:** Hermes reports a `BLOCKED` message to the model when a dangerous pattern
  matches in single-query mode. Rewrite the brief so the task does not need that command, run it
  yourself, or, if the human agrees, re-dispatch with `--yolo`.

## What the relay runs

The launch is equivalent to:

```bash
hermes chat --query-file <out-dir>/brief.txt -Q --format stream-json --in <cd> \
  [--model <id>] [--provider <name>] [--reasoning <level>] [--yolo] \
  [--resume <id|latest>]
```

The child process cwd is `--cd`; stdin is closed. The relay spawns `hermes` without a shell on every
platform, which assumes a native launcher; a native Windows launch has not been run. Before
dispatch the relay runs a bounded `hermes --version` preflight (10s cap) so a hung or broken CLI
fails fast and explicitly.

## The commit boundary

The relay never commits. Hermes edits the working tree; the orchestrator reviews, re-runs the gates,
and commits. See [review-and-land.md](review-and-land.md).
