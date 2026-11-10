# Renderer freeze investigation

The intermittent multi-second renderer freezes are **not yet attributed to a root cause**. The `diagnose-renderer-ipc-freezes` branch adds timing diagnostics so the next occurrence can identify where time was spent. Do not change a query or polling path based only on a slow IPC round trip; correlate the events below first.

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
