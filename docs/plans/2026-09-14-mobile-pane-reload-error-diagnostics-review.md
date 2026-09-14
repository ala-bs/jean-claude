# Mobile dev pane — Reload error diagnostics — Review

Date: 2026-09-14

Scope: the uncommitted working diff only (3 files). `git log merge-base..HEAD`
is empty — `ec578952` is already on the base branch, so it was not re-reviewed.
Three rounds: 5 parallel correctness lenses → conformance → 6 adversarial
verifiers, plus live probes against a real `expo start` and the real Electron
42.7.0 main process.

The diff under review was my own diagnostics change. Three of its five findings
were defects I introduced.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
|---|---|---|---|---|---|
| 1 | High | Every unreachable-Metro error rendered as `Could not reach Metro dev server at localhost:8081 ()` — a dangling empty paren, strictly *worse* than the message it replaced, and identical for all three failure causes | The handler mined `event.error?.message ?? event.message ?? 'connection failed'`. undici's `failWebsocketConnection` dispatches an ErrorEvent whose `error` is a **message-less** `TypeError` and whose `message` is `''`. `??` does not fall through on empty string, so the fallback was unreachable — and the real `ECONNREFUSED` is swallowed inside undici and never reaches the event at all. The premise written into my own comment was factually wrong | Stopped mining the event. The cause is now established **out-of-band** by `describeMetroPort`: a `node:net` connect probe on both loopback hosts, then Metro's own `/status` endpoint (`packager-status:running`) to separate "a server, but not Metro" from "Metro, but it refused the socket" | `electron/services/mobile-preview-dev-menu.ts` |
| 2 | Medium | Toast read `Reload failed on Metro :8081 (reported by the running dev server command): Could not reach Metro dev server at localhost:8081 (…)` — port twice, "Metro" twice, cause pushed far to the right | The message was composed independently on both sides of the IPC boundary; the renderer prefix repeated the port that the main-process message had just started including | Renderer now contributes only what it alone knows — the port's *provenance*. The main-process message owns the port and the cause | `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx` |
| 3 | Medium | The new test passed green against the broken output, locking bug #1 in | `rejects.toThrow(String(deadPort))` asserted only the port, which is in the template literal unconditionally — the test's name promised "and the underlying reason" but nothing pinned it | Two tests that assert the actual classification, plus an explicit `not.toContain('()')` regression pin. Both are mutation-proven (below) | `electron/services/mobile-preview-dev-menu.test.ts` |
| 4 | Low | Test could be stolen by a squatter: hardcoded 59123 sits inside Darwin's ephemeral range (`net.inet.ip.portrange.first: 49152`) | Hardcoded port instead of an OS-guaranteed-free one | Bind-then-close via the existing `startFakeMetro()` helper, so the OS guarantees the port was free | `electron/services/mobile-preview-dev-menu.test.ts` |
| 5 | Low | Diagnosis would report "nothing is listening" for a server bound to `::1` only | My first version of `describeMetroPort` probed `127.0.0.1` only, while the websocket path tries two hosts — and it probed it twice | Mirrors the socket path's host list exactly; single probe per host | `electron/services/mobile-preview-dev-menu.ts` |

Findings 1 and 5 were introduced by this diff; 3 and 4 are its tests; 2 is the
interaction between the two halves of the diff.

## Follow-up fix — false "No app is connected" (reported after the review)

| Severity | Symptom | Root cause | Fix |
|---|---|---|---|
| High | Toast says "No app is connected to Metro on :59107, so there was nothing to reload" while the app visibly reloads | The peer count is a single instantaneous sample. expo-dev-launcher drops and rebuilds its `/message` socket after *every* reload, so a second reload — or one issued shortly after a Fast Refresh — samples the gap and sees zero for a live app. `ec578952` moved the count *before* the broadcast to dodge the post-reload teardown, but the same cycle leaves the client disconnected *before* the next reload too. A single sample cannot distinguish "no app" from "app between sockets" | On a zero count, wait out the reconnect (`waitForMetroClient`, 1 s) before concluding. This also fixes a silent delivery failure: the broadcast was being fired into the gap |

Measured sweep of the dev client's reconnect delay, before → after:

```
  reconnect   BEFORE                          AFTER
   50 ms      reported 1  delivered ✅         reported 1  delivered ✅
  100 ms      reported 1  delivered ✅         reported 1  delivered ✅
  150 ms      reported 0  delivered ✅  ← your toast      1  delivered ✅
  200 ms      reported 0  delivered ✅  ← your toast      1  delivered ✅
  250 ms      reported 0  delivered ❌  ← silent loss     1  delivered ✅
  300 ms      reported 0  delivered ❌  ← silent loss     1  delivered ✅
  400 ms      reported 0  delivered ❌  ← silent loss     1  delivered ✅
```

Genuine "no app running" still reports 0, at a cost of ~1.4 s on that error path.

## Before / after

```
CAUSE OF A FAILED RELOAD

  BEFORE (this diff, broken)          AFTER
  ws onerror ──▶ event.error.message  ws onerror ──▶ (no cause available — don't ask)
                 = ""                        │
                 event.message = ""          ▼
                 ?? never fires        user-initiated send only:
                       │                describeMetroPort(port)
                       ▼                     │
    "…at localhost:8081 ()"            net.connect 127.0.0.1 → ::1/localhost
    identical for all 3 causes               ├─ refused ──▶ "nothing is listening on :8081 —
                                             │              the dev server is not running there"
                                             └─ connected ──▶ GET /status
                                                    ├─ packager-status:running ──▶ "Metro is running
                                                    │                but refused the socket"
                                                    └─ anything else ──▶ "something is listening
                                                                         on :8081, but it is not Metro"

WHO SAYS WHAT (fix #2)
  main process : the port + why it failed
  renderer     : where that port came from   ← the only fact it uniquely holds
```

## Refuted findings

| Claim | Why it was not a bug |
|---|---|
| `portSource` misattributes when `devServerStatus.ports` is empty while status is `running` | `ports` can never be empty for this command id. Both starters pass `ports: [configuredDevServerPort]`; `resolveEffectivePorts` returns single-element arrays on every path and `return declaredPorts` otherwise; the output-learned port only ever *replaces* with `[observedPort]`. The `?? configuredDevServerPort` branch is dead code here, so the attribution cannot be false |
| The new `log()` in `onerror` doubles log volume and wipes the 500-entry activity-center buffer during a 60 s poll wait | Real arithmetic is 3→5 lines per iteration (1.67×), not 2×, and the pre-existing code already emits ~720 lines in that window — 1.4× `MAX_LOGS`. The buffer is evicted identically with or without the diff, so it is not a regression introduced here. (The line was removed anyway as part of fix #1, since it would have logged an empty reason) |
| Last-wins rethrow means the user always sees `localhost`, discarding a more informative `127.0.0.1` error | Node's Happy Eyeballs (`getDefaultAutoSelectFamily() === true`) makes the `localhost` attempt fall through to IPv4: measured `127.0.0.1 CONNECTED OK / localhost CONNECTED OK` against a v4-only server. Both attempts fail identically, and per finding #1 neither carried any reason at all |
| The new test can burn 16 s (4 connect attempts × 4 s) and blow vitest's default 5 s timeout | Loopback never DROPs — the kernel returns RST synchronously. Measured: **30 ms**. The firewall scenario is hypothetical |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
|---|---|---|
| The prefix `Reload failed (port reported by the running dev server command): ` is applied to *every* reload error, including ones where the port is irrelevant (`WebSocket is not available in this runtime`, IPC transport failures, and `Metro did not accept the reload command in time` — which means Metro *was* reachable) | (a) keep the blanket prefix — provenance is almost always the relevant fact for this button; (b) only attach provenance to reachability errors, leaving other failures bare, which needs an error-kind discriminator across IPC | Keep (a). The misleading cases are rare and internal, and (b) adds a typed-error contract across the IPC boundary for a copy improvement — that is a design change, not a review fix |

## Not fixed (noted only)

| Issue | Why deferred |
|---|---|
| `summarizeDeviceActionError`'s 200-char cap is applied *before* the renderer prepends its prefix, so a toast can exceed it | Pre-existing pattern (`index.tsx:541` does the same); fix #2 shortened the prefix, reducing the overshoot |
| `handleRestartApp` / `handleBootDevice` still show a bare summary, so reload failures are now phrased differently from restart failures | Out of diff scope; the sibling preview pane's `runAction('Failed to reload Expo', …)` is a third phrasing. Unifying pane toast conventions is its own change |
| `jc:*` debug logging is force-enabled with no `isPackaged` guard (`electron/lib/debug.ts:26`), so all `dbg` output reaches production users' activity center | Pre-existing and repo-wide, not introduced here — but worth a follow-up |

## Verification

- **Live `expo start` on this machine, through the shipped module:**
  - real Metro `:8081` → `{ connectedClients: 0 }` (happy path unchanged)
  - live non-Metro server `:8788` → `something is listening on :8788, but it is not a Metro dev server`
  - dead `:59321` → `nothing is listening on :59321 — the Metro dev server is not running on that port`
  - `curl :8081/status` → `packager-status:running`; `curl :8788/status` → a JSON 404, confirming the discriminator.
- **Real Electron 42.7.0 main process**, all three failure modes: `error.message=""`, `event.message=""`, `onclose` = empty `1006` — the evidence behind fix #1.
- **Mutation-tested both new tests** so they cannot be tautological:
  disabling the `!statusHost` branch fails *"reports an empty port as nothing is listening"*;
  forcing the `/status` check to `true` fails *"distinguishes a live non-Metro server from a missing one"*.
- `pnpm ts-check` → clean. `pnpm lint` → clean, no warnings.
- `pnpm test` → **5749 passed, 1 skipped, 1 failed.** The failure is a
  pre-existing intermittent flake, not this diff: three consecutive full runs
  failed in *different* files (`ui-pr-run-control` ×2, `merge-conflict-tracker`
  ×1), each passes in isolation (37/37 and 15/15), and none touch mobile
  preview.
