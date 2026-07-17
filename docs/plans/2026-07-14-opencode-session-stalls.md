# OpenCode Session Stalls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent OpenCode sessions from hanging on the synchronous prompt HTTP request.

**Architecture:** Submit prompts through OpenCode's fire-and-forget `promptAsync` endpoint. Keep SSE as the authoritative source for messages, errors, and completion.

**Tech Stack:** TypeScript, OpenCode SDK v2, Vitest

---

### Task 1: Reproduce blocking prompt usage

**Files:**
- Test: `electron/services/agent-backends/opencode/opencode-backend.test.ts`

1. Add a test where `session.prompt` never resolves, `session.promptAsync` resolves immediately, and SSE emits `session.idle`.
2. Assert the stream completes and only `promptAsync` is called.
3. Run the focused test and confirm it fails.

### Task 2: Use asynchronous prompt submission

**Files:**
- Modify: `electron/services/agent-backends/opencode/opencode-backend.ts`
- Test: `electron/services/agent-backends/opencode/opencode-backend.test.ts`

1. Replace blocking `session.prompt` submission with `session.promptAsync`.
2. Remove prompt-response coordination; normalize all output from SSE.
3. Preserve prompt submission error, idle timeout, permission, question, and cleanup behavior.
4. Run focused OpenCode backend tests.

### Task 3: Verify repository

1. Run `pnpm test`.
2. Run `pnpm lint --fix`.
3. Run `pnpm ts-check`.
4. Run `pnpm lint`.

### Task 4: Bound silent sessions

**Files:**
- Modify: `electron/services/agent-backends/opencode/opencode-backend.ts`
- Test: `electron/services/agent-backends/opencode/opencode-backend.test.ts`

1. Add a failing test for accepted `promptAsync` plus forever-silent SSE.
2. End sessions after ten minutes without owned session activity.
3. Pause timeout while waiting for permission or question input.
4. Abort the OpenCode session, log timeout context, and emit an explicit error.
5. Preserve thrown SSE error details in the emitted error.
6. Keep manual and automatic permission replies from blocking event processing.
