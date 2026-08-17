# Eurecia Login Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use systematic debugging and test-driven development to implement this plan task-by-task.

**Goal:** Reliably detect completed Eurecia sign-in without hanging, while producing useful diagnostics that never expose session secrets.

**Architecture:** Keep authentication inside the existing persistent Electron partition. Replace one-shot page-load probing with one serialized probe loop that runs immediately, after relevant page loads, and every second while the login window remains open. Split probe outcomes into unauthenticated, authenticated-with-timesheet-access, and authenticated-without-timesheet-access so only the first outcome keeps waiting.

**Tech Stack:** Electron `BrowserWindow` and partition sessions, TypeScript, Vitest, TanStack Query, existing `debug` logger.

---

### Task 1: Capture Current Failure

**Files:**
- Modify: `electron/services/eurecia-session-service.test.ts`

1. Add fake-timer coverage where initial `did-finish-load` probe fails, session later becomes authenticated without another navigation, and login currently remains unresolved.
2. Add coverage for multiple probe triggers while a probe is active; assert fetches remain serialized.
3. Add coverage proving closing login window clears polling and rejects with cancellation.
4. Run `pnpm test electron/services/eurecia-session-service.test.ts` and confirm new polling test fails before implementation.

### Task 2: Distinguish Probe Outcomes

**Files:**
- Modify: `electron/services/timesheet-adapters/eurecia-read-service.ts`
- Modify: `electron/services/timesheet-adapters/eurecia-read-service.test.ts`

1. Add tests for three init-data outcomes: login redirect/invalid response, valid authenticated JSON with Browse URL, valid authenticated JSON without Browse URL.
2. Refactor discovery just enough to expose authenticated-without-timesheet-access distinctly; do not weaken same-origin, path, redirect, content-type, or JSON validation.
3. Return an actionable error for valid sessions lacking Timesheet access instead of treating them as indefinitely unauthenticated.
4. Run `pnpm test electron/services/timesheet-adapters/eurecia-read-service.test.ts`.

### Task 3: Add Sanitized Diagnostics

**Files:**
- Modify: `electron/lib/debug.ts`
- Modify: `electron/services/eurecia-session-service.ts`
- Modify: `electron/services/eurecia-session-service.test.ts`

1. Add `dbg.timesheet` using namespace `jc:timesheet`.
2. Log login-window creation, sanitized navigation hostname/path, probe trigger, probe outcome class, elapsed milliseconds, cancellation, success, and cleanup.
3. Never log cookies, headers, response bodies, query strings, fragments, credentials, or full URLs.
4. Test sanitization helpers or logger calls so query parameters cannot enter emitted messages.

### Task 4: Implement Reliable Detection

**Files:**
- Modify: `electron/services/eurecia-session-service.ts`
- Modify: `electron/services/eurecia-session-service.test.ts`

1. Start one immediate probe when login window opens.
2. Schedule a probe every 1,000 ms while window remains open.
3. Keep `did-finish-load` as an immediate trigger, but remove exact configured-origin gating from probe eligibility; allowed HTTPS Eurecia navigation remains enforced separately.
4. Serialize probes so interval and load events cannot overlap.
5. On unauthenticated result, keep waiting without surfacing expected pre-login failures.
6. On authenticated result, resolve login, clear timer/listeners, close window, and let existing React Query invalidation advance dialog.
7. On authenticated-without-timesheet-access, reject with actionable error, clean up detection, and close the login window; the dialog displays the error.
8. On popup close, logout, settings change, load failure, or successful login, clear timer and listeners exactly once.
9. Do not add arbitrary MFA timeout; popup closure remains cancellation boundary.
10. Run `pnpm test electron/services/eurecia-session-service.test.ts`.

### Task 5: Verify UI Behavior

**Files:**
- Modify if needed: `src/features/work-activity/ui-eurecia-sync-dialog/index.tsx`
- Modify if needed: `src/hooks/use-timesheets.test.ts`

1. Confirm successful login resolves mutation and invalidates `['timesheets', 'eurecia']` queries.
2. Confirm cancellation removes spinner and shows existing cancellation error.
3. Confirm missing Timesheet access removes spinner and displays actionable error.
4. Avoid UI changes unless tests show current mutation/error rendering is insufficient.

### Task 6: Full Verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Run `git diff --check` and inspect final diff for secrets or unrelated changes.
7. Manually verify with real Eurecia login: delayed MFA, cross-Eurecia-host redirect, successful auto-close, missing-access error, popup cancellation, and persisted-session reopening.
