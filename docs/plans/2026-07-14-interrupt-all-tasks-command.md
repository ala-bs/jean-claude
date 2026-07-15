# Interrupt All Tasks Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add command-palette action that confirms, then interrupts all agent tasks and shell commands.

**Architecture:** Expose existing agent and run-command stop-all service methods through separate IPC APIs. Global palette command invokes both concurrently with `Promise.allSettled`, preserving partial progress and showing one error toast on failure.

**Tech Stack:** Electron IPC, React, TypeScript, Vitest

---

### Task 1: Expose stop-all APIs

**Files:**
- Modify: `shared/agent-types.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `src/lib/api.ts`

1. Add agent stop-all channel and renderer API.
2. Add run-command stop-all IPC and renderer API.
3. Route handlers to existing service methods.

### Task 2: Register palette command

**Files:**
- Modify: `src/routes/__root.tsx`

1. Register `Interrupt All Tasks` in Task section.
2. Open danger confirmation modal.
3. Run both stop APIs concurrently.
4. Show one error toast if either operation fails.

### Task 3: Test and verify

**Files:**
- Modify: relevant existing test files

1. Cover multi-session agent interruption and failure isolation.
2. Run `pnpm install`, `pnpm test`, `pnpm lint --fix`, `pnpm ts-check`, and `pnpm lint`.
