# Review and land

Devin made the changes; you own the judgment. Verify against reality, never the self-report, and
read the diff as generated code because a green gate cannot catch every failure mode.

## Check tests before trusting gates

If the diff touches existing tests, review those edits first:

- Treat unbriefed test edits as a contract change, not part of the fix.
- Treat newly skipped, disabled, or commented-out tests as failing until proven otherwise.
- Treat loosened assertions the same way: contains/truthy replacing exact matches, broadened
  error types, and widened tolerances all weaken the gate.

## Run the gates yourself

Under the default `accept-edits` mode Devin usually could not run the gates at all, so `result.json`
carries claims, not evidence. Run the project's actual test, lint, and build commands in the working
tree and read their output. Passing is necessary, not sufficient.

## Read the diff against the brief

Start with `touchedFiles`, open the diff, and compare it to the brief:

- **Scope creep** - changes the brief excluded.
- **Scope shortfall** - missed behavior, edges, or cleanup.
- **Quiet judgment calls** - defensible but unasked decisions that need review.

A `failed` run that ended on a rejected tool call can still leave useful edits behind. Review them
like any other diff before deciding whether to keep, fix, or revert them.

## The implementer sweep

Check every diff for patterns gates often miss:

- Hardcoded success or fixture data on a real-work path.
- Catch-all error handling that returns a default instead of propagating or recovering.
- Imports, dependencies, methods, and signatures not present in the installed version.
- Unused imports, uncalled helpers, unreachable branches, and scaffolding comments.
- A second client, error idiom, or logging style beside the repo's existing one.
- Tests that assert internals instead of behavior, or near-duplicate test bodies.
- Optional parameters, config flags, and abstractions with no caller.
- Guards for impossible cases that hide trust-boundary validation.

Send anything blocking back to Devin as a delta brief, or fix it in the tree, and report either
choice to the human. Run relevant guard skills if installed.

## The commit boundary

When the gates pass and the diff holds, **the orchestrator commits**, never the implementer. Under
`accept-edits` and `auto`, side-effecting commands need confirmation, which print mode rejects (a
`git commit` attempt specifically has not been exercised); under `dangerous` nothing stops one, so
check `git log` after any run. Write a clear message describing what landed.

From dispatch until that commit, the uncommitted working tree is the authoritative copy of the
implementer's work. Never run `git checkout`, `reset`, `clean`, or a branch switch in the workspace
between those two points. However messy an interrupted run looks, inspect it first: `git status`,
`git diff`, `git diff --cached` for anything staged, and commit the intended files explicitly.

## Rework: re-dispatch a corrected brief

```bash
echo "The fix is right, but the tests mock the DB session: use the real migrated fixture and
remove the unused import." | node "<skill-dir>/scripts/relay.mjs" --cd /path/to/repo --session <id>
```

Use `--session <id>` with the `sessionId` from the previous run's `result.json` to resume that
session with the delta brief, `--resume-last` for the most recent session in this cwd, or dispatch
a fresh run. Each correction gets the same test review, diff review, and implementer sweep.

## Surface, do not absorb

The human opted into delegation, so committing verified, gate-passing work is the contract. Keep
them in the loop when the work changes shape:

- Report design decisions and defensible-but-unrequested turns.
- Note non-blocking nitpicks you did not block on.
- Stop and ask if correct completion requires going beyond the brief, a paid model, or a wider
  permission mode.

For a queue, keep these notes in the progress file described in
[multi-task-queues.md](multi-task-queues.md).
