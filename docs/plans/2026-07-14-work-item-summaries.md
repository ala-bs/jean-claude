# Work Item Summaries Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add manually generated, cached Azure DevOps work-item summaries with structured bullets, optional ASCII/Mermaid visuals, source-freshness warnings, and compact board/feed excerpts.

**Architecture:** Main process fetches complete work-item context, fingerprints core fields plus all comments, invokes dedicated `work-item-summary` AI slot, and persists typed JSON in SQLite. Renderer reads full freshness-aware summaries when preview/detail opens and batch-loads cached summaries for cards; structured UI renders bullets plus optional strict-mode Mermaid, while copy serializes canonical content to Markdown.

**Tech Stack:** Electron IPC, TypeScript, Kysely/SQLite, TanStack Query, Zustand background jobs, React 19, Vitest, Mermaid.

---

## Locked Product Decisions

- Azure DevOps work items only.
- Manual generation and regeneration; never generate whole boards automatically.
- Inputs: title, description, repro steps, acceptance criteria, and all comments.
- English output.
- Structured sections: problem/request, expected outcome, requirements, constraints, open questions.
- No global word or item-count cap. Prompt still asks for concise, non-redundant bullets.
- Optional single ASCII or Mermaid visual only when flow, actors, states, or dependencies benefit.
- Full expanded summary in board preview and work-item detail page.
- One-line problem excerpt on board/feed cards only after cached summary exists.
- Read-only generated content; actions are copy and regenerate.
- Copy emits Markdown and preserves fenced `text`/`mermaid` visuals.
- Any core-field or comment change marks full summary stale once freshness is checked.
- Board/feed cards compare field freshness without comment requests; comment freshness is checked when preview/detail opens.
- Failed regeneration preserves prior cached summary.
- Sparse source returns explicit insufficient-detail text and open questions; model must not invent facts.

## Data Shape

Create `shared/work-item-summary-types.ts` with canonical contracts:

```ts
export type WorkItemSummaryVisual = {
  format: 'ascii' | 'mermaid';
  source: string;
};

export type WorkItemSummaryContent = {
  problem: string[];
  expectedOutcome: string[];
  requirements: string[];
  constraints: string[];
  openQuestions: string[];
  visual: WorkItemSummaryVisual | null;
};

export type WorkItemSummary = {
  providerId: string;
  workItemId: number;
  content: WorkItemSummaryContent;
  sourceChangedDate: string | null;
  sourceLatestCommentId: number | null;
  sourceCommentCount: number;
  generatedAt: string;
  updatedAt: string;
  isStale: boolean;
};

export type WorkItemSummaryRequest = {
  projectId: string;
  providerId: string;
  projectName: string;
  workItemId: number;
};
```

Persist `sourceHash` internally but do not expose it to renderer. Derive compact card text from first non-empty `problem` bullet; never persist duplicate excerpt text.

### Task 1: Shared Contracts and AI Slot

**Files:**
- Create: `shared/work-item-summary-types.ts`
- Modify: `shared/types.ts:815-855,1179-1209,1434-1439`
- Modify: `shared/ai-usage-types.ts:1-16`
- Modify: `src/features/common/ui-ai-skill-slot/index.tsx:23-68`
- Test: `shared/types.test.ts`

**Step 1: Write failing slot-validation tests**

Add tests proving `isAiSkillSlotsSetting` accepts `work-item-summary`, rejects unknown keys, and default settings contain enabled Claude Code/Haiku config:

```ts
expect(
  isAiSkillSlotsSetting({
    'work-item-summary': {
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
      skillName: null,
    },
  }),
).toBe(true);
expect(SETTINGS_DEFINITIONS.aiSkillSlots.defaultValue['work-item-summary']).toEqual(
  DEFAULT_WORK_ITEM_SUMMARY_SLOT,
);
```

**Step 2: Run test and verify failure**

Run: `pnpm test -- shared/types.test.ts`

Expected: FAIL because slot key/default do not exist.

**Step 3: Add shared summary contracts**

Create types exactly as shown in **Data Shape**. Keep contracts backend-neutral and JSON-serializable.

**Step 4: Add slot key and default**

In `shared/types.ts`, add:

```ts
export const DEFAULT_WORK_ITEM_SUMMARY_SLOT: AiSkillSlotConfig = {
  backend: 'claude-code',
  model: 'haiku',
  thinkingEffort: 'default',
  skillName: null,
};
```

Add `'work-item-summary'` to `AiSkillSlotKey`, `VALID_SLOT_KEYS`, and `SETTINGS_DEFINITIONS.aiSkillSlots.defaultValue`.

**Step 5: Register usage and settings UI labels**

Add `'work-item-summary'` to `AiUsageFeature`. Add `SLOT_DEFINITIONS` entry:

```ts
{
  key: 'work-item-summary',
  label: 'Work Item Summary',
  description:
    'Summarize Azure work item requirements and comment history for faster review',
}
```

Global and project settings already iterate this array; avoid bespoke UI.

**Step 6: Run focused tests**

Run: `pnpm test -- shared/types.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add shared/work-item-summary-types.ts shared/types.ts shared/types.test.ts shared/ai-usage-types.ts src/features/common/ui-ai-skill-slot/index.tsx
git commit -m "feat(work-items): add summary contracts and AI slot"
```

### Task 2: Fetch Complete Comment History

**Files:**
- Modify: `electron/services/azure-devops-service.ts:1284-1346`
- Test: `electron/services/azure-devops-service.test.ts:563-717`

**Step 1: Write pagination failure test**

Mock two Azure responses. First returns comments plus continuation token; second returns remaining comments. Assert both requests occur, second URL includes `continuationToken`, and returned comments preserve current newest-first API order.

Also test repeated continuation token terminates with descriptive error instead of looping.

**Step 2: Run test and verify failure**

Run: `pnpm test -- electron/services/azure-devops-service.test.ts`

Expected: FAIL because `getWorkItemComments` performs one `$top=50` request.

**Step 3: Implement pagination**

Replace single fetch with loop:

```ts
const comments = [];
const seenTokens = new Set<string>();
let continuationToken: string | null = null;

do {
  const url = new URL(
    `https://dev.azure.com/${orgName}/${encodeURIComponent(params.projectName)}/_apis/wit/workItems/${params.workItemId}/comments`,
  );
  url.searchParams.set('api-version', '7.0-preview.4');
  url.searchParams.set('$top', '50');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('$expand', 'renderedText');
  if (continuationToken) url.searchParams.set('continuationToken', continuationToken);

  // Fetch, validate, append mapped comments.
  // Read next token from response body or x-ms-continuationtoken header.
} while (continuationToken);
```

Keep 404 behavior. Deduplicate comments by ID defensively. Use seen-token guard.

**Step 4: Run focused tests**

Run: `pnpm test -- electron/services/azure-devops-service.test.ts`

Expected: PASS, including existing comment rendering/attachment tests.

**Step 5: Commit**

```bash
git add electron/services/azure-devops-service.ts electron/services/azure-devops-service.test.ts
git commit -m "fix(work-items): fetch complete comment history"
```

### Task 3: Persist Work-Item Summaries

**Files:**
- Create: `electron/database/migrations/075_work_item_summaries.ts`
- Create: `electron/database/migrations/075_work_item_summaries.test.ts`
- Create: `electron/database/repositories/work-item-summaries.ts`
- Create: `electron/database/repositories/work-item-summaries.test.ts`
- Modify: `electron/database/migrator.ts:3-151`
- Modify: `electron/database/schema.ts:35-61,320-331`
- Modify: `electron/database/repositories/index.ts`

**Step 1: Write failing migration test**

Follow `072_global_mcp_servers.test.ts`. Assert table columns, provider FK cascade, unique `(providerId, workItemId)` index, and `down()` removal.

Target schema:

```text
work_item_summaries
├─ id text PK
├─ providerId text FK providers.id ON DELETE CASCADE
├─ workItemId integer
├─ content text                  JSON WorkItemSummaryContent
├─ sourceHash text
├─ sourceChangedDate text null
├─ sourceLatestCommentId integer null
├─ sourceCommentCount integer
├─ generatedAt text
└─ updatedAt text
```

**Step 2: Run migration test and verify failure**

Run: `pnpm test -- electron/database/migrations/075_work_item_summaries.test.ts`

Expected: FAIL because migration does not exist.

**Step 3: Implement and register migration**

Use SQLite UUID/timestamp patterns from migration 040. Register `m075` after `m074` in `migrator.ts`. Add `WorkItemSummaryTable` and `work_item_summaries` to `Database`.

**Step 4: Run migration test**

Run: `pnpm test -- electron/database/migrations/075_work_item_summaries.test.ts`

Expected: PASS.

**Step 5: Write failing repository tests**

Cover:

- `findByWorkItem({ providerId, workItemId })`
- `findByWorkItems({ providerId, workItemIds })` with one SQL query
- `upsert(...)` insert then update same composite key
- malformed persisted JSON throws contextual error naming work-item ID
- provider/work-item isolation

**Step 6: Implement repository**

Parse `content` into `WorkItemSummaryContent` at repository boundary. Export plain domain rows, not DB rows. Use `onConflict(...).doUpdateSet(...)` and `returningAll()`.

Do not add compatibility fallback for malformed JSON; surface corruption clearly.

**Step 7: Run repository tests**

Run: `pnpm test -- electron/database/repositories/work-item-summaries.test.ts`

Expected: PASS.

**Step 8: Commit**

```bash
git add electron/database/migrations/075_work_item_summaries.ts electron/database/migrations/075_work_item_summaries.test.ts electron/database/repositories/work-item-summaries.ts electron/database/repositories/work-item-summaries.test.ts electron/database/repositories/index.ts electron/database/migrator.ts electron/database/schema.ts
git commit -m "feat(work-items): persist generated summaries"
```

### Task 4: Build Source Normalization and Freshness Fingerprints

**Files:**
- Create: `electron/services/work-item-summary-source.ts`
- Create: `electron/services/work-item-summary-source.test.ts`
- Modify: `electron/services/azure-devops-service.ts:445-469`

**Step 1: Write source-format tests**

Cover:

- core HTML fields become readable Markdown
- comments sort oldest-to-newest regardless of API order
- comment author/date remain visible
- same semantic source gives stable SHA-256 hash
- changed field, comment text, comment ID, or count changes hash
- latest comment marker uses newest comment ID
- source text labels Azure content as untrusted data and tells model not to follow embedded instructions

**Step 2: Run tests and verify failure**

Run: `pnpm test -- electron/services/work-item-summary-source.test.ts`

Expected: FAIL because formatter does not exist.

**Step 3: Export Azure HTML conversion**

Rename local `htmlToMarkdown` to exported `azureHtmlToMarkdown` in `azure-devops-service.ts`; update internal test-step call sites. Reuse it for description, repro, acceptance criteria, and HTML comments.

**Step 4: Implement normalized source**

Export:

```ts
export function prepareWorkItemSummarySource(params: {
  workItem: AzureDevOpsWorkItem;
  comments: WorkItemComment[];
}): {
  coreMarkdown: string;
  commentsMarkdown: string;
  sourceHash: string;
  sourceChangedDate: string | null;
  sourceLatestCommentId: number | null;
  sourceCommentCount: number;
};
```

Hash stable JSON containing normalized core fields and chronologically sorted comments. Avoid timestamps generated locally.

**Step 5: Run focused tests**

Run: `pnpm test -- electron/services/work-item-summary-source.test.ts electron/services/azure-devops-service.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add electron/services/work-item-summary-source.ts electron/services/work-item-summary-source.test.ts electron/services/azure-devops-service.ts electron/services/azure-devops-service.test.ts
git commit -m "feat(work-items): normalize summary source context"
```

### Task 5: Implement AI Generation and Cache Orchestration

**Files:**
- Create: `electron/services/work-item-summary-generation-service.ts`
- Create: `electron/services/work-item-summary-generation-service.test.ts`

**Step 1: Write failing structured-generation tests**

Mock `generateText`, `resolveAiSkillSlot`, Azure service methods, project repository, and summary repository. Cover:

- resolves `work-item-summary` using project override/global slot
- rejects project/provider mismatch
- disabled slot gives actionable configuration error
- passes backend, model, thinking effort, and `usageContext.feature = 'work-item-summary'`
- schema requires every array plus nullable visual object
- prompt requests English, concise non-redundant bullets without hard length limits
- prompt forbids invented facts and embedded-source instructions
- optional visual allows only `ascii` or `mermaid`
- sparse source instruction requests insufficient-detail/open-question output
- trims strings and removes empty bullets
- rejects result with no useful section content
- writes repository only after valid output

**Step 2: Run tests and verify failure**

Run: `pnpm test -- electron/services/work-item-summary-generation-service.test.ts`

Expected: FAIL because service does not exist.

**Step 3: Implement prompt and schema**

Use structured schema shaped like `WorkItemSummaryContent`. Do not add `maxLength` or `maxItems`. Include exact visual rule:

```text
Return visual only when flow, actors, states, or dependencies become materially easier to understand.
Return at most one visual. Mermaid must use supported flowchart/state/sequence syntax and must not contain links, click directives, HTML, or initialization directives.
ASCII must remain readable in a narrow pane.
```

**Step 4: Add oversized-comment temp-file tests**

Use 30,001-character comment fixture. Assert:

- comments written under `tmpdir()` with `jc-work-item-summary-` prefix
- prompt references exact file
- `generateText` receives `cwd`, `allowedTools: ['Read']`, and exact-path `allowedToolPatterns`
- temp directory removed after success and thrown generation error
- comments are not truncated

**Step 5: Implement prompt preparation**

Mirror `session-summary-service.ts:131-209`:

```ts
const MAX_INLINE_COMMENTS_CHARS = 30_000;
```

Inline core fields always. Inline comments at or below threshold; otherwise write `work-item-comments.md`. Cleanup in `finally`.

**Step 6: Add freshness/cache/deduplication tests**

Cover:

- `getWorkItemSummary` returns `null` without source fetch when no cache exists
- matching source hash returns cache with `isStale: false`
- field/comment change returns old cache with `isStale: true`
- `generateWorkItemSummary` always regenerates, even unchanged source
- two concurrent generate calls for same provider/item share one promise
- failure leaves repository untouched
- `getCachedWorkItemSummaries` performs no Azure/comment calls

**Step 7: Implement orchestration**

Export:

```ts
getWorkItemSummary(request): Promise<WorkItemSummary | null>
generateWorkItemSummary(request): Promise<WorkItemSummary>
getCachedWorkItemSummaries({ providerId, workItemIds }): Promise<WorkItemSummary[]>
```

Use module-level `Map<string, Promise<WorkItemSummary>>` for in-flight generation; remove entry in `finally`. Validate local project owns requested provider before Azure calls.

**Step 8: Run service tests**

Run: `pnpm test -- electron/services/work-item-summary-generation-service.test.ts`

Expected: PASS.

**Step 9: Commit**

```bash
git add electron/services/work-item-summary-generation-service.ts electron/services/work-item-summary-generation-service.test.ts
git commit -m "feat(work-items): generate cached AI summaries"
```

### Task 6: Expose Summary IPC and Renderer Hooks

**Files:**
- Modify: `electron/ipc/handlers.ts:2979-3020`
- Modify: `electron/preload.ts:311-388`
- Modify: `src/lib/api.ts:270-326,702-779,1954-1983`
- Create: `src/hooks/use-work-item-summary.ts`
- Create: `src/hooks/use-work-item-summary.test.ts`

**Step 1: Define API methods**

Add under `api.azureDevOps`:

```ts
getWorkItemSummary(request: WorkItemSummaryRequest): Promise<WorkItemSummary | null>;
generateWorkItemSummary(request: WorkItemSummaryRequest): Promise<WorkItemSummary>;
getCachedWorkItemSummaries(params: {
  providerId: string;
  workItemIds: number[];
}): Promise<WorkItemSummary[]>;
```

Mirror methods in preload and browser fallback. Add handlers near comment handlers, validating strings, finite positive work-item IDs, and deduplicated batch IDs.

**Step 2: Write failing hook tests**

Cover keys and behavior:

```ts
['work-item-summary', providerId, workItemId]
['work-item-summaries', providerId, sortedUniqueIds]
```

Generation success must set exact cache immediately and invalidate batch summaries plus `feed:workItems`. Comment mutation must invalidate exact full-summary key so next open checks freshness.

**Step 3: Run hook tests and verify failure**

Run: `pnpm test -- src/hooks/use-work-item-summary.test.ts`

Expected: FAIL because hooks do not exist.

**Step 4: Implement hooks**

Export:

- `useWorkItemSummary(request | null)`
- `useCachedWorkItemSummaries({ providerId, workItemIds })`
- `useGenerateWorkItemSummary()`

Set `retry: false` for generation mutation. Full summary query only runs with project/provider/project-name/item context. Batch query remains DB-only.

**Step 5: Invalidate after new comments**

Update `useAddWorkItemComment` in `src/hooks/use-work-items.ts` to invalidate `['work-item-summary', providerId, workItemId]`. Do not auto-regenerate.

**Step 6: Run focused tests and type check**

Run: `pnpm test -- src/hooks/use-work-item-summary.test.ts src/hooks/use-feed.test.ts`

Run: `pnpm ts-check`

Expected: PASS.

**Step 7: Commit**

```bash
git add electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts src/hooks/use-work-item-summary.ts src/hooks/use-work-item-summary.test.ts src/hooks/use-work-items.ts
git commit -m "feat(work-items): expose summary API and hooks"
```

### Task 7: Add Markdown Serialization and Safe Mermaid Rendering

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/lib/work-item-summary.ts`
- Create: `src/lib/work-item-summary.test.ts`
- Create: `src/features/common/ui-mermaid-diagram/index.tsx`
- Create: `src/features/common/ui-mermaid-diagram/index.test.tsx`
- Modify: `vitest.config.ts:14-28`

**Step 1: Add dependency**

Run: `pnpm add mermaid`

Expected: `package.json` and lockfile include Mermaid.

**Step 2: Write failing serializer tests**

Cover:

- omitted empty sections
- stable heading order
- Markdown bullet escaping
- first problem bullet as compact text
- ASCII visual fenced with `text`
- Mermaid visual fenced with `mermaid`
- no visual produces no fence

Expected serializer shape:

````md
## Problem / request
- ...

## Expected outcome
- ...

```mermaid
flowchart LR
  A --> B
```
````

**Step 3: Implement pure helpers**

Export:

```ts
workItemSummaryToMarkdown(content: WorkItemSummaryContent): string
getWorkItemSummaryExcerpt(content: WorkItemSummaryContent): string | null
```

**Step 4: Run serializer tests**

Run: `pnpm test -- src/lib/work-item-summary.test.ts`

Expected: PASS.

**Step 5: Write failing Mermaid component tests**

Add `src/features/common/ui-mermaid-diagram/**/*.test.tsx` and `src/features/work-item/**/*.test.tsx` to Vitest include. Mock Mermaid and cover:

- initializes with `securityLevel: 'strict'`
- disables HTML labels and interaction
- renders returned SVG
- ignores stale async render after source changes/unmount
- invalid Mermaid shows escaped source fallback without crashing
- unique render IDs across instances

**Step 6: Implement Mermaid component**

Lazy-import Mermaid inside effect to avoid startup cost. Configure strict security. Never use model-provided IDs. Render sanitized library output only. Display source in `<pre>` on failure.

**Step 7: Run focused tests**

Run: `pnpm test -- src/lib/work-item-summary.test.ts src/features/common/ui-mermaid-diagram/index.test.tsx`

Expected: PASS.

**Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/lib/work-item-summary.ts src/lib/work-item-summary.test.ts src/features/common/ui-mermaid-diagram/index.tsx src/features/common/ui-mermaid-diagram/index.test.tsx
git commit -m "feat(work-items): render and copy visual summaries"
```

### Task 8: Build Full Summary Card and Generation Job State

**Files:**
- Create: `src/features/work-item/ui-work-item-generated-summary/index.tsx`
- Create: `src/features/work-item/ui-work-item-generated-summary/index.test.tsx`
- Modify: `src/stores/background-jobs.ts:9-24,69-76,188-197,425-479`
- Modify: `src/features/background-jobs/ui-background-jobs-overlay/index.tsx:324-394`
- Test: `src/stores/background-jobs.test.ts`

**Step 1: Write failing background-job tests**

Add `work-item-summary-generation` job with details:

```ts
{
  providerId: string;
  workItemId: number;
  workItemTitle: string;
  projectName: string;
}
```

Test label, persisted serialization, and selector that finds running job by provider/work-item identity.

**Step 2: Implement background-job variant**

Update exhaustive unions, labels, details renderer, and selector. Do not reuse task `summary-generation` type.

**Step 3: Write failing summary-card tests**

Use happy-dom. Cover:

- missing summary shows `Generate summary`
- ready summary starts expanded and renders non-empty sections
- stale summary shows `Source updated`
- generation preserves old content and shows progress
- error shows inline message and retry
- failed regeneration keeps old content
- ASCII visual uses `<pre>`
- Mermaid visual uses `MermaidDiagram`
- copy writes serializer output and shows success/error toast
- regenerate action creates one job for identity and blocks duplicate clicks

**Step 4: Implement summary card**

Props should remain data-oriented:

```ts
{
  request: WorkItemSummaryRequest;
  workItemTitle: string;
  className?: string;
}
```

Component owns query, generation mutation, background-job coordination, local inline error, copied state, and rendering. Use selectors for Zustand state; never return fresh arrays from selectors.

**Step 5: Run focused tests**

Run: `pnpm test -- src/stores/background-jobs.test.ts src/features/work-item/ui-work-item-generated-summary/index.test.tsx`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/stores/background-jobs.ts src/stores/background-jobs.test.ts src/features/background-jobs/ui-background-jobs-overlay/index.tsx src/features/work-item/ui-work-item-generated-summary/index.tsx src/features/work-item/ui-work-item-generated-summary/index.test.tsx
git commit -m "feat(work-items): add generated summary card"
```

### Task 9: Integrate Preview and Detail Surfaces

**Files:**
- Modify: `src/features/work-item/ui-work-item-preview/index.tsx:48-78,191-197,349-473`
- Modify: `src/features/feed/ui-work-item-details/index.tsx:170-238,297-403`
- Modify call sites:
- `src/features/work-item/ui-azure-board-overlay/project-content.tsx:539-614`
- `src/features/work-item/ui-work-item-picker/index.tsx:490-503`
- `src/features/pull-request/ui-pr-work-items/index.tsx:456-484`
- `src/features/work-activity/ui-work-activity-overlay/index.tsx:1018-1056`
- Create: `src/lib/work-item-summary-visibility.test.ts`

**Step 1: Write failing visibility tests**

Extract/test pure predicate:

```ts
canShowWorkItemSummary({ projectId, providerId, projectName, workItemId })
```

Require all generation context. Missing context must hide generation UI rather than issue invalid IPC.

**Step 2: Add local project ID to preview**

Add optional `projectId` prop to `WorkItemPreview`. Pass it from call sites where available. Preserve current preview behavior when absent.

**Step 3: Insert full card in preview**

Inside content tab, render summary after related-item section and before raw Description/Acceptance Criteria/Repro Steps. Keep expanded default and existing scroll ownership.

**Step 4: Insert full card in detail page**

Use existing local `projectId`, provider, project name, and item ID. Place card first in left content pane.

While touching this block, render `acceptanceCriteria` in `WorkItemDetails`; current preview supports it but full detail omits it. Add it to `hasContent`.

**Step 5: Run tests and type check**

Run: `pnpm test -- src/lib/work-item-summary-visibility.test.ts src/lib/work-item-preview-query-policy.test.ts`

Run: `pnpm ts-check`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/work-item/ui-work-item-preview/index.tsx src/features/feed/ui-work-item-details/index.tsx src/features/work-item/ui-azure-board-overlay/project-content.tsx src/features/work-item/ui-work-item-picker/index.tsx src/features/pull-request/ui-pr-work-items/index.tsx src/features/work-activity/ui-work-activity-overlay/index.tsx src/lib/work-item-summary-visibility.test.ts
git commit -m "feat(work-items): show summaries in preview and details"
```

### Task 10: Add Compact Board and Feed Excerpts

**Files:**
- Modify: `src/features/work-item/ui-work-item-board/index.tsx:59-83,299-435`
- Modify: `src/features/work-item/ui-azure-board-overlay/project-content.tsx:136-155,503-537`
- Modify: `shared/feed-types.ts:49-59`
- Modify: `electron/services/feed-service.ts:945-1001`
- Modify: `src/features/feed/ui-feed-list/feed-item-card.tsx:795-868`
- Test: `src/lib/work-item-board-utils.test.ts`
- Test: `src/hooks/use-feed.test.ts`

**Step 1: Write failing board excerpt tests**

Add pure map/helper coverage proving:

- one batch summary lookup handles all visible work-item IDs
- first problem bullet becomes excerpt
- Markdown markers are shown as plain text, not rendered
- excerpt omitted when cache missing
- field stale status compares work item `changedDate` with persisted `sourceChangedDate`

**Step 2: Batch-load board summaries**

Call `useCachedWorkItemSummaries` once per board, not once per card. Build map keyed by ID. Render one clamped line after title and before progress/tags. Add stale visual only when field date differs; do not request comments from cards.

Rename existing HTML helper `workItemSummary` in `project-content.tsx` to `workItemExcerpt` to avoid collision with generated-summary terminology.

**Step 3: Write failing feed tests**

Extend `FeedItem` fixture and assertions for optional `workItemSummary`. Verify work-item merge/partition logic preserves field and missing summaries remain absent.

**Step 4: Populate feed excerpts without N+1 queries**

Add optional `workItemSummary?: string` to `FeedItem`. In `fetchWorkItemFeedItems`, collect work-item IDs by provider, batch-query `WorkItemSummaryRepository.findByWorkItems`, and attach excerpt while constructing or patching feed items. Compare `changedDate` to persisted `sourceChangedDate`; omit stale excerpt or include explicit stale flag if design needs indicator. Do not fetch comments.

Preferred behavior: keep excerpt visible and add `workItemSummaryStale?: boolean`, matching full-card stale policy.

**Step 5: Render feed excerpt**

For `item.source === 'work-item'`, render one clamped plain-text line between title and metadata. Ensure immutable feed document updates so memoized cards rerender after generation; generation hook invalidates `feed:workItems`.

**Step 6: Run focused tests**

Run: `pnpm test -- src/lib/work-item-board-utils.test.ts src/hooks/use-feed.test.ts electron/services/work-item-summary-generation-service.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/features/work-item/ui-work-item-board/index.tsx src/features/work-item/ui-azure-board-overlay/project-content.tsx shared/feed-types.ts electron/services/feed-service.ts src/features/feed/ui-feed-list/feed-item-card.tsx src/lib/work-item-board-utils.test.ts src/hooks/use-feed.test.ts
git commit -m "feat(work-items): show compact summary excerpts"
```

### Task 11: End-to-End Verification and Review

**Files:**
- Modify only files required by verification failures

**Step 1: Install exact dependencies**

Run: `pnpm install`

Expected: successful install and lockfile consistency.

**Step 2: Run full tests**

Run: `pnpm test`

Expected: all tests pass.

**Step 3: Auto-fix lint**

Run: `pnpm lint --fix`

Expected: no unfixable errors; inspect auto-edits before proceeding.

**Step 4: Run TypeScript checks**

Run: `pnpm ts-check`

Expected: both web and node TypeScript projects pass.

**Step 5: Run final lint**

Run: `pnpm lint`

Expected: no remaining lint errors.

**Step 6: Perform manual smoke test**

Use configured Azure project:

1. Open board preview for item with description, acceptance criteria, and comments.
2. Generate summary; verify background progress and expanded result.
3. Confirm sections omit empty content and optional visual renders.
4. Copy summary; paste into plain editor and verify Markdown/fence.
5. Navigate away/back; verify cached summary loads.
6. Verify board and feed show one-line excerpt without auto-generation.
7. Add comment in Azure/Jean-Claude; reopen item; verify stale badge.
8. Regenerate; verify stale badge clears and excerpt updates.
9. Force provider/model failure; verify prior summary remains and retry works.
10. Test malformed Mermaid fixture; verify source fallback, no crash.

**Step 7: Request code review**

Use `@requesting-code-review`. Review focus:

- prompt-injection boundary
- complete comment pagination
- temp-file cleanup on every path
- source fingerprint correctness
- no per-card IPC/API request pattern
- Mermaid strict mode and render fallback
- stale cache semantics
- unrelated existing worktree changes preserved

**Step 8: Commit verification fixes**

```bash
git add <only-files-changed-by-verification>
git commit -m "fix(work-items): address summary verification findings"
```

Skip commit if verification produces no changes.

## Implementation Notes

- Use `apply_patch` for manual edits.
- Keep summary source content untrusted. Azure fields/comments can contain prompt-injection text; prompt must label boundaries and forbid following source instructions.
- Keep all comments available. Temp-file spill controls prompt transport, not truncation.
- Do not modify changelog files; user did not request changelog update.
- Do not reuse existing task git-diff `TaskSummary`; domain, freshness, and UI differ.
- Do not add auto-generation on open. Reads may check freshness, generation stays explicit.
- Do not render Mermaid on board/feed cards.
- Do not fetch comments from board/feed cards.
- If migration 075 conflicts after branch update, renumber this branch migration after main’s latest migration; never edit main migration.
