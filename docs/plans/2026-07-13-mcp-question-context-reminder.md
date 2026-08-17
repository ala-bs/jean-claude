# MCP Question Context Reminder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let MCP callers attach optional Markdown context shown directly before pending questions.

**Architecture:** Add request-level `contextReminder` metadata to MCP input and normalized pending-question contracts. Preserve it through bridge, broker, agent service, IPC, and renderer state; render it in `QuestionOptions` so both message-stream and empty-stream paths work. Metadata remains transient and disappears with answered question.

**Tech Stack:** TypeScript, Zod, Electron IPC, Zustand, React, Vitest

---

### Task 1: MCP and Broker Contracts

**Files:**
- Modify: `electron/mcp/ask-question-bridge.ts`
- Modify: `electron/services/jc-mcp-bridge-service.ts`
- Modify: `electron/services/question-broker-service.ts`
- Modify: `shared/agent-backend-types.ts`
- Test: `electron/mcp/ask-question-bridge.test.ts`
- Test: `electron/services/question-broker-service.test.ts`

**Steps:**
1. Add failing tests proving optional nonblank `contextReminder` reaches bridge request and normalized broker request.
2. Run focused tests and confirm failure.
3. Add documented Zod field and request-level broker metadata.
4. Run focused tests and confirm pass.

### Task 2: Agent, IPC, and Renderer State

**Files:**
- Modify: `electron/services/agent-service.ts`
- Modify: `shared/agent-ui-events.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/stores/task-messages.ts`
- Modify: `src/features/agent/task-message-manager/index.tsx`
- Test: `electron/services/agent-service.test.ts`
- Test: `src/stores/task-messages.test.ts`

**Steps:**
1. Add failing tests for emitted, queued, recovered, and stored reminders.
2. Run focused tests and confirm failure.
3. Extend pending-question shapes and preserve metadata at every copy boundary.
4. Run focused tests and confirm pass.

### Task 3: Question UI

**Files:**
- Modify: `src/features/agent/ui-question-options/index.tsx`
- Modify: `src/features/agent/ui-message-stream/index.tsx`
- Modify: `src/features/task/ui-task-panel/index.tsx` only if inferred props require it
- Test: add focused `QuestionOptions` rendering test using existing renderer test conventions

**Steps:**
1. Add failing test for Markdown reminder before question content and no output when absent.
2. Run focused test and confirm failure.
3. Render subdued assistant-context block before question card with existing Markdown renderer.
4. Run focused test and confirm pass.

### Task 4: Full Verification

**Steps:**
1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Inspect final diff and ensure no unrelated changes or changelog edits.
