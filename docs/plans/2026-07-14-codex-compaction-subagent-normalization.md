# Codex Compaction and Sub-agent Normalization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Normalize Codex compaction completion and compacted sub-agent activity into existing timeline entry types.

**Architecture:** Extend the stateful Codex normalizer. Emit a distinct compaction end marker, convert `subAgentActivity` summaries into sub-agent tool entries, and bind each child thread to its latest activity card.

**Tech Stack:** TypeScript, Vitest, Codex app-server notifications

---

### Task 1: Add failing capture-shaped tests

**Files:**
- Modify: `electron/services/agent-backends/codex/normalize-codex-message-v2.test.ts`

1. Test `contextCompaction` start emits `status: 'compacting'` and completion emits a distinct `status: null` entry.
2. Test completed `subAgentActivity` with `kind: 'started'` emits a `sub-agent` tool entry using the agent-path leaf.
3. Test `kind: 'interacted'` emits a new card and moves child-thread parenting to that latest card.
4. Run focused test; expect new assertions to fail against generic `codex-tool` fallback.

### Task 2: Implement minimal normalization

**Files:**
- Modify: `electron/services/agent-backends/codex/normalize-codex-message-v2.ts`

1. Handle completed compaction before generic tool normalization.
2. Give completion marker a distinct ID and completion timestamp.
3. Map supported `subAgentActivity` kinds to `sub-agent` entries.
4. Extract agent-path leaf for fallback description and prompt.
5. Register `agentThreadId` alongside existing `receiverThreadIds` so later child items receive `parentToolId`.
6. Run focused test; expect pass.

### Task 3: Full verification

**Files:**
- Modify only files changed automatically by lint, if any.

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Review final diff for unrelated changes.
