# Electron Install and Reload Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Guarantee that `pnpm install` produces a runnable Electron checkout and that preview reload exits the current app only after its replacement is ready.

**Architecture:** Add a root postinstall guard that invokes and verifies Electron's installer before native rebuilds. Stop active agents and commands before updating, then use ready-to-ack temporary-file handoff between the current preview and its replacement, with replacement-owned acknowledged cleanup, bounded startup logs, early-exit diagnostics, timeout, process termination, and retrying lock recovery.

**Tech Stack:** Node.js ESM scripts, Electron, TypeScript, Vitest, pnpm.

---

### Task 1: Add Electron Installation Guard

**Files:**
- Create: `scripts/ensure-electron-installed.mjs`
- Create: `scripts/ensure-electron-installed.test.ts`
- Modify: `package.json`

**Step 1: Write the failing tests**

Export an `ensureElectronInstalled` function with injectable package resolution and installer execution. Add tests proving that it:

- accepts a `path.txt` entry whose executable exists;
- invokes Electron's `install.js` before verification;
- rejects missing `path.txt`;
- rejects a `path.txt` entry whose executable is absent;
- propagates installer failure with an actionable message.

**Step 2: Run tests to verify failure**

Run: `pnpm test -- scripts/ensure-electron-installed.test.ts`

Expected: FAIL because the guard does not exist.

**Step 3: Implement the guard**

Implement an ESM script that:

```js
const electronPackagePath = require.resolve('electron/package.json');
const electronDirectory = dirname(electronPackagePath);
const installerPath = join(electronDirectory, 'install.js');
const result = spawnSync(process.execPath, [installerPath], { stdio: 'inherit' });
```

After installer success, read `path.txt`, resolve `dist/<path entry>`, and verify the executable exists. Execute the exported function when the script is run directly.

Update root postinstall ordering:

```json
"postinstall": "node scripts/ensure-electron-installed.mjs && electron-rebuild"
```

**Step 4: Run focused tests**

Run: `pnpm test -- scripts/ensure-electron-installed.test.ts`

Expected: PASS.

### Task 2: Add Reload Readiness Primitives

**Files:**
- Modify: `electron/services/reload-preview-service.ts`
- Modify: `electron/services/reload-preview-service.test.ts`

**Step 1: Write failing service tests**

Add tests for exported helpers that:

- atomically write a readiness marker only when a path is provided;
- atomically rename readiness to acknowledgment after the parent observes it;
- resolve when the marker appears;
- reject when the launched process exits before readiness;
- reject after a configurable timeout;
- include captured output in failures;
- leave startup logs available until the parent captures failure diagnostics;
- invoke replacement termination and failed-attempt cleanup on failure;
- let an acknowledged replacement own its log and acknowledgment cleanup on exit;
- retry single-instance lock recovery with bounded polling.

Use temporary directories and injected spawn, clock/polling, and termination boundaries. Do not launch Electron.

**Step 2: Run tests to verify failure**

Run: `pnpm test -- electron/services/reload-preview-service.test.ts`

Expected: FAIL because readiness helpers do not exist.

**Step 3: Implement readiness and launch helpers**

Add:

- `signalReloadPreviewReady({ readyFilePath })` using temporary-write plus rename;
- `launchReloadedPreview(...)` that creates readiness, acknowledgment, and log paths, launches `pnpm preview:skip-build`, waits for marker/exit/timeout, atomically renames ready to acknowledgment, and returns only after handoff;
- bounded output reading for failure messages;
- cross-platform detached-process-tree termination;
- parent cleanup for failed attempts after diagnostic capture;
- replacement-owned acknowledgment and log cleanup after an acknowledged exit;
- bounded retry handling when reacquiring the single-instance lock.

Pass `JC_PREVIEW_RESTART_READY_FILE`, `JC_PREVIEW_RESTART_ACK_FILE`, and `JC_PREVIEW_RESTART_LOG_FILE` only to the replacement through `getChildProcessEnv({ overrides })`.

**Step 4: Run focused tests**

Run: `pnpm test -- electron/services/reload-preview-service.test.ts`

Expected: PASS.

### Task 3: Signal Replacement Readiness

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/services/reload-preview-service.test.ts`

**Step 1: Add failing readiness-signal coverage**

Add focused coverage proving that no marker is written without the restart environment variable, signaling occurs only after the renderer load callback is invoked, and acknowledged replacements clean their acknowledgment and log on exit while failed startups preserve logs for parent diagnostics.

**Step 2: Run the focused test**

Run: `pnpm test -- electron/services/reload-preview-service.test.ts`

Expected: FAIL until startup wiring is added.

**Step 3: Wire readiness to main-window load**

Register process-scoped readiness handling before creating windows. In `createWindow`, attach a `did-finish-load` listener before loading the renderer. Read the restart ready, acknowledgment, and log paths at startup; signal only after the main renderer finishes loading; and allow a later window to retry if an earlier readiness signal fails.

When `JC_PREVIEW_RESTART_LOG_FILE` exists, start a replacement-only limiter early in main startup. Every five seconds, inspect the inherited stdout descriptor and truncate it when the shared log exceeds 1 MiB. Use the inherited descriptor rather than reopening the path, report limiter failures non-fatally, and clear the timer on process exit.

Log signaling failures without crashing an otherwise healthy replacement.

**Step 4: Run focused tests**

Run: `pnpm test -- electron/services/reload-preview-service.test.ts`

Expected: PASS.

### Task 4: Replace Blind Reload Exit

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/services/reload-preview-service.test.ts`

**Step 1: Add failing orchestration coverage**

Add service-level orchestration tests proving readiness is awaited before successful completion and startup failure is returned while the old process remains responsible for recovery.

Add coverage proving active agents and commands are both stopped before update work, lock recovery retries after an initial miss, exhausted recovery appends context without replacing the startup error, and notification failure cannot prevent current-app exit after successful handoff.

**Step 2: Run focused tests**

Run: `pnpm test -- electron/services/reload-preview-service.test.ts`

Expected: FAIL against the current 500 ms blind-exit behavior.

**Step 3: Update the reload handler**

Stop active agents with `agentService.stopAll({ reason: 'shutdown' })` and stop running commands before pull, install, build, or replacement launch. Replace the detached `spawn` plus 500 ms timer with awaited reload orchestration around `launchReloadedPreview(...)`.

Sequence:

1. Release the single-instance lock immediately before launch.
2. Await replacement readiness and ready-to-ack rename.
3. Send restarting progress best-effort and call `app.exit(0)` unconditionally after successful handoff.
4. On failure, retry `app.requestSingleInstanceLock()` for about two seconds, reset `previewReloadInProgress`, and rethrow the primary startup error with any lock-recovery timeout or throw context appended.

Keep existing git, install, and build behavior unchanged; update stopping progress and logging to describe both agents and commands.

**Step 4: Run focused tests**

Run: `pnpm test -- electron/services/reload-preview-service.test.ts`

Expected: PASS.

### Task 5: Verify Fresh Install and Repository Health

**Files:**
- Modify only files changed by formatting, if any.

**Step 1: Run required installation**

Run: `pnpm install`

Expected: Electron guard succeeds, executable verification passes, and `electron-rebuild` completes.

**Step 2: Verify Electron executable directly**

Run: `node -e "const fs=require('node:fs'); const electron=require('electron'); if (!fs.existsSync(electron)) process.exit(1); console.log(electron)"`

Expected: prints an existing Electron executable path.

**Step 3: Run tests**

Run: `pnpm test`

Expected: PASS. If sandbox localhost restrictions affect existing network-listener tests, rerun with required permissions and report unrelated failures separately.

**Step 4: Run lint autofix**

Run: `pnpm lint --fix`

Expected: exit 0.

**Step 5: Run TypeScript checks**

Run: `pnpm ts-check`

Expected: exit 0.

**Step 6: Run final lint**

Run: `pnpm lint`

Expected: exit 0.

**Step 7: Review final diff**

Run: `git diff --check && git status --short && git diff -- package.json scripts/ensure-electron-installed.mjs scripts/ensure-electron-installed.test.ts electron/services/reload-preview-service.ts electron/services/reload-preview-service.test.ts electron/main.ts electron/ipc/handlers.ts`

Expected: no whitespace errors and only scoped changes.
