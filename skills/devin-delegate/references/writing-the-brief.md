# Writing the brief

A brief is the entire task as Devin will see it. It runs in a separate session with **no memory of
your conversation and no shared context**: only the text you send and whatever it can inspect in
the workspace. If a constraint is not in the brief or discoverable in the repo, it does not exist
for Devin.

Devin loads its configured rules and skills (see `devin rules` and `devin skills`) into print-mode
runs too. Still restate load-bearing repo constraints in the brief so Devin does not have to infer
which rules matter for this task.

## Model choice

The relay defaults to `swe-2-high`, which `devin models list` tags `Free`. `swe-2-medium` is the
faster free choice for small, mechanical briefs; `swe-2-max` is the free choice for harder ones.
Pass a paid model only when the human asked for it, and then with `--allow-paid`.

## File tools, and who runs the gates

Under the default `accept-edits` mode Devin may edit files with its file tools and run read-only
commands, but print mode rejects anything that needs confirmation, and a rejected call ends the run
with no report. Two live runs showed where that bites:

- **Shell writes.** Asked to create a file, SWE-2 High wrote it with `printf ... > file` through
  its shell tool; that call was rejected and the run ended with nothing written. The same brief
  plus a `<tooling>` block telling Devin to use only its file write and edit tools completed. Put
  that block in every write brief.
- **Gates.** A test-runner style command (`node -e ...`) was rejected under `accept-edits`, and in
  one attempt under `smart` too. Do **not** ask Devin to run the test, lint, or build commands.
  Name them in the brief as context so Devin writes code that passes them, and run them yourself in
  review.

Only if the human opts in to `--permission-mode smart` or `dangerous` should the brief ask Devin
to run gates. `smart` decides per command and may still reject one.

## The shape that works

Use a compact, block-structured brief. State the task, what done means, the few constraints that
matter, and the report Devin must return.

```xml
<task>
One or two sentences: the concrete job and where it lives. Then the specifics - current state, what to
change, and explicitly what to leave untouched. The leave-untouched list prevents unrelated refactors.
</task>

<tooling>
Create and edit files only with your file write and edit tools. Never change files through shell
commands (printf, echo, cat, sed, redirections): in this run those are rejected and end it.
</tooling>

<gates_context>
The reviewer will run these after you finish; write code that passes them. Do not run them yourself:
  <the project's real test command>
  <the project's real lint/format command>
  <the project's real build/typecheck command>
</gates_context>

<action_safety>
Keep changes scoped to the task. No unrelated refactors, renames, or cleanup unless required for
correctness. Do NOT run git add or git commit - the orchestrator commits after reviewing. Leave the
work uncommitted in the working tree.
</action_safety>

<structured_output_contract>
End with a report in this exact shape:
  1. What changed and why
  2. Files touched
  3. Anything you could not verify without running the gates
  4. Anything you deviated on, left open, or want a decision on
</structured_output_contract>
```

Add extra blocks only when the task needs them:

- **Debugging or open-ended fixes** - add `<completeness_contract>` (resolve fully, not just the
  first plausible cause) and `<missing_context_gating>` (find missing repo facts or state what is
  unknown).
- **Research or review** - add `<research_mode>` (separate observed facts, inferences, and open
  questions), and dispatch with `--read-only`. Do not ask a read-only brief to write files or run
  side-effecting commands: Devin will reject the call and end the run.

## Always ask for the report explicitly

`finalMessage` is what Devin prints at the end. Without a closing summary, the edits may exist but
the result is hard to review. The `<structured_output_contract>` block makes the expected report
explicit.

## Discover the real gates

Read the repo's `AGENTS.md`, `CLAUDE.md`, `Makefile`, `package.json`, or equivalent first and copy
the actual commands into the brief. A brief that says only "the tests" makes the implementer guess.

## One task per brief

Keep each brief bounded. One brief -> one Devin run -> one reviewed commit keeps the diff and
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

<tooling>
Create and edit files only with your file write and edit tools. Never change files through shell
commands (printf, echo, cat, sed, redirections): in this run those are rejected and end it.
</tooling>

<gates_context>
The reviewer will run, and these must pass:
  pytest tests/billing/ -q
  ruff check services/billing/
Do not run them yourself.
</gates_context>

<action_safety>
Scope strictly to the refund idempotency fix. No unrelated refactors. Do NOT git add or commit; leave
changes in the working tree for review.
</action_safety>

<structured_output_contract>
Report: (1) the root cause and fix, (2) files touched, (3) what you could not verify without the
gates, (4) anything left open or needing a decision.
</structured_output_contract>
```

## Brief delivery

The relay writes the brief to the run's `brief.txt` and hands it to Devin with `--prompt-file`.
The brief content never rides argv: it stays out of the host process list, is not bounded by the
OS arg-length cap, and a brief that starts with "-" cannot be misread as a flag. On a shared
machine keep secrets out of the brief anyway; reference them by a path or environment variable the
workspace can read. Note that Devin's exported `trajectory.json` repeats the brief.

On resume (`--session` / `--resume-last`) write a delta brief: only what changed or what to fix.

Dispatch with [dispatch-and-poll.md](dispatch-and-poll.md), then review and commit with
[review-and-land.md](review-and-land.md).
