# Work Item Summary Skill Implementation Plan

> **For Claude:** Implement task-by-task while preserving unrelated dirty worktree changes.

**Goal:** Replace verbose structured work-item summaries with concise, skill-driven Markdown engineering briefs.

**Architecture:** Register `work-item-summary` as a built-in skill and select it by name in the default AI slot. Generate and persist raw Markdown, render it through the shared Markdown component with summary-only Mermaid support, and derive compact excerpts from Markdown rather than fixed JSON sections.

**Tech Stack:** TypeScript, Electron, React, SQLite/Kysely, React Markdown, Mermaid, Vitest.

---

### Task 1: Built-In Skill And Slot Wiring

**Files:**
- Modify: `electron/services/builtin-skills-service.ts`
- Modify: `electron/services/builtin-skills-service.test.ts`
- Modify: `shared/types.ts`
- Modify: `shared/types.test.ts`
- Modify: `electron/database/migrations/076_work_item_summaries.ts`
- Modify: `electron/services/ai-skill-slot-resolver.ts`
- Modify: `electron/services/ai-skill-slot-resolver.test.ts`

**Steps:**
1. Add failing tests for installed skill content and named default slot.
2. Register `work-item-summary` with concise Markdown editorial instructions from approved design.
3. Set fresh and migrated work-item-summary slots to `skillName: 'work-item-summary'`.
4. Preserve selected skill through backend fallback; let provider failure preserve old cache.
5. Run focused built-in, shared-type, and resolver tests.

### Task 2: Markdown Generation And Persistence

**Files:**
- Modify: `shared/work-item-summary-types.ts`
- Modify: `electron/services/work-item-summary-generation-service.ts`
- Modify: `electron/services/work-item-summary-generation-service.test.ts`
- Modify: `electron/database/repositories/work-item-summaries.ts`
- Modify: `electron/database/repositories/work-item-summaries.test.ts`

**Steps:**
1. Change `WorkItemSummary.content` to `string` and remove structured content/visual types.
2. Replace JSON-schema generation with named-skill plain text generation.
3. Keep source trust notice, all-comment input, temp-file cleanup, cache freshness, concurrency, and old-cache-on-failure behavior.
4. Reject null, non-string, and blank output only.
5. Store/read raw Markdown without JSON serialization.
6. Run focused generation and repository tests.

### Task 3: Markdown Rendering And Excerpts

**Files:**
- Modify: `src/features/agent/ui-markdown-content/index.tsx`
- Modify: `src/features/common/ui-mermaid-diagram/index.tsx`
- Modify: `src/features/work-item/ui-work-item-generated-summary/index.tsx`
- Modify: `src/features/work-item/ui-work-item-generated-summary/index.test.tsx`
- Modify: `src/lib/work-item-summary.ts`
- Modify: `src/lib/work-item-summary.test.ts`
- Modify: `src/features/work-item/ui-work-item-board/index.tsx`
- Modify: `electron/services/feed-service.ts`
- Modify: `electron/services/feed-service.test.ts`

**Steps:**
1. Add opt-in Mermaid-fence rendering to shared Markdown component; keep strict validator and escaped fallback.
2. Render summary Markdown directly and copy raw content.
3. Implement first-meaningful-sentence excerpt extraction that skips headings, code, images, and visual fences and caps output near 180 characters.
4. Use excerpt helper in board and feed paths.
5. Run focused renderer, utility, and feed tests.

### Task 4: Remove Structured Summary Assumptions

**Files:**
- Search: `shared/`, `electron/`, `src/`
- Modify: every remaining `WorkItemSummaryContent`, `.content.problem`, and `workItemSummaryToMarkdown` consumer.

**Steps:**
1. Search for old structured fields and adapters.
2. Replace or remove each reference.
3. Run TypeScript check and focused summary tests.

### Task 5: Skill Evaluation

**Files:**
- Create: built-in skill evaluation workspace outside product source or under approved skill-eval location.

**Steps:**
1. Create three eval prompts: supplied modal story, sparse bug, complex workflow with superseding/conflicting comments.
2. Run paired with-skill and no-skill baselines.
3. Grade brevity, critical coverage, grounded questions, visual usefulness, and scanability.
4. Generate skill-creator review viewer and inspect benchmark.
5. Refine skill once if outputs materially miss approved sample density.

### Task 6: Full Verification

**Steps:**
1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Run `git diff --check` and inspect final worktree without reverting unrelated changes.
