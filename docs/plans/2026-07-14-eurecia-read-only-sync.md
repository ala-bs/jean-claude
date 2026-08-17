# Eurecia Read-Only Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent Eurecia login, configurable tenant/axis labels, explicit timesheet selection, per-entry fraction/axis editing, and safe Save/Submit dry-run previews without issuing timesheet writes.

**Architecture:** Electron main owns a dedicated persistent session partition and sandboxed login/discovery windows. Renderer uses typed IPC for auth, sheet discovery, editor metadata, and dry-run preparation; work-activity overlay hosts a nested editor while all timesheet form writes remain absent.

**Tech Stack:** Electron BrowserWindow/session, TypeScript, Cheerio, React, TanStack Query, Vitest

---

### Task 1: Shared Contracts And Settings

**Files:**
- Modify: `shared/types.ts`
- Modify: `shared/timesheet-types.ts`
- Modify: `src/hooks/use-settings.ts`
- Test: `electron/database/repositories/settings.test.ts`

1. Add validated `eurecia` setting with HTTPS base URL and three custom axis labels.
2. Add auth status, sheet summary, editor row/axis option, entry edit, and dry-run result contracts.
3. Add generic Eurecia setting hooks.
4. Test defaults and invalid settings fallback.

### Task 2: Read-Only Discovery And Dry-Run Model

**Files:**
- Modify: `electron/services/timesheet-adapters/eurecia-protocol-client.ts`
- Modify: `electron/services/timesheet-adapters/eurecia-protocol-client.test.ts`
- Create: `electron/services/timesheet-adapters/eurecia-read-service.ts`
- Create: `electron/services/timesheet-adapters/eurecia-read-service.test.ts`

1. Add synthetic parsers for Browse rows, Open row dates/axis headings/context, quarter-day durations, and working-hours data.
2. Add injected read-only fetch service with strict same-origin GET allowlist and response/content-type validation.
3. Build editor model and dry-run preview supporting four entries/date, quarter-day totals at most one, blank comments, explicit Save/Submit action, and inferred-row warnings.
4. Ensure no `Open.do` form POST or `AddLine` request exists.

### Task 3: Persistent Electron Authentication

**Files:**
- Create: `electron/services/eurecia-session-service.ts`
- Create: `electron/services/eurecia-session-service.test.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/use-timesheets.ts`

1. Add fixed `persist:jean-claude-eurecia` partition and sandboxed login window.
2. Validate configured HTTPS base URL, deny popups, allow HTTPS SSO redirects, and auto-close only after authenticated same-origin probe succeeds.
3. Add status/login/logout/list/inspect/dry-run IPC with runtime validation; never expose cookies.
4. Add renderer hooks and browser/test fallbacks.

### Task 4: General Settings UI

**Files:**
- Modify: `src/features/settings/ui-general-settings/index.tsx`
- Modify: `src/features/settings/ui-settings-overlay/index.tsx`

1. Add Eurecia settings section using existing visual language.
2. Edit tenant URL and three axis headings.
3. Show login status with Sign in/Sign out controls.
4. Validate URL inline and preserve saved values on errors.

### Task 5: Work Activity Dry-Run Editor

**Files:**
- Create: `src/features/work-activity/ui-eurecia-sync-dialog/index.tsx`
- Create: `src/features/work-activity/ui-eurecia-sync-dialog/utils.ts`
- Create: `src/features/work-activity/ui-eurecia-sync-dialog/utils.test.ts`
- Modify: `src/features/work-activity/ui-work-activity-overlay/index.tsx`

1. Add “Eurecia dry run” action beside copy controls.
2. Add nested industrial/ledger-style dialog matching existing overlay.
3. Require login, always ask target sheet, then edit up to four entries/date.
4. Provide fraction picker, custom-labeled cascading axes, blank comments, and total validation.
5. Let user choose Save or Submit preview; clearly state no data is sent.
6. Show redacted structural preview and inferred-row warnings.

### Task 6: Verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Review all IPC input validation, navigation restrictions, cookie isolation, and absence of timesheet form writes.
