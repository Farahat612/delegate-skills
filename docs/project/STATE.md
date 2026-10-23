# State (2026-10-23)

## Now
Branch `feat/hermes-openclaw-relays` (from `feat/devin-delegate`), two local commits, not pushed, no PR.
Adds `hermes-delegate` and `openclaw-delegate`. Details and decisions: `hermes-openclaw-relays.md`.

## Resume here
1. Get a working Hermes provider (BACKLOG D3), then run one real write dispatch through
   `skills/hermes-delegate/scripts/relay.mjs` against a throwaway repo and add the result to README "Verification status".
2. Run `openclaw doctor --fix` yourself (migrates OpenClaw's own state), then one real dispatch through
   `skills/openclaw-delegate/scripts/relay.mjs`. Check the envelope field names against the real output.
3. Apply `Session-Operations/night/2026-10-23/n05-lanes-patch.md` to `Agent-OS/lanes.json` if wanted.

## Verified now
Full `node test/relay-smoke.mjs` green, `relay-parity`, `relay-isolated`, `npx skills add . --list`; Hermes relay live run reached its provider and failed with HTTP 429 (failure path only).

## Unknown
Hermes success path live, OpenClaw live behaviour, both on Windows and Linux. `codex-background` tests cannot run on macOS (same failures on the base branch).
