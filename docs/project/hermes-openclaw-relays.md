# Hermes and OpenClaw relays (2026-10-23)

Branch `feat/hermes-openclaw-relays`, cut from `feat/devin-delegate`. Local commits only.

## What was built

- `skills/hermes-delegate`: `hermes chat --query-file <brief> -Q --format stream-json --in <cd>`.
- `skills/openclaw-delegate`: `openclaw agent exec --message-file - --json --timeout <s>` with the brief on stdin.
- Registered in `skills.sh.json`, `delegate-setup` (implementers, config validation, schema), the smoke, parity,
  isolated, preflight and timeout matrices, and the fake CLI. Stub tests: `test/relay/hermes.mjs`, `test/relay/openclaw.mjs`.

## Decisions

1. **Base branch.** `feat/devin-delegate` (the Devin relay), not `fix/copilot-read-only`, so the new work does not
   carry the unrelated copilot fix.
2. **No `--read-only` for either relay.** Hermes has no sandbox or read-only mode (its toolsets cannot split read
   from write inside `file`). The installed OpenClaw 2026.9.8 `agent exec --help` has no read-only flag; the
   `--config-override` tools-deny route appears only in newer docs and is not installed here. Both relays exit 2 on
   `--read-only` and neither implementer supports the `readOnly` lane dial, so a read-only lanes job must not list
   them. The Agent OS `lanes` tool always passes `--model` and adds `--read-only` for read-only jobs.
3. **Hermes autonomy.** No `--yolo` by default: in single-query mode Hermes itself denies dangerous-pattern commands.
   `--yolo` is a per-dispatch opt-in. The relay never touches `approvals.single_query_mode` or any Hermes config.
4. **Result trust.** A run is `completed` only when the CLI exits 0 and its own verdict (Hermes `result` event,
   OpenClaw envelope) agrees. Exit 0 with no verdict is `failed`.
5. **Hermes stdout has plain notices** between JSON lines (seen live), so non-JSON lines are skipped; the session id
   falls back to the `session_id:` line Hermes prints on stderr.
6. **OpenClaw deadline.** `agent exec --timeout` defaults to 600 s per attempt, so the relay passes its own `--timeout`
   in seconds; exit 2 (documented as OpenClaw's deadline) maps to `status: "timeout"`.
7. **No resume for OpenClaw.** `agent exec` uses a temporary state directory and has no session flag.
8. **Account homes are environment, not a relay flag**, like the other relays: `HERMES_HOME`;
   `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`. The relays pass the environment through and never read or write
   those directories. No personal paths are in the repo; the Agent OS lanes entry is in a patch file outside it.
9. **Effort dial.** `--effort` maps to Hermes `--reasoning` and OpenClaw `--thinking`, validated in delegate-setup.

## Status

- Hermes: live run through the relay reached the provider and ended `failed` (HTTP 429, Zai balance exhausted, Codex
  login exhausted). Failure path verified live; success path unknown until a provider works (BACKLOG D3).
- OpenClaw: not run live. `openclaw models status` stops with "agent database uses schema version 19 ... run
  openclaw doctor --fix", which migrates the user's own state. Envelope field names (`final`, `ok`, `sessionId`,
  `usage`, `costUsd`, `provider`, `model`) come from OpenClaw's published docs, not from a run.
- Windows: not run for either.
- Suite (macOS, 2026-10-23): `node test/relay-smoke.mjs` all green with both relays in every matrix, `relay-parity`,
  `relay-isolated` and `npx skills add . --list` (23 skills) pass. The `codex-background` tests fail here with
  "Unsupported host (darwin)": the same 25 `bootstrap.test.mjs` failures occur on the unchanged `feat/devin-delegate`
  tree, `server.test.mjs` hung with no output and was stopped, so none of them says anything about these relays.

## Undo

`git switch feat/devin-delegate && git branch -D feat/hermes-openclaw-relays` removes the branch (local only, never pushed).
