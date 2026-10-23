# Writing the brief

A brief is the entire task as Hermes will see it. It runs in a separate session with **no memory of
your conversation and no shared context**: only the text you send, whatever Hermes loads on its own,
and whatever it can inspect in the workspace. If a constraint is not in the brief or discoverable in
the repo, it does not exist for Hermes.

Hermes loads its tools, its memory, its rules, and the `AGENTS.md` in the working directory into
single-query runs too. Its memory can carry facts from the user's other work, so restate
load-bearing repo constraints in the brief and do not assume Hermes will pick the right ones.

## The shape that works

Use a compact, block-structured brief. State the task, what done means, the few constraints that
matter, and the report Hermes must return.

```xml
<task>
One or two sentences: the concrete job and where it lives. Then the specifics - current state, what to
change, and explicitly what to leave untouched. The leave-untouched list prevents unrelated refactors.
</task>

<gates>
Run these before you report, and fix what they find:
  <the project's real test command>
  <the project's real lint/format command>
  <the project's real build/typecheck command>
</gates>

<action_safety>
Keep changes scoped to the task. No unrelated refactors, renames, or cleanup unless required for
correctness. Do NOT run git add, git commit, git push, or any command that deletes files outside the
paths named in the task. The orchestrator commits after reviewing; leave the work uncommitted in the
working tree.
</action_safety>

<structured_output_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched
  3. Gate commands you ran and their results
  4. Anything you deviated on, left open, or want a decision on
</structured_output_contract>
```

Add extra blocks only when the task needs them:

- **Debugging or open-ended fixes** - add `<completeness_contract>` (resolve fully, not just the
  first plausible cause) and `<missing_context_gating>` (find missing repo facts or state what is
  unknown).
- **Research or review** - add `<research_mode>` (separate observed facts, inferences, and open
  questions). Hermes cannot enforce read-only, so say in the brief that it must not write any file,
  dispatch from a clean tree, and expect `touchedFiles: []`. Better, route the pass to an
  implementer that has a real read-only mode.

## Gates

Hermes can run shell commands, so it can run the gates. In single-query mode Hermes blocks the
commands its dangerous-command patterns match, so a gate that deletes build output recursively may
be refused; name such steps in the brief or run them yourself. Whatever Hermes reports, re-run the
gates in review.

## Always ask for the report explicitly

`finalMessage` is the text of Hermes's last answer. Without a closing summary, the edits may exist
but the result is hard to review. The `<structured_output_contract>` block makes the expected report
explicit.

## Discover the real gates

Read the repo's `AGENTS.md`, `CLAUDE.md`, `Makefile`, `package.json`, or equivalent first and copy
the actual commands into the brief. A brief that says only "the tests" makes the implementer guess.

## One task per brief

Keep each brief bounded. One brief -> one Hermes run -> one reviewed commit keeps the diff and
rollback clean. Split mixed implementation, review, documentation, and roadmap requests into
separate dispatches.

## Premises freeze at dispatch

The implementer starts from the brief's facts and there is no steering channel mid-run. Audit the
fact block before sending: ownership, target branch, constraints, anything a judgment call rests
on. If a premise turns out wrong while the run is live, stop the run and re-dispatch a corrected
brief rather than discounting the output afterward; inspect the working tree and reconcile any
partial edits before the re-dispatch.

## A worked example

```xml
<task>
In the payments service at services/billing/, the refund path double-charges when a refund is retried
after a network timeout. Make refund submission idempotent: check for an existing refund by idempotency
key before creating a new one. Touch only services/billing/refund.py and its tests. Leave the charge
path, API routes, and data models untouched.
</task>

<gates>
Run and make pass before you report:
  pytest tests/billing/ -q
  ruff check services/billing/
</gates>

<action_safety>
Scope strictly to the refund idempotency fix. No unrelated refactors. Do NOT git add, commit, or push;
leave changes in the working tree for review.
</action_safety>

<structured_output_contract>
Report: (1) the root cause and fix, (2) files touched, (3) the gate commands you ran and their
results, (4) anything left open or needing a decision.
</structured_output_contract>
```

## Brief delivery

The relay writes the brief to the run's `brief.txt` and hands it to Hermes with `--query-file`.
The brief content never rides argv: it stays out of the host process list, is not bounded by the
OS arg-length cap, and nothing in it is shell-interpreted. On a shared machine keep secrets out of
the brief anyway; reference them by a path or environment variable the workspace can read. Hermes
stores its sessions under `$HERMES_HOME`, so the brief is retained there too.

On resume (`--session` / `--resume-last`) write a delta brief: only what changed or what to fix.

Dispatch with [dispatch-and-poll.md](dispatch-and-poll.md), then review and commit with
[review-and-land.md](review-and-land.md).
