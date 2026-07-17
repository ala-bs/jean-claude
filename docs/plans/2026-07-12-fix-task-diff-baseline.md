# Task Diff Baseline Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Calculate task diffs from nearest common ancestor of task worktree and local source branch, even when stored source ref uses `origin/` or `refs/remotes/origin/`.

**Architecture:** Normalize stored source ref into ordered Git ref candidates. Prefer local branch because worktree starts from local state; use remote ref only when local ref is unavailable. Reuse same candidate order for merge-base selection and merge-artifact filtering so file list, file content, and unified diff share one baseline.

**Tech Stack:** TypeScript, Node.js `execFile`, Git, Vitest

---

### Task 1: Cover Remote-Qualified Source Refs

**Files:**
- Modify: `electron/services/worktree-service.test.ts:54-117`

**Step 1: Write failing regression test**

Add test where:

```text
base -- local-main -- task-change
   \
    remote-main
```

Pass `origin/main` as `sourceBranch`. Assert diff contains only `task.txt`, not changes between local and remote source refs.

```ts
it('uses local source branch when stored source ref is remote-qualified', async () => {
  await writeFile('base.txt', 'base\n');
  await commit('base');

  await writeFile('remote-only.txt', 'remote\n');
  const remoteCommit = await commit('remote source commit');
  await git(['update-ref', 'refs/remotes/origin/main', remoteCommit]);

  await git(['reset', '--hard', 'HEAD^']);
  await writeFile('local-only.txt', 'local\n');
  await writeFile('task.txt', 'before\n');
  const startCommitHash = await commit('local source commit');

  await git(['switch', '-c', 'task']);
  await writeFile('task.txt', 'after\n');

  const diff = await getWorktreeDiff(testDir, startCommitHash, 'origin/main');

  expect(diff.files.map((file) => file.path)).toEqual(['task.txt']);
});
```

**Step 2: Run focused test and verify failure**

Run: `pnpm test electron/services/worktree-service.test.ts`

Expected: FAIL because `origin/main` resolves only remote ref and selects wrong merge-base/filter reference.

**Step 3: Commit failing test**

```bash
git add electron/services/worktree-service.test.ts
git commit -m "test(worktree): cover remote-qualified task diff source"
```

### Task 2: Normalize Source Ref Candidates

**Files:**
- Modify: `electron/services/worktree-service.ts:429-527`
- Test: `electron/services/worktree-service.test.ts`

**Step 1: Add minimal candidate resolver**

Add one helper near `getDiffBaseCommit`:

```ts
function getSourceBranchRefs(sourceBranch: string): string[] {
  const localBranch = sourceBranch
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '');

  return [localBranch, `origin/${localBranch}`];
}
```

Keep explicit local-first order. Do not fetch or mutate refs during diff calculation.

**Step 2: Use resolver for nearest common ancestor**

Replace inline `refs` construction in `getDiffBaseCommit`:

```ts
const refs = getSourceBranchRefs(sourceBranch);
```

Retain existing command:

```ts
await execFileAsync('git', ['merge-base', 'HEAD', ref], ...);
```

This remains nearest-common-ancestor calculation.

**Step 3: Use same resolver for merge-artifact filtering**

Replace inline `refs` construction in `getTaskChangedFiles`:

```ts
const refs = getSourceBranchRefs(sourceBranch);
```

This prevents file list filtering from comparing against a different source ref than baseline selection.

**Step 4: Run focused tests**

Run: `pnpm test electron/services/worktree-service.test.ts`

Expected: PASS, including local-ahead, merged-source, and remote-qualified cases.

**Step 5: Commit implementation**

```bash
git add electron/services/worktree-service.ts electron/services/worktree-service.test.ts
git commit -m "fix(worktree): normalize task diff source refs"
```

### Task 3: Verify Repository

**Files:**
- No planned source changes

**Step 1: Install dependencies**

Run: `pnpm install`

Expected: success.

**Step 2: Run full test suite**

Run: `pnpm test`

Expected: all tests pass.

**Step 3: Apply lint fixes**

Run: `pnpm lint --fix`

Expected: no unrelated file changes. Review any changed files before continuing.

**Step 4: Run TypeScript checks**

Run: `pnpm ts-check`

Expected: both web and node TypeScript projects pass.

**Step 5: Run final lint check**

Run: `pnpm lint`

Expected: no lint errors.

**Step 6: Review final diff**

Run: `git diff --check && git status --short`

Expected: only intended service, test, and plan changes remain.
