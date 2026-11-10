# Renderer freeze investigation

The intermittent multi-second renderer freezes are **not yet fully attributed**, but the 2026-11-10 capture settled two of the three signals in the log. Read "Confirmed from the 2026-11-10 capture" below before interpreting a new capture: most lines in an older log are an artifact, not a freeze. The `diagnose-renderer-ipc-freezes` branch adds timing diagnostics so the next occurrence can identify where time was spent. Do not change a query or polling path based only on a slow IPC round trip; correlate the events below first.

## Capture the next occurrence

1. Run a build containing this instrumentation. Use the app normally until a freeze occurs.
2. Note the approximate time, active screen, and whether an agent or background job was running.
3. Read `<Electron userData>/logs/performance.log` immediately after the freeze. On a normal macOS install, this is `~/Library/Application Support/jean-claude/logs/performance.log`. A `dev:tmp` instance uses its isolated `chromium-user-data/logs/` directory instead. The file survives app restarts; `performance.log.1` holds the preceding segment after rotation.
4. Bring the lines from about 30 seconds before through 30 seconds after the freeze into the next investigation session. The log records channel names and SQL shapes, not IPC arguments or SQL parameters, but review it before sharing.

The log keeps at most two 2 MiB segments. It records only events over these thresholds:

| Event | Threshold | Meaning |
| --- | ---: | --- |
| `Renderer event loop delayed` | 250 ms | Renderer JavaScript or Chromium scheduling stalled. |
| `Main event loop delayed` | 250 ms | Main-process JavaScript, synchronous SQLite, or scheduling stalled. |
| `IPC <channel> took` | 500 ms | Renderer observed a slow round trip, which may include intentional network or background work. |
| `Slow query` | 100 ms | Kysely observed a slow SQL execution; the SQL text is truncated and string literals are masked. |

## Interpret the capture

```text
Slow query + main delay + slow IPC  -> inspect that SQL and its call site
Main delay without slow query      -> inspect synchronous main-process work
Renderer delay without main delay  -> profile React/rendering or renderer work
Slow IPC alone                     -> inspect the handler and external I/O
```

An IPC duration alone does not prove the handler blocked either process. Query time and event-loop delay are independent signals. Match nearby timestamps and repeat the same action if possible. After identifying the cause, fix it, record the root cause in the task summary, and remove or narrow the instrumentation if the ongoing volume is unnecessary.

## Confirmed from the 2026-11-10 capture

The capture (09:34–10:48, 461 lines) contained three distinct signals. Only one
is a freeze.

### Resolved: `Renderer event loop delayed by ~900 ms` was an artifact

About 60% of that capture was a steady `900 ms` "delay" arriving exactly once
per second, in bursts lasting minutes, with no other event nearby.

Chromium clamps timers in a hidden or occluded renderer to one per second, and
`webPreferences` never sets `backgroundThrottling: false`. The monitor in
`electron/preload.ts` ticks on `setInterval(…, 100)` and reports
`elapsed - 100`, so a backgrounded window reports `1000 - 100 = 900 ms`
forever:

```text
visible:  |--100--|--100--|--100--|   delay ~ 0     real measurement
hidden:   |---------1000---------|    delay = 900   clamp artifact
```

**Fixed** by thresholding on visibility: `250 ms` while visible, `2000 ms` while
hidden (above the 1 Hz clamp, so a genuine freeze in the background is still
captured), and every line now carries `visibility=` and `wallDrift=`.

### Resolved: `feed:getTaskItems` at ~2.5 s, firing ~9x more often than designed

`src/hooks/use-feed.ts` sets a 3-minute `refetchInterval`, yet the capture shows
the call every 20–30 s, each taking 2.0–2.8 s. Two independent causes compound:

1. **The interval is a floor, not a ceiling.** `markResourceStale('feed:tasks')`
   sets `meta.stale`, and the effect in `src/cache/use-cache-resource.ts`
   reacts by loading immediately, bypassing `staleTime` entirely. Two paths call
   it per agent event: `invalidateTaskFeed` in
   `src/features/agent/task-message-manager/index.tsx` (on every `status`,
   `permission`, `permission-resolved` and `question`) and `markTaskFeedStale`
   in `src/cache/cache-events.ts` (on every task/step upsert, patch and delete).
   While an agent streams, the feed reloads continuously.
2. **Each reload is expensive**, and not because of SQL — no query exceeded the
   100 ms threshold in the whole capture. `electron/services/feed-service.ts`
   runs 2–3 `git status` subprocesses per task with a worktree (batched only
   10-wide), then sequential Azure DevOps round trips per PR, over an un-LIMITed
   task set. The handler also calls `getTaskFeedItems()` with no `prItems`, so
   the PR cache is always empty. `TaskStepRepository.findByTaskIds` additionally
   `selectAll()`s the `task_steps.output` blob and runs four unused
   `JSON.parse` per step.

A slow `feed:getTaskItems` is therefore expected to be slow; the defect is the
rate.

**Cause 1 is fixed.** `useCacheResource` takes an opt-in
`staleReloadDelayMs`, and `useTaskFeedItems` sets it to 2000 ms: a stale mark
now schedules the reload instead of running it, so every mark arriving inside
the window collapses into one load. The window is not restarted by further
marks, so latency stays bounded at 2 s rather than starving under a continuous
event stream. Default stays `0`, leaving every other resource's immediacy
untouched.

Note what this does and does not buy. A burst of agent events now costs one
reload instead of one per event. But in the pathological case of a permanently
streaming agent the ceiling is still one reload per `2 s + load duration`, so
**cause 2 is what bounds the worst case** and is still open:

- `feed:getTaskItems` passes no `prItems`, so the PR cache is never used and
  every linked PR is re-fetched over the network on every load.
- `TaskStepRepository.findByTaskIds` `selectAll()`s the `task_steps.output`
  blob and runs four unused `JSON.parse` per step, though the feed reads only
  `status`, `name` and `updatedAt`.
- `enrichTaskFeedItemsWithPrStatus` awaits `reconcilePrWorkspaceState` one PR
  at a time, unbounded in N.
- The task set has no `LIMIT`, and `tasks` is scanned twice per call with no
  index on `userCompleted`, `createdAt`, `type` or `prWorkspaceState`.

The durable fix is to split the payload: serve the cheap DB read on every
invalidation and rate-limit only the git/network enrichment.

### Open: the real freeze

At 10:45–10:47 the main and renderer loops stalled **together, with matching
timestamps and durations** (3331/3316, 18365/18315, 47007/47395 ms) while the
rest of the machine stayed responsive. Main-process JavaScript cannot block the
renderer's timer, so this is not app code blocking a loop — both processes were
simply not scheduled. Nearby: `tasks:createWithWorktree` took 31 s then 16 s.

The instrumentation added for the next capture answers this directly:

```text
cpu~100% of the stall -> this process ran; our own code blocked. Profile it.
cpu~0%   of the stall -> this process was never scheduled (App Nap, occlusion,
                         swap-in, or a sibling process of ours burning the CPU).
wallDrift >> 0        -> the host suspended, rather than merely descheduling us.
spans=[...]           -> which IPC handlers were in flight when it happened.
<type>:<name> cpu=..% -> which of our own processes was the one burning CPU.
```

Each main-loop stall line now ends with that data, so a single new occurrence
should distinguish "we did it to ourselves" from "the OS parked the app".

## Preserved evidence: the 2026-11-10 capture

`performance.log` keeps only two 2 MiB segments and this capture is already
rotated out, so the lines the conclusions above rest on are reproduced here
verbatim. A later session can reason about them without the original file.

Counts across the whole capture (09:34–10:48, 461 lines): **0** `Slow query`
events, **10** main-loop stalls, **~400** renderer-loop stalls of which about
340 were the 1 Hz clamp artifact.

### The clamp artifact (now suppressed)

A full minute of it, arriving exactly 1.000 s apart with nothing else nearby.
Any future capture showing this shape is a backgrounded window, not a freeze:

```text
2026-11-10T09:39:00.083Z renderer Renderer event loop delayed by 898 ms
2026-11-10T09:39:01.085Z renderer Renderer event loop delayed by 901 ms
2026-11-10T09:39:02.084Z renderer Renderer event loop delayed by 900 ms
2026-11-10T09:39:03.085Z renderer Renderer event loop delayed by 900 ms
2026-11-10T09:39:04.084Z renderer Renderer event loop delayed by 900 ms
...53 consecutive lines, all 898-902 ms...
```

### The chronic feed cost

`feed:getTaskItems` at 2.0–2.8 s, recurring every 20–30 s against a designed
3-minute interval. Note `tasks:createWithWorktree` at 31 s, and that no `Slow
query` line accompanies any of it:

```text
2026-11-10T10:38:18.362Z renderer IPC feed:getTaskItems took 2093 ms
2026-11-10T10:38:23.995Z renderer IPC feed:getTaskItems took 1944 ms
2026-11-10T10:38:26.981Z renderer IPC feed:getTaskItems took 2057 ms
2026-11-10T10:38:41.312Z renderer IPC feed:getTaskItems took 2657 ms
2026-11-10T10:39:41.753Z renderer IPC feed:getTaskItems took 2784 ms
2026-11-10T10:40:24.047Z renderer IPC feed:getTaskItems took 2825 ms
2026-11-10T10:40:36.783Z renderer IPC feed:getWorkItemItems took 4024 ms
2026-11-10T10:40:37.017Z renderer IPC feed:getPullRequestItems took 4259 ms
2026-11-10T10:43:03.126Z renderer IPC tasks:createWithWorktree took 31114 ms
2026-11-10T10:44:15.129Z renderer IPC feed:getPullRequestItems took 4867 ms
```

### The unexplained freeze

The key observation is the pairing: main and renderer stall with matching
timestamps and matching durations. Main-process JavaScript cannot block the
renderer's timer, so neither process was blocked — **neither was scheduled**.
The user confirmed the rest of the machine stayed responsive during this.

```text
2026-11-10T10:45:21.579Z main     Main event loop delayed by 3331 ms
2026-11-10T10:45:21.592Z renderer Renderer event loop delayed by 3316 ms
2026-11-10T10:45:48.647Z main     Main event loop delayed by 18365 ms
2026-11-10T10:45:48.667Z renderer Renderer event loop delayed by 18315 ms
2026-11-10T10:45:51.175Z main     Main event loop delayed by 1718 ms
2026-11-10T10:45:51.176Z renderer Renderer event loop delayed by 1668 ms
2026-11-10T10:46:38.683Z main     Main event loop delayed by 47007 ms
2026-11-10T10:46:38.688Z renderer Renderer event loop delayed by 47395 ms
2026-11-10T10:46:44.698Z main     Main event loop delayed by 3145 ms
2026-11-10T10:46:47.629Z renderer IPC feed:getWorkItemItems took 8345 ms
2026-11-10T10:47:19.303Z renderer IPC tasks:createWithWorktree took 16215 ms
```

Environment at the time: `jean-claude.db` was 3.4 GB (plus a 2.3 GB
`jean-claude.db.bak`), and a 31 s `tasks:createWithWorktree` sat immediately
before the first stall.

## Where to pick this up

1. Run a build containing this instrumentation until a freeze recurs, then read
   the new `performance.log`. The artifact lines are gone, so the file should be
   short.
2. Read `cpu=` on the main-loop stall line first. It decides the whole
   investigation:
   - `cpu≈100%` — our own synchronous main-process work. Read `spans=[...]` on
     the same line for the IPC handlers in flight and profile that code path.
   - `cpu≈0%` — we were never scheduled. Check `wallDrift` (host suspended vs
     merely descheduled), `freeMem`/`rss` (memory pressure, which the 3.4 GB
     database would contribute to), and the per-process list for a sibling
     process of ours burning the CPU.
3. Only then decide whether the remaining `feed:getTaskItems` cost (cause 2
   above) is worth attacking, and whether the database size needs a retention
   policy. Both were deliberately left alone pending this answer.
