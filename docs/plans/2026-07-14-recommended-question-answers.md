# Recommended Question Answers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let MCP question options declare `recommended?: boolean` and show recommended options with a badge.

**Architecture:** Validate metadata at MCP and broker boundaries, preserve it through normalized and renderer question types, then render a presentation-only badge in both choice layouts. Existing selection, order, and answer payload behavior stays unchanged.

**Tech Stack:** TypeScript, Zod, React, Vitest, Tailwind CSS

---

### Task 1: Validate and normalize metadata

**Files:**
- Modify: `electron/mcp/ask-question-bridge.ts`
- Modify: `electron/services/question-broker-service.ts`
- Modify: `shared/agent-backend-types.ts`
- Test: `electron/mcp/ask-question-bridge.test.ts`
- Test: `electron/services/question-broker-service.test.ts`

1. Add failing tests proving booleans pass, malformed values fail, and normalized options preserve explicit `true` and `false`.
2. Run focused tests and confirm failure.
3. Add optional boolean schema, broker validation, normalized type, and mapping.
4. Run focused tests and confirm pass.

### Task 2: Preserve metadata through IPC

**Files:**
- Modify: `shared/agent-types.ts`
- Modify: `electron/services/agent-service.ts`
- Test: `electron/services/agent-service.test.ts`

1. Add failing transport assertion for recommended metadata.
2. Preserve optional field in both normalized-to-renderer mappings.
3. Run focused test and confirm pass.

### Task 3: Render recommendation badge

**Files:**
- Modify: `src/features/agent/ui-question-options/index.tsx`
- Test: `src/features/agent/ui-question-options/index.test.tsx`

1. Add failing single-choice and multi-choice badge tests.
2. Render small teal `Recommended` badge only when metadata is true.
3. Run focused tests and confirm pass.

### Task 4: Verify repository

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
