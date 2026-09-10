# Run command groups: stages (sequential execution)

## Goal

Today a group is a flat set of command ids run with a single `Promise.all`. Make a
group an ordered list of **stages**; commands inside a stage still run in
parallel, stages run one after another.

```
GROUP "Dev stack"
┌──────────────────────────────────────────────┐
│ Stage 1                                      │
│   pnpm install          wait for exit ✓      │  spawn both, then block
│   pnpm db:migrate       wait for exit ✓      │  until both exit
│ ── delay 0ms ───────────────────────────────  │
│ Stage 2                                      │
│   pnpm server           wait for exit ✗      │  spawn, don't block
│   pnpm web              wait for exit ✗      │
│ ── delay 3000ms ────────────────────────────  │  readiness pause
│ Stage 3                                      │
│   pnpm e2e              wait for exit ✓      │
└──────────────────────────────────────────────┘
```

## Decisions (confirmed with user)

| Question | Decision |
| --- | --- |
| Model | Explicit stages; parallel within a stage |
| Stage advance | Per-entry `waitForExit` toggle. Stage completes when all its `waitForExit` entries have exited. Entries without it are fire-and-forget. |
| Failure | Non-zero exit ⇒ abort remaining stages. Already-started commands keep running (no teardown). |
| Ports | Keep the existing all-up-front batch check over the whole group (atomic: nothing starts if any port is blocked). |
| Ordering UI | Drag-and-drop inside the group card. |
| Duplicates | Allowed. A later occurrence of the same command id restarts it (one process per command id is a hard service limit). |
| Readiness | Optional per-stage `delayMs` pause after the stage completes. |

## Data model

`shared/run-command-types.ts`:

```ts
interface ProjectCommandGroupEntry { commandId: string; waitForExit: boolean }
interface ProjectCommandGroupStage {
  id: string;
  entries: ProjectCommandGroupEntry[];
  /** Pause after this stage completes, before the next stage starts. */
  delayMs: number;
}
interface ProjectCommandGroup {
  ...
  stages: ProjectCommandGroupStage[];
  /** Derived flattened+deduped membership, maintained on write. */
  commandIds: string[];
}
```

`commandIds` stays as a denormalized column so existing membership consumers
(`resolveProjectCommandAvailability`, `resolveRunCommandIds`, PR run control,
`removeCommandFromAllGroups`) keep working unchanged. The repository recomputes
it from `stages` on every write; `stages` is the source of truth.

## Migration `087_project_command_group_stages`

Add `stages` text column (JSON, default `'[]'`). Backfill every existing row to a
single stage containing its current `commandIds` with `waitForExit: false` and
`delayMs: 0` — exactly reproducing today's parallel behavior.

## Execution (`run-command-service.startGroupWithoutLock`)

Unchanged prologue: stop all unique members → `afterStop` → batch port check →
port overrides → run context. Then instead of one `Promise.all`:

```
for each stage:
  if cancelled -> bail
  for each entry: if its command id is already tracked, stop it first (duplicates)
  spawn every entry in the stage in parallel
  notifyStatusChange                       ← live status per stage
  await race(all waitForExit exitPromises, cancelSignal)
  if any exitCode !== 0 -> bail (leave running commands alone)
  await race(sleep(delayMs), cancelSignal)
```

### Cancellation — the non-obvious part

`withCommandLocks` holds every member's lock for the entire operation. A staged
run can last minutes, so a Stop request would queue behind the lock and appear
frozen. Fix: a per-task `CancelSignal` that stop paths raise **before** acquiring
any lock. The sequencer races every await against it and bails, releasing the
locks so the queued stop proceeds.

Two subtleties, both found in review:

- The signal must be **registered before the locks are acquired**, not just
  raised before them. The prologue (stopping members, `afterStop` hooks, port
  probes) runs *inside* the lock and takes seconds; a stop arriving in that
  window would otherwise find an empty run set, cancel nothing, and then queue
  behind the whole sequence. `startGroupAdmitted` registers, and the sequencer
  re-checks `cancelled` after the prologue.
- Cancellation is scoped to runs whose member set **intersects** the commands
  being stopped. Cancelling every run for the task would let an unrelated
  command's stop abort a healthy sequence.

`startCommand` deliberately does *not* cancel: an overlapping individual start
queues behind the group, as it always has. A sequence wedged on a `waitForExit`
command that never exits is escaped via Stop.

### The start acknowledgement is not the end of the sequence

`startGroup` resolves once the **first stage has spawned**, not when the whole
sequence finishes; the remaining stages continue in the background while still
holding the members' locks, tracked in `pendingStarts` so shutdown drains them.

This matters because callers hold their own locks while awaiting it. Before this
split, `startPrCommand` held the **PR lifecycle lock** for the entire sequence —
so a group with a `waitForExit` command that never exits would wedge PR
completion, deletion, and re-runs for that PR with no visible cause. The
renderer's `startingCommandIds` had the same problem: the run button showed
"starting" for the full run.

## Surfaces to update

- `startGroup` gains an optional `stages` param. Absent ⇒ one parallel stage
  (preserves ad-hoc multi-select and any legacy caller).
- `pr-review-task-service.startPrCommand` re-reads the group from the DB already;
  it forwards `group.stages` filtered to visible commands.
- `src/lib/run-command-items.ts` builds the run plan from group + commands,
  dropping hidden/missing commands and then empty stages.
- UI: `group-row.tsx` replaces the checkbox list + hard-coded "parallel" badge
  with stage sections (dnd-kit), per-entry wait toggle, per-stage delay input,
  add/remove stage.
