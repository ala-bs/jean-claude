# GitHub Sources for Skills and Agents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Settings > Sources so users can add GitHub repositories as catalogs, scan for skills and agents, install selected items into Jean-Claude managed folders, and track source provenance for explicit drift-safe updates.

**Architecture:** Add a filesystem-backed source manifest and a new Electron source-management service. Sources are cloned catalogs only; installs copy selected source items into existing managed skill/agent storage and reuse existing backend symlink enablement. Renderer adds a shared Sources settings section while Skills and Agents stay focused on installed inventory.

**Tech Stack:** Electron main process, TypeScript, Node fs/git via `execFile`, React, TanStack Query, existing IPC/preload bridge, Vitest.

---

### Task 1: Shared Source Types

**Files:**
- Create: `shared/source-management-types.ts`

**Step 1: Add shared types**

Create `shared/source-management-types.ts`:

```ts
import type { AgentBackendType } from './agent-backend-types';

export type SourceKind = 'github';
export type SourceItemKind = 'skill' | 'agent';

export interface DetectedSourceItem {
  id: string;
  kind: SourceItemKind;
  sourceRelativePath: string;
  sourceCommit: string;
  detectedName: string;
  detectedDescription: string;
  sourceContentHash: string;
}

export interface SourceInstallRecord {
  id: string;
  kind: SourceItemKind;
  sourceItemId: string;
  sourceRelativePath: string;
  sourceCommit: string;
  sourceContentHash: string;
  installedPath: string;
  installedName: string;
  installedContentHash: string;
  installedAt: string;
  updatedAt?: string;
}

export interface ManagedSource {
  id: string;
  type: SourceKind;
  url: string;
  owner: string;
  repo: string;
  branch: string;
  clonePath: string;
  currentCommit: string;
  lastFetchedAt: string;
  lastScanAt: string;
  error?: string;
  items: DetectedSourceItem[];
  installs: SourceInstallRecord[];
}

export interface SourceManifest {
  version: 1;
  sources: ManagedSource[];
}

export type SourceInstallStatus =
  | 'available'
  | 'installed'
  | 'up-to-date'
  | 'update-available'
  | 'local-changes'
  | 'source-missing'
  | 'installed-missing'
  | 'conflict';

export interface SourceItemView extends DetectedSourceItem {
  install?: SourceInstallRecord;
  status: SourceInstallStatus;
  currentInstalledContentHash?: string;
}

export interface SourceView extends Omit<ManagedSource, 'items'> {
  items: SourceItemView[];
}

export interface AddGithubSourceParams {
  url: string;
}

export interface InstallSourceItemParams {
  sourceId: string;
  sourceItemId: string;
  targetName: string;
  enabledBackends: AgentBackendType[];
}

export interface InstallSourceItemsParams {
  items: InstallSourceItemParams[];
}

export interface UpdateSourceInstallParams {
  sourceId: string;
  installId: string;
  overwriteLocalChanges?: boolean;
}
```

**Step 2: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS or existing unrelated errors only.

**Step 3: Commit**

```bash
git add shared/source-management-types.ts
git commit -m "feat(sources): add shared source types"
```

### Task 2: Export Minimal Skill and Agent Path Helpers

**Files:**
- Modify: `electron/services/skill-management-service.ts`
- Modify: `electron/services/agent-management-service.ts`
- Test: existing service tests compile

**Step 1: Export path helpers from skill service**

In `electron/services/skill-management-service.ts`, export existing canonical base and name normalizer behavior with narrowly scoped helpers:

```ts
export function normalizeSkillTargetName(name: string): string {
  return normalizeSkillDirName(name);
}

export function getUserSkillCanonicalPath(name: string): string {
  return path.join(JC_USER_SKILLS_DIR, normalizeSkillDirName(name));
}
```

Keep existing private `normalizeSkillDirName` unchanged so current callers do not change.

**Step 2: Export path helpers from agent service**

In `electron/services/agent-management-service.ts`, export existing canonical target behavior:

```ts
export function normalizeAgentTargetFileName(name: string): string {
  return normalizeAgentFileName(name);
}

export function getUserAgentCanonicalPath(name: string): string {
  return path.join(JC_USER_AGENTS_DIR, normalizeAgentFileName(name));
}
```

**Step 3: Run focused tests**

Run: `pnpm test -- electron/services/skill-management-service.test.ts electron/services/agent-management-service.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add electron/services/skill-management-service.ts electron/services/agent-management-service.ts
git commit -m "refactor(sources): expose managed path helpers"
```

### Task 3: Source Manifest and GitHub URL Utilities

**Files:**
- Create: `electron/services/source-management-service.ts`
- Create: `electron/services/source-management-service.test.ts`

**Step 1: Write failing tests for URL parsing and manifest defaults**

Create `electron/services/source-management-service.test.ts` with tests for:

```ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  parseGithubRepoUrl,
  readSourceManifest,
  writeSourceManifest,
} from './source-management-service';

describe('source management github urls', () => {
  it('parses https github urls', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
    });
  });

  it('parses .git github urls', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
    });
  });

  it('rejects non-github urls', () => {
    expect(() => parseGithubRepoUrl('https://example.com/a/b')).toThrow(
      'GitHub',
    );
  });
});

describe('source manifest', () => {
  it('returns empty manifest when file is missing', async () => {
    const manifestPath = path.join(os.homedir(), '.config/jean-claude/sources/manifest.json');
    await fs.rm(manifestPath, { force: true });

    await expect(readSourceManifest()).resolves.toEqual({
      version: 1,
      sources: [],
    });
  });

  it('round trips manifest json', async () => {
    const manifest = { version: 1 as const, sources: [] };
    await writeSourceManifest(manifest);
    await expect(readSourceManifest()).resolves.toEqual(manifest);
  });
});
```

**Step 2: Run tests and verify failure**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: FAIL because service does not exist.

**Step 3: Implement manifest helpers**

Create `electron/services/source-management-service.ts` with:

```ts
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import type {
  SourceManifest,
} from '@shared/source-management-types';

const execFileAsync = promisify(execFile);
const SOURCES_DIR = path.join(os.homedir(), '.config', 'jean-claude', 'sources');
const MANIFEST_PATH = path.join(SOURCES_DIR, 'manifest.json');

export function parseGithubRepoUrl(input: string): {
  owner: string;
  repo: string;
  url: string;
} {
  const parsed = new URL(input.trim());
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('Expected a GitHub HTTPS repository URL');
  }

  const [owner, rawRepo, ...rest] = parsed.pathname
    .split('/')
    .filter(Boolean);
  if (!owner || !rawRepo || rest.length > 0) {
    throw new Error('Expected a GitHub repository URL like https://github.com/owner/repo');
  }

  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
    throw new Error('Invalid GitHub owner or repository name');
  }

  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export async function readSourceManifest(): Promise<SourceManifest> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf-8');
    return JSON.parse(raw) as SourceManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, sources: [] };
  }
}

export async function writeSourceManifest(manifest: SourceManifest): Promise<void> {
  await fs.mkdir(SOURCES_DIR, { recursive: true });
  const tmpPath = `${MANIFEST_PATH}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, MANIFEST_PATH);
}
```

Keep unused imports out if lint complains; later tasks will add git/hash functions.

**Step 4: Run focused tests**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/services/source-management-service.ts electron/services/source-management-service.test.ts
git commit -m "feat(sources): add source manifest helpers"
```

### Task 4: Repository Scanning and Hashing

**Files:**
- Modify: `electron/services/source-management-service.ts`
- Modify: `electron/services/source-management-service.test.ts`

**Step 1: Add tests for scanning**

Add tests that build a temp repo-like directory:

```ts
import { scanSourceDirectory } from './source-management-service';

it('detects skill directories with companion files', async () => {
  const root = path.join(os.homedir(), 'repo');
  await fs.mkdir(path.join(root, 'skills/reviewer/resources'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'skills/reviewer/SKILL.md'),
    '---\nname: reviewer\ndescription: Review code\n---\n\nUse review.\n',
    'utf-8',
  );
  await fs.writeFile(path.join(root, 'skills/reviewer/resources/a.md'), 'A\n', 'utf-8');

  const items = await scanSourceDirectory({ rootPath: root, commit: 'abc123' });

  expect(items).toContainEqual(
    expect.objectContaining({
      id: 'skill:skills/reviewer',
      kind: 'skill',
      sourceRelativePath: 'skills/reviewer',
      detectedName: 'reviewer',
      detectedDescription: 'Review code',
    }),
  );
});

it('detects agents only in known agent directories', async () => {
  const root = path.join(os.homedir(), 'repo');
  await fs.mkdir(path.join(root, 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'agents/reviewer.md'),
    '---\nname: reviewer-agent\ndescription: Review agent\n---\n\nReview.\n',
    'utf-8',
  );
  await fs.writeFile(path.join(root, 'docs/not-agent.md'), '# docs\n', 'utf-8');

  const items = await scanSourceDirectory({ rootPath: root, commit: 'abc123' });

  expect(items).toContainEqual(
    expect.objectContaining({
      id: 'agent:agents/reviewer.md',
      kind: 'agent',
      sourceRelativePath: 'agents/reviewer.md',
      detectedName: 'reviewer-agent',
    }),
  );
  expect(items.some((item) => item.sourceRelativePath === 'docs/not-agent.md')).toBe(false);
});
```

**Step 2: Run tests and verify failure**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: FAIL because scanning is missing.

**Step 3: Implement scanning**

Add `scanSourceDirectory({ rootPath, commit })`:

- Walk directories recursively.
- Skip `.git`, `node_modules`, `.venv`, `dist`, `build`.
- Skip hidden dirs except `.claude` and `.opencode`.
- If a directory contains `SKILL.md`, add one skill item and do not recurse deeper into that skill dir.
- For agents, only include `.md` files under `agents`, `.claude/agents`, and `.opencode/agents`.
- Use existing `parseFrontmatter` from `electron/lib/skill-frontmatter.ts`.
- Hash directories by reading sorted file paths and file contents.
- Hash files by file content.

**Step 4: Run focused tests**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/services/source-management-service.ts electron/services/source-management-service.test.ts
git commit -m "feat(sources): scan source skills and agents"
```

### Task 5: Add and Refresh GitHub Sources

**Files:**
- Modify: `electron/services/source-management-service.ts`
- Modify: `electron/services/source-management-service.test.ts`

**Step 1: Add tests with mocked local git repository**

Use `execFile('git', ...)` in tests to initialize a local bare-ish fixture only if existing tests already allow shelling out. Otherwise test clone-path and manifest behavior through internal helpers and leave end-to-end git behavior for manual verification.

Minimum tests:

- `buildGithubClonePath` creates deterministic path with owner, repo, hash.
- `addGithubSource` rejects duplicate source URL.
- `refreshSource` updates existing source items when clone path exists.

**Step 2: Implement git helpers**

Add helpers:

```ts
async function runGit(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, timeout: 60_000 });
  return String(result.stdout).trim();
}
```

Add public functions:

- `listSources(): Promise<SourceView[]>`
- `addGithubSource(params: AddGithubSourceParams): Promise<SourceView>`
- `refreshSource({ sourceId }: { sourceId: string }): Promise<SourceView>`

Implementation details:

- Clone with `git clone --depth 1 <url> <clonePath>`.
- Branch from `git rev-parse --abbrev-ref HEAD`.
- Commit from `git rev-parse HEAD`.
- Scan after clone and after refresh.
- On refresh error, keep old source and store `error`.
- On add error, do not persist partial source. Remove failed clone directory best-effort.

**Step 3: Run focused tests**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add electron/services/source-management-service.ts electron/services/source-management-service.test.ts
git commit -m "feat(sources): add github source refresh"
```

### Task 6: Install Source Items

**Files:**
- Modify: `electron/services/source-management-service.ts`
- Modify: `electron/services/source-management-service.test.ts`
- Modify: `electron/services/skill-management-service.ts` if enable helper visibility is needed
- Modify: `electron/services/agent-management-service.ts` if enable helper visibility is needed

**Step 1: Add install tests**

Add tests that create a source with one skill and one agent, then call `installSourceItems`:

- Skill directory is copied to `~/.config/jean-claude/skills/user/<target>`.
- Skill companion files are copied.
- Agent file is copied to `~/.config/jean-claude/agents/user/<target>.md`.
- Source content is preserved exactly.
- Backend symlink exists for selected backend.
- Manifest install record is created without backend enablement.
- Existing target path causes conflict and no overwrite.

**Step 2: Run tests and verify failure**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: FAIL because install function is missing.

**Step 3: Implement install function**

Add:

```ts
export async function installSourceItems(
  params: InstallSourceItemsParams,
): Promise<SourceView[]> {
  // read manifest, validate each source/item, copy to canonical paths, enable selected backends, write install records
}
```

Use exported helpers:

- `getUserSkillCanonicalPath(targetName)`
- `getUserAgentCanonicalPath(targetName)`
- `enableSkill({ skillPath, backendType })`
- `enableAgent({ agentPath, backendType })`

Copy rules:

- Skill: `fs.cp(sourcePath, targetPath, { recursive: true })` after ensuring target does not exist.
- Agent: create parent dir, then `fs.copyFile(sourcePath, targetPath)` after ensuring target does not exist.
- Hash installed target after copy.

**Step 4: Run focused tests**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/services/source-management-service.ts electron/services/source-management-service.test.ts electron/services/skill-management-service.ts electron/services/agent-management-service.ts
git commit -m "feat(sources): install selected source items"
```

### Task 7: Update Installed Source Items With Drift Protection

**Files:**
- Modify: `electron/services/source-management-service.ts`
- Modify: `electron/services/source-management-service.test.ts`

**Step 1: Add update status tests**

Test derived statuses:

- Installed copy unchanged and source unchanged -> `up-to-date`.
- Source changed and installed copy unchanged -> `update-available`.
- Installed copy changed -> `local-changes`.
- Source path removed -> `source-missing`.
- Installed path removed -> `installed-missing`.

**Step 2: Add update action tests**

Test:

- `updateSourceInstall` replaces skill directory when no local drift exists.
- `updateSourceInstall` rejects local drift unless `overwriteLocalChanges` is true.
- Agent update replaces markdown file.

**Step 3: Run tests and verify failure**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: FAIL because update/status logic is missing.

**Step 4: Implement status derivation and update**

Add:

- `listSources` returns `SourceView[]` with derived item statuses.
- `updateSourceInstall(params: UpdateSourceInstallParams)`.

For skill update:

- Remove target dir with `fs.rm(installedPath, { recursive: true, force: true })` only after drift check passes or override is true.
- Copy whole source skill directory.
- Rehash and update manifest record.

For agent update:

- Copy file over installed path after drift check passes or override is true.
- Rehash and update manifest record.

**Step 5: Run focused tests**

Run: `pnpm test -- electron/services/source-management-service.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add electron/services/source-management-service.ts electron/services/source-management-service.test.ts
git commit -m "feat(sources): update installs with drift checks"
```

### Task 8: IPC, Preload, and API Wiring

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`

**Step 1: Add API types**

In `src/lib/api.ts`, import source types and add `sourceManagement` API methods:

- `list(): Promise<SourceView[]>`
- `addGithub(params: AddGithubSourceParams): Promise<SourceView>`
- `refresh(sourceId: string): Promise<SourceView>`
- `installItems(params: InstallSourceItemsParams): Promise<SourceView[]>`
- `updateInstall(params: UpdateSourceInstallParams): Promise<SourceView[]>`
- `remove(sourceId: string): Promise<void>`

**Step 2: Add preload bridge**

In `electron/preload.ts`, add `sourceManagement` methods invoking:

- `sources:list`
- `sources:addGithub`
- `sources:refresh`
- `sources:installItems`
- `sources:updateInstall`
- `sources:remove`

**Step 3: Add IPC handlers**

In `electron/ipc/handlers.ts`, import source service functions and register handlers.

**Step 4: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts
git commit -m "feat(sources): wire source ipc api"
```

### Task 9: Renderer Hooks

**Files:**
- Create: `src/hooks/use-sources.ts`

**Step 1: Add source hooks**

Create hooks:

- `useSources`
- `useAddGithubSource`
- `useRefreshSource`
- `useInstallSourceItems`
- `useUpdateSourceInstall`
- `useRemoveSource`

Invalidate source queries after mutations. Also invalidate managed skills and agents after install/update/remove when installed inventory may change.

**Step 2: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS.

**Step 3: Commit**

```bash
git add src/hooks/use-sources.ts
git commit -m "feat(sources): add renderer source hooks"
```

### Task 10: Settings Navigation Entry

**Files:**
- Modify: `src/features/settings/ui-settings-overlay/index.tsx`
- Create: `src/features/settings/ui-sources-settings/index.tsx`

**Step 1: Create placeholder Sources settings**

Create `src/features/settings/ui-sources-settings/index.tsx`:

```tsx
export function SourcesSettings() {
  return <p className="text-ink-3">Sources loading...</p>;
}
```

**Step 2: Add settings nav item**

In `ui-settings-overlay/index.tsx`:

- Import an icon like `GitBranch` or `Github` if available from `lucide-react`.
- Import `SourcesSettings`.
- Add global section near Skills/Agents:

```ts
{
  id: 'sources',
  label: 'Sources',
  icon: GitBranch,
  title: 'Sources',
  subtitle: 'Import skills and agents from repositories',
}
```

- Render `<SourcesSettings />` in the section switch.
- Include `sources` in any settings section predicates that list agent/skill-related pages if needed.

**Step 3: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/features/settings/ui-settings-overlay/index.tsx src/features/settings/ui-sources-settings/index.tsx
git commit -m "feat(sources): add settings section"
```

### Task 11: Sources UI List and Add Flow

**Files:**
- Modify: `src/features/settings/ui-sources-settings/index.tsx`

**Step 1: Build source list and add form**

Use `useSources` and `useAddGithubSource`:

- Empty state with Add Source button.
- URL input for GitHub repository.
- Add button with loading state.
- List source owner/repo, branch, short commit, last scan time.
- Select first source by default.
- Show error toast or inline error on add failure.

Follow existing settings UI patterns from Skills and Agents pages. Keep selectors stable; do not create unstable Zustand selectors.

**Step 2: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS.

**Step 3: Commit**

```bash
git add src/features/settings/ui-sources-settings/index.tsx
git commit -m "feat(sources): add source list and github form"
```

### Task 12: Source Detail Install UI

**Files:**
- Modify: `src/features/settings/ui-sources-settings/index.tsx`

**Step 1: Add source detail view**

For selected source:

- Header with owner/repo, branch, short commit.
- Refresh button wired to `useRefreshSource`.
- Sections for Skills and Agents.
- Rows show detected name, relative path, status badge.
- Checkbox per installable item.
- Target name input for selected item, initialized from detected name.
- Backend checkboxes for selected item or shared defaults.
- Install button calls `useInstallSourceItems`.

Keep v1 simple: one install payload list built from selected rows with their current target names and backend selections.

**Step 2: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS.

**Step 3: Commit**

```bash
git add src/features/settings/ui-sources-settings/index.tsx
git commit -m "feat(sources): install items from source detail"
```

### Task 13: Update and Drift UI

**Files:**
- Modify: `src/features/settings/ui-sources-settings/index.tsx`

**Step 1: Add update controls**

For installed rows:

- `up-to-date`: disabled Up to date badge.
- `update-available`: Update button.
- `local-changes`: Update button opens confirm dialog or `window.confirm` if existing app has no small confirm pattern.
- `source-missing` and `installed-missing`: warning badge.

Call `useUpdateSourceInstall` with `overwriteLocalChanges: true` only after explicit confirmation.

**Step 2: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS.

**Step 3: Commit**

```bash
git add src/features/settings/ui-sources-settings/index.tsx
git commit -m "feat(sources): update source installs from ui"
```

### Task 14: Provenance Badges in Skills and Agents

**Files:**
- Modify: `src/hooks/use-managed-skills.ts`
- Modify: `src/hooks/use-managed-agents.ts`
- Modify: `src/features/settings/ui-skills-settings/skill-details.tsx`
- Modify: `src/features/settings/ui-agents-settings/index.tsx`
- Modify: `shared/skill-types.ts`
- Modify: `shared/agent-management-types.ts`

**Step 1: Add optional provenance fields**

Add optional field to `ManagedSkill` and `ManagedAgent`:

```ts
sourceProvenance?: {
  sourceId: string;
  owner: string;
  repo: string;
  commit: string;
};
```

**Step 2: Populate provenance**

In source service, expose helper to load provenance by installed path. In skill/agent management discovery, merge provenance from manifest by exact installed path.

Keep this optional and best-effort; if manifest read fails, do not break installed inventory.

**Step 3: Render badges**

In detail panes, show:

```text
Source: owner/repo @ abc123
```

Only render when `sourceProvenance` exists.

**Step 4: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/skill-types.ts shared/agent-management-types.ts src/hooks/use-managed-skills.ts src/hooks/use-managed-agents.ts src/features/settings/ui-skills-settings/skill-details.tsx src/features/settings/ui-agents-settings/index.tsx electron/services/source-management-service.ts electron/services/skill-management-service.ts electron/services/agent-management-service.ts
git commit -m "feat(sources): show install provenance"
```

### Task 15: Final Verification

**Files:**
- All touched files

**Step 1: Install dependencies**

Run: `pnpm install`

Expected: completes successfully.

**Step 2: Run tests**

Run: `pnpm test`

Expected: PASS.

**Step 3: Auto-fix lint**

Run: `pnpm lint --fix`

Expected: completes; may modify formatting/imports.

**Step 4: Run TypeScript check**

Run: `pnpm ts-check`

Expected: PASS.

**Step 5: Run final lint**

Run: `pnpm lint`

Expected: PASS.

**Step 6: Inspect git diff**

Run: `git status && git diff --stat`

Expected: only intended source-management changes.

**Step 7: Commit verification fixes**

If lint or TypeScript changed files, commit fixes:

```bash
git add <changed files>
git commit -m "chore(sources): finish source import verification"
```
