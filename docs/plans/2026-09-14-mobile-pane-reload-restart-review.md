# Mobile dev pane — Reload / Restart fix — Review

Date: 2026-09-14

Scope: the uncommitted working diff (no commits on the branch, no design/plan
artifact existed). 14 files, ~570 added lines. Three rounds: 5 parallel
correctness lenses → conformance → 5 adversarial verifiers + a live-Metro /
live-simctl probe pass.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
|---|---|---|---|---|---|
| 1 | High | On older Xcode, Restart fails outright with `Invalid device: --terminate-running-process`; the sequential fallback never runs | The fallback predicate matched `/unrecognized\|unknown\|illegal\|invalid option/`. simctl has **no** unknown-option diagnostic — it swallows an unknown flag as the positional `<device>`. Compounding it, `buildCommandError` embeds the full argv in the message, so the predicate's other half (`/terminate-running-process/`) matched *every* failure and discriminated nothing | Match simctl's real wording: `Invalid device: --terminate-running-process`, or a `Usage: simctl launch` dump. Renamed to `isUnsupportedTerminateRunningProcessError` | `electron/services/mobile-preview-ios-bundle-resolver.ts`, `…-ios-idb-adapter.ts` |
| 2 | High | Reload reports "No app is connected… nothing to reload" for a reload that actually worked | The peer count was taken *after* the broadcast. expo-dev-launcher tears the app's `/message` socket down and rebuilds it ~100 ms after every reload, so the count raced the client's own reconnect | Count *before* broadcasting — the app is provably still attached at that moment | `electron/services/mobile-preview-dev-menu.ts` |
| 3 | High | The new "wait for the app before deeplinking" is a no-op whenever a second device is attached, so the restart crash returns | `waitForMetroClient` returned true for *any* peer > 0. The pane merges iOS + Android devices onto one Metro port, so another device's app satisfies the wait instantly | Snapshot peer ids before the restart and wait for an id *outside* that set. Metro's socket ids are unique per connection and never reused (verified live) | `…/mobile-dev-pane/utils-restart-app.ts`, `mobile-preview-dev-menu.ts`, IPC + types |
| 4 | High | A renderer passing `timeoutMs: undefined/NaN` spins an uncancellable poll loop in the main process for the life of the app | `Date.now() >= NaN` is always false, and the new IPC forwarded its payload unvalidated — unlike sibling channels, which are bounded by `DEV_COMMAND_TIMEOUT_MS` | Clamp to a finite, positive value capped at 60 s; stop forwarding renderer-supplied `pollIntervalMs` | `mobile-preview-dev-menu.ts`, `mobile-preview-service.ts` |
| 5 | Medium | Peer counts inflated: a reload looks delivered with nothing attached, and the restart wait returns immediately | Every socket this module opens is itself a Metro peer and lingers 100 ms past its logical end. **Measured against a live `expo start`: three concurrent counts with one app attached each returned 3** | Serialize socket work per Metro port (per-port, not global, so one dead port can't stall another task's pane) | `mobile-preview-dev-menu.ts` |
| 6 | Medium | The full preview pane still reports success for a reload that reached nobody — the exact bug being fixed, in the sibling pane | The new `connectedClients` result was awaited and discarded there | Surface zero-client as an error through the pane's existing `runAction` channel | `…/mobile-preview-pane/use-mobile-preview-actions.ts` |
| 7 | Low | An unrelated relayed message carrying a `result` object is read as the peer map; its key count becomes the app count | The `getpeers` reply was matched by shape only. Metro relays other clients' broadcasts down the same socket. The request id was sent but never checked | Match on the request id; reject arrays | `mobile-preview-dev-menu.ts` |
| 8 | Low | A restart that succeeded is reported as "restart failed" if the readiness IPC rejects | The new `waitForMetroClient` call was unguarded, unlike the `launchExpo` call below it, which deliberately degrades to a warning | Swallow to `false`, same rationale as the deeplink step | `…/mobile-dev-pane/utils-restart-app.ts` |
| 9 | Low | Test could not fail: the fake relayed every method, so it would have passed for the old broken `sendDevCommand` payload | The fake was written to match the implementation instead of Expo's protocol | Fake now enforces `CLIENT_BROADCAST_ALLOWED_METHODS`; the test asserts the **app received** the command, not the payload shape | `mobile-preview-dev-menu.test.ts` |
| 10 | Low | "waits for a late-connecting app" never exercised the retry loop — the app was connected before the call | Test-authoring slip | Connect 150 ms after the wait starts | `mobile-preview-dev-menu.test.ts` |
| 11 | Low | Misleading comment: claimed Android's device-level fallback "hid" the dev-menu bug | That fallback only runs when the send *throws*; the old payload was accepted and dropped, so it never ran on either platform | Comment corrected | `mobile-preview-dev-menu.ts` |

## Before / after

```
RELOAD — peer count ordering (fix #2)

  BEFORE                                    AFTER
  broadcast reload ──▶ app                  count peers ──▶ 1  ✅ app is attached
        │                │                        │
        │          app drops socket               ▼
        │          (dev-launcher, ~100ms)   broadcast reload ──▶ app
        ▼                                              (socket may now drop;
  count peers ──▶ 0  ❌ "nothing to reload"             we already have the answer)


RESTART — readiness predicate (fix #3)

  BEFORE:  any peer > 0 ?
           ┌── iOS app (restarting, not yet up)
           └── Android app on the SAME Metro ──▶ count=1 ──▶ true instantly
                                                            └─▶ deeplink into
                                                                booting app 💥

  AFTER:   snapshot {socket#7 android, socket#9 old ios}  ← taken BEFORE the kill
           poll ─▶ {socket#7} .............. no new id, keep waiting
           poll ─▶ {socket#7, socket#12} ... socket#12 is new ──▶ true
                                                            └─▶ deeplink lands
                                                                on a live app ✅

SELF-COUNTING (fix #5) — measured against real Metro
  unserialized: [count, count, count] concurrently, 1 app  ──▶ 3, 3, 3  ❌
  per-port queue:                same test              ──▶ 1, 1, 1  ✅
```

## Refuted findings

| Claim | Why it was not a bug |
|---|---|
| A single `waitForMetroClient` poll can block ~16 s because a foreign server accepts the upgrade but never answers | The wait only runs when `resolveRestartReattach` confirms `hasLiveDevServerPort`, i.e. it is our own running Metro command on that exact port. The residual case is Metro being slow, which is what the 8 s budget is for |
| The just-killed app's socket is still a peer on the first poll, satisfying the wait | `simctl launch --terminate-running-process` is one command that returns only after the new process spawns; the kernel closes the dead process's sockets at kill time, well before the IPC round-trip reaches the poll. (The *other-device* variant of this claim was real — fix #3) |
| The `closeFallback` timer resolves with the socket still open, so the reload self-counts | Live test: send-then-count with no app attached returns 0, so the normal close path is clean. Requires a server that never completes the close handshake; real Metro does. Narrowed to theoretical, and fix #5 removes the overlap anyway |
| An unrelated broadcast reliably hijacks the peer count | Live probe: count stayed correct — the reply arrives in microseconds locally, so the window is sub-millisecond. Hardened anyway (fix #7) since it is two lines |
| Restart button is silently dead for a different device mid-restart | Real, but the guard and `disabled` expression are both pre-existing and unchanged by this diff — see "Not fixed" |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
|---|---|---|
| `connectedClients === -1` ("could not determine") is reported to the user as plain success | (a) keep silent — a failed peer query does not mean the reload failed; (b) show a muted "sent, could not confirm" notice. Both defensible; it is a copy/UX call | Keep (a) as-is. The sentinel is documented in the shared type, and adding a third message state to a narrow pane is a product decision, not a correctness one |

## Not fixed (noted only)

| Issue | Why deferred |
|---|---|
| Restart button renders enabled + idle for a *different* device while a restart is in flight; clicking it is a silent no-op (`index.tsx` guard `restartingDeviceKey !== null` vs `disabled={!activeDeviceKey \|\| !isActiveDeviceBooted}`) | Pre-existing; this diff only lengthens the window. Out of diff scope |
| `pnpm-lock.yaml` shows ~380 changed lines bumping `@oxc-parser` 0.146 → 0.148 | Pre-existing drift: reproduced by a plain `pnpm install` from the committed lockfile, because `oxlint: ^1.70.0` floats. Not introduced by adding `ws`, and the lockfile must contain `ws` for `--frozen-lockfile` CI |
| Android device-level dev-menu fallback (`adb shell input keyevent 82`) is now near-dead code | It only ever ran when Metro was unreachable; unchanged by this diff |
| No cancellation/dispose hook on `waitForMetroClient` (no `AbortSignal`, unlike `activeIosAppRestarts`) | Now bounded to ≤60 s and per-port serialized, so it cannot run away. A cancellation channel is a larger design change |

## Verification

- `pnpm test` → **444 files passed, 1 skipped; 5748 tests passed, 0 failed.**
  (Pre-review baseline on a clean stash had 5 failures, so this is a strict improvement.)
- `pnpm lint` → clean, no warnings. `pnpm ts-check` → clean.
- **Live `expo start` end-to-end** against the shipped module: peers `[]` → `['socket#18']`;
  `sendMetroReloadCommand` → `{connectedClients: 1}`; app received both
  `{"method":"reload"}` and `{"method":"devMenu"}`; wait ignoring the existing peer → `false`;
  wait after a new peer attaches → `true`; `timeoutMs: NaN` returned `false` in 210 ms.
- **Live `simctl`** ground truth for fix #1: `Invalid device: --this-flag-does-not-exist`
  and a `Usage: simctl launch …` dump; the old regex matched neither.
- **Mutation-tested the two headline fixes** to prove the tests are not tautological:
  removing the serializer fails "does not count its own concurrent sockets";
  moving the count back after the broadcast fails "counts the app that reloading disconnects".
- New/updated tests: 10 in `mobile-preview-dev-menu.test.ts`, 12 in
  `utils-restart-app.test.ts`, 17 in `mobile-preview-ios-app-status.test.ts`.
