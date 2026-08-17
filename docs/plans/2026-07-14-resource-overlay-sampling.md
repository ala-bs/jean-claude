# Resource Overlay Sampling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sample agent resources every 500 ms while the Resources overlay is open and every 4 seconds otherwise.

**Architecture:** Renderer overlay lifecycle sends a sampling-mode IPC command to the main process. The monitor service reschedules every active session, immediately samples when entering high-frequency mode, and new sessions inherit the active interval. React Query polling follows the same overlay-aware interval.

**Tech Stack:** Electron IPC, TypeScript, React, TanStack Query, Vitest

---

### Task 1: Dynamic monitor interval

**Files:**
- Modify: `electron/services/agent-resource-monitor-service.ts`
- Test: `electron/services/agent-resource-monitor-service.test.ts`

1. Add failing fake-timer tests for default 4-second sampling and switching to 500 ms with an immediate sample.
2. Run `pnpm vitest run electron/services/agent-resource-monitor-service.test.ts`; expect new assertions to fail.
3. Add `setHighFrequencySampling`, centralized interval selection, and timer rescheduling.
4. Run the focused test; expect pass.

### Task 2: Overlay lifecycle IPC

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/features/resources/ui-resources-overlay/index.tsx`
- Modify: `src/hooks/use-agent-resource-snapshots.ts`

1. Expose `agent:resources:setHighFrequencySampling` through the typed preload API.
2. Enable high-frequency sampling on overlay mount and restore normal sampling on cleanup.
3. Make query polling return 500 ms for the Resources overlay and 4 seconds otherwise.
4. Update footer copy to `sampled every 500ms`.

### Task 3: Full verification

**Files:**
- Modify only files automatically formatted by lint where needed.

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint` and resolve remaining errors.

### Task 4: Review remediation

**Files:**
- Modify: `electron/services/agent-resource-monitor-service.ts`
- Test: `electron/services/agent-resource-monitor-service.test.ts`
- Create: `electron/services/agent-resource-sampling-lease-service.ts`
- Create: `electron/services/agent-resource-sampling-lease-service.test.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `src/hooks/use-agent-resource-snapshots.ts`

1. Add a deferred-sampler test proving an open-overlay sample queues behind an in-flight sample.
2. Add lease tests proving one renderer cannot disable another and renderer destruction releases sampling.
3. Implement one pending immediate sample per session and renderer-owned sampling leases.
4. Split snapshot polling from the one-time history query so 500 ms requests only transfer latest snapshots.
5. Run focused tests, then repeat the full repository verification sequence.

### Task 5: Jean-Claude app metrics sampling

**Files:**
- Modify: `src/hooks/use-memory-usage.ts`
- Test: `src/hooks/use-memory-usage.test.ts`
- Modify: `src/features/resources/ui-resources-overlay/index.tsx`

1. Add a fake-timer hook test proving app metrics poll every 500 ms when requested.
2. Parameterize `useMemoryUsage` with a 4-second default interval.
3. Pass the shared 500 ms interval from the Resources overlay.
4. Run focused tests and repeat full repository verification.

### Task 6: Renderer lifecycle lease cleanup

**Files:**
- Modify: `electron/services/agent-resource-sampling-lease-service.ts`
- Test: `electron/services/agent-resource-sampling-lease-service.test.ts`

1. Add regression tests for renderer process exit and full main-frame navigation.
2. Release active leases on renderer crash or reload while ignoring same-document and iframe navigation.
3. Run focused tests and repeat full repository verification.
