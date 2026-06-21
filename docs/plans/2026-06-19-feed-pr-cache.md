# Feed PR Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make feed PR carousel and PR detail page share one canonical PR snapshot so title, draft state, owner, and status never diverge.

**Architecture:** Keep feed source fetching split by domain in `useFeed()`: tasks, pull requests, notes, and work items. Treat PR feed items as feed metadata plus PR identity, while canonical PR display fields live in the shared pull request cache populated by `fetchPrFeedItems()` and detail fetches. Preserve existing priority and partition logic in renderer.

**Tech Stack:** Electron IPC, TanStack Query, Legend State cache, React, TypeScript, Vitest.

---

### Task 1: Document Current Split Feed Query Behavior

**Files:**
- Modify: `docs/plans/2026-06-19-feed-pr-cache.md`
- Inspect: `src/hooks/use-feed.ts:114-156`
- Inspect: `electron/ipc/handlers.ts:5524-5543`

**Step 1: Verify feed is already split in renderer**

Read `src/hooks/use-feed.ts:114-156` and confirm it uses four queries: `getTaskItems`, `getPullRequestItems`, `getNoteItems`, `getWorkItemItems`.

**Step 2: Verify IPC endpoints exist**

Read `electron/ipc/handlers.ts:5524-5543` and confirm separate handlers exist for each feed source.

**Step 3: Record invariant**

Add note to implementation PR or commit body: `FeedList already triggers independent feed source fetches; refactor should preserve this path and remove dependence on aggregate feed:getItems for renderer feed.`

**Step 4: Run no tests**

No code change expected.

**Step 5: Commit**

Skip commit if only plan execution note changes.

---

### Task 2: Add Failing Test For PR Feed Draft Metadata

**Files:**
- Modify: `electron/services/feed-service.test.ts` if it exists
- Create: `electron/services/feed-service.test.ts` if missing
- Inspect: `electron/services/feed-service.ts:685-715`

**Step 1: Locate feed service tests**

Run: `pnpm vitest run electron/services/feed-service.test.ts`

Expected if missing: no matching test file or no tests.

**Step 2: Write test for PR feed item draft flag**

Mock `listPullRequests()` to return one active draft PR with `isDraft: true`, `title: 'Smartbar POC'`, `id: 9886`.

Expected assertion:

```ts
expect(items[0]).toMatchObject({
  source: 'pull-request',
  pullRequestId: 9886,
  title: 'Smartbar POC',
  isDraft: true,
});
```

**Step 3: Run test to verify failure**

Run: `pnpm vitest run electron/services/feed-service.test.ts`

Expected: FAIL because `isDraft` is absent on PR feed item.

**Step 4: Do not implement yet**

Stop after failing test.

**Step 5: Commit**

Run:

```bash
git add electron/services/feed-service.test.ts
git commit -m "test: cover draft state in PR feed items"
```

---

### Task 3: Populate PR Feed Item Draft Metadata

**Files:**
- Modify: `electron/services/feed-service.ts:685-715`
- Test: `electron/services/feed-service.test.ts`

**Step 1: Implement minimal field copy**

Add `isDraft: pr.isDraft` to PR feed item mapping in `fetchPrFeedItems()`.

Expected code shape:

```ts
const items = prs.map(
  (pr): FeedItem => ({
    id: `pr:${project.id}:${pr.id}`,
    source: 'pull-request',
    attention: 'review-requested',
    timestamp: pr.creationDate,
    projectId: project.id,
    projectName: project.name,
    projectColor: project.color,
    projectLogoPath: project.logoPath,
    projectPriority: project.prPriority as 'high' | 'normal' | 'low',
    title: pr.title,
    isDraft: pr.isDraft,
    pullRequestId: pr.id,
  }),
);
```

Keep existing fields not shown in snippet.

**Step 2: Run test**

Run: `pnpm vitest run electron/services/feed-service.test.ts`

Expected: PASS.

**Step 3: Run existing feed hook tests**

Run: `pnpm vitest run src/hooks/use-feed.test.ts src/lib/use-feed-partition.test.ts`

Expected: PASS.

**Step 4: Commit**

Run:

```bash
git add electron/services/feed-service.ts electron/services/feed-service.test.ts
git commit -m "fix: include draft state in PR feed items"
```

---

### Task 4: Add Failing Test For Cache Snapshot Sharing

**Files:**
- Modify: `src/cache/domains/pull-requests.test.ts:146-201`
- Inspect: `electron/services/feed-service.ts:112-124`
- Inspect: `src/cache/cache-events.ts:264-279`

**Step 1: Add cache merge assertion for draft summary**

In `src/cache/domains/pull-requests.test.ts`, add or extend summary/detail merge test so summary snapshot includes `isDraft: true`.

Expected assertion:

```ts
expect(
  selectPullRequest({
    providerId: 'github',
    repoId: 'repo-1',
    pullRequestId: 42,
  }),
).toMatchObject({
  id: 42,
  title: 'Updated summary title',
  isDraft: true,
});
```

**Step 2: Run cache test**

Run: `pnpm vitest run src/cache/domains/pull-requests.test.ts`

Expected: PASS if cache already preserves field. If FAIL, continue Task 5.

**Step 3: Confirm feed snapshots use same cache path**

Read `electron/services/feed-service.ts:112-124` and confirm `emitPullRequestSnapshots()` emits `pullRequest.upsert`.

Read `src/cache/cache-events.ts:264-279` and confirm `pullRequest.upsert` calls `mergePullRequestSnapshot()`.

**Step 4: Commit test if changed**

Run:

```bash
git add src/cache/domains/pull-requests.test.ts
git commit -m "test: cover PR draft state in shared cache"
```

---

### Task 5: Make Carousel Prefer Canonical PR Cache With Safe Fallback

**Files:**
- Modify: `src/features/feed/ui-feed-list/index.tsx:793-890`
- Test: add component test only if existing feed component test harness exists

**Step 1: Keep current cache read**

Preserve `useCachedPullRequest(item.projectId, item.pullRequestId)` in `PrReviewCarouselCard`.

**Step 2: Make display fields explicit**

Use these derivations:

```ts
const title = cachedPr?.title ?? item.title;
const isDraft = cachedPr?.isDraft ?? item.isDraft ?? false;
const ownerName =
  cachedPr?.createdBy.displayName ?? item.subtitle ?? item.ownerName ?? '';
```

**Step 3: Keep PR number badge separate**

Do not replace bottom-right `#{item.pullRequestId}` badge. Title line remains PR title only.

**Step 4: Run targeted tests**

Run: `pnpm vitest run src/hooks/use-feed.test.ts src/lib/use-feed-partition.test.ts`

Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add src/features/feed/ui-feed-list/index.tsx
git commit -m "fix: render PR carousel from shared cache fallback"
```

---

### Task 6: Remove Aggregate Feed Query From Renderer API Usage

**Files:**
- Inspect: `src/**/*.ts`
- Inspect: `src/**/*.tsx`
- Modify: only files still calling `api.feed.getItems()`

**Step 1: Search renderer aggregate feed usage**

Run: `rg "feed\.getItems|feedQueryKeys\.items" src`

Expected: no production usage, or only stale tests/helpers.

**Step 2: Replace production usage if found**

If any component calls `api.feed.getItems()`, replace with `useFeed()` or source-specific query.

**Step 3: Keep IPC handler for compatibility unless no callers exist anywhere**

Do not remove `feed:getItems` yet unless `rg "feed:getItems|getItems" electron src shared` proves no external/IPC callers need it.

**Step 4: Run feed tests**

Run: `pnpm vitest run src/hooks/use-feed.test.ts`

Expected: PASS.

**Step 5: Commit if changed**

Run:

```bash
git add src electron shared
git commit -m "refactor: avoid aggregate feed item fetch in renderer"
```

---

### Task 7: Final Validation

**Files:**
- All changed files

**Step 1: Install dependencies**

Run: `pnpm install`

Expected: completes. Node engine warning may appear if local Node is `v24`; repo expects `>=20.18 <21`.

**Step 2: Run tests**

Run: `pnpm test`

Expected: all tests pass.

**Step 3: Run lint fix**

Run: `pnpm lint --fix`

Expected: completes, may modify formatting.

**Step 4: Run TypeScript check**

Run: `pnpm ts-check`

Expected: no TypeScript errors.

**Step 5: Run final lint**

Run: `pnpm lint`

Expected: no lint errors.

**Step 6: Inspect diff**

Run: `git diff --stat && git diff`

Expected: only PR feed/cache/carousel changes, no changelog edits.

**Step 7: Commit final fixes if needed**

Run:

```bash
git add electron/services/feed-service.ts electron/services/feed-service.test.ts src/cache/domains/pull-requests.test.ts src/features/feed/ui-feed-list/index.tsx
git commit -m "fix: share PR draft state across feed carousel"
```

Skip if earlier commits already captured all changes.
