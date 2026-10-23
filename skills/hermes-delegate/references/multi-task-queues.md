# Multi-task queues

The single-task loop scales to a queue: a removal across layers, a migration across files, or a
refactor sweep. Sequencing and bookkeeping make it trustworthy.

## Run sequentially, one commit per task

Run tasks **one at a time, in dependency order**, landing each after review and gates before
dispatching the next:

```bash
node "<skill-dir>/scripts/relay.mjs" --brief task-01.txt --cd /path/to/repo
```

- Later briefs can rely on earlier work only after it lands.
- One commit per task keeps history reviewable and each step revertible.
- A clean tree before each dispatch keeps `touchedFiles` honest.
- You run the gates between tasks, whatever Hermes reported.

Use parallel runs only for genuinely independent tasks in separate working trees. Sequential is
the default because it preserves clean task boundaries.

## Watch the provider between tasks

Without `--model` and `--provider`, Hermes picks from its configured chain, and a provider that runs
out mid-queue silently moves the next task to the next entry. Check `hermes auth list` before a long
queue, and read `finalMessage` on any failed run for the provider's own message. Pin `--provider`
and `--model` when the queue must stay on one account or price.

## Carry decided constraints forward

Fresh Hermes sessions do not remember earlier tasks in the run, although Hermes's memory may carry
some facts across sessions. If task 2 chooses a helper name, fixture location, or interface that
task 5 needs, write that fact into task 5's brief.

Use a resumed session only for rework on the same task: `--session <id>` with the `sessionId` from
`result.json`, or `--resume-last` for the most recent session in this directory, with a delta brief.

## Keep a progress file

For more than two or three tasks, maintain one progress file beside the work:

- **Status table** - queued / at-implementer / reviewed+committed, with the commit hash.
- **Per-task review notes** - what landed, what you verified, and gate outcomes.
- **Needs your eyes** - design decisions, non-blocking nitpicks, and questions for the human.
- **End-of-run checklist** - the final cross-task verification.

Update it when each task lands, not in one batch at the end.

## Close with a coherence check

After the last task:

- Run the full test/build once more.
- Search repo-wide for the thing the queue changed.
- Replay migrations from a clean state and check drift when applicable.
- Push and open or update the PR only after the final tree is coherent.

## When to stop and ask

Proceed on work that follows from the agreed plan. Stop and surface when:

- A task cannot be completed correctly within its brief.
- A task needs `--yolo` or a model that spends a metered balance.
- Review calls the plan itself into question.
- Gates reveal a problem affecting already-landed tasks.
- Every provider in Hermes's chain is exhausted: fixing a login or adding credit is the human's job.

Report the landed state, commit hashes, and open question, then wait.
