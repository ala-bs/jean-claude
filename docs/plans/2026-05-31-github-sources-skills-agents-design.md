# GitHub Sources for Skills and Agents

## Goal

Add a source-management flow that lets users paste a GitHub repository URL, scan the repository for skills and agents, select specific items to install, and track where installed items came from.

The repository is a catalog source. Jean-Claude does not run skills or agents directly from the cloned repository. Installed items are copied into Jean-Claude's existing managed folders, then enabled for backends through the existing symlink mechanism.

## Non-Goals

- Do not automatically install every detected skill or agent from a repository.
- Do not automatically update installed skills or agents when a source repository changes.
- Do not store backend enablement in source mappings. Backend enablement remains derived from symlinks.
- Do not rewrite source content during install. `SKILL.md`, agent markdown, and companion files are copied as-is.
- Do not support branch selection in v1. Clone the repository default branch.

## User Flow

1. User opens Settings > Sources.
2. User clicks Add Source and enters a GitHub repository URL.
3. Jean-Claude clones the repository into its source cache and scans it.
4. Jean-Claude shows detected skills and agents grouped by type.
5. User selects specific items to install.
6. For each selected item, user can edit the target installed name.
7. User chooses backend enablement with Claude Code and OpenCode checkboxes.
8. Jean-Claude copies selected items into managed canonical folders.
9. Jean-Claude creates backend symlinks according to selected backend checkboxes.
10. Source provenance is recorded in `manifest.json`.
11. Later, user can refresh the source repository and explicitly update installed copies.

## Storage Model

Source data lives under:

```text
~/.config/jean-claude/sources/
  manifest.json
  github/
    <owner>/
      <repo>-<hash>/
```

The hash suffix avoids collisions between repositories with the same visible name, forks, or future URL variants.

The manifest is the source of truth for repository metadata, detected source items, and install provenance. It is not the source of truth for backend enablement.

Example manifest shape:

```ts
{
  version: 1,
  sources: [
    {
      id: 'github:owner/repo',
      type: 'github',
      url: 'https://github.com/owner/repo',
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      clonePath: '/Users/me/.config/jean-claude/sources/github/owner/repo-a1b2c3',
      currentCommit: 'abc123...',
      lastFetchedAt: '2026-05-31T12:00:00.000Z',
      lastScanAt: '2026-05-31T12:00:00.000Z',
      items: [
        {
          id: 'skill:skills/reviewer',
          kind: 'skill',
          sourceRelativePath: 'skills/reviewer',
          sourceCommit: 'abc123...',
          detectedName: 'reviewer',
          detectedDescription: 'Review code changes',
          sourceContentHash: 'sha256:...'
        }
      ],
      installs: [
        {
          id: 'install:skill:skills/reviewer',
          kind: 'skill',
          sourceItemId: 'skill:skills/reviewer',
          sourceRelativePath: 'skills/reviewer',
          sourceCommit: 'abc123...',
          sourceContentHash: 'sha256:...',
          installedPath: '/Users/me/.config/jean-claude/skills/user/my-reviewer',
          installedName: 'my-reviewer',
          installedContentHash: 'sha256:...',
          installedAt: '2026-05-31T12:05:00.000Z'
        }
      ]
    }
  ]
}
```

## GitHub URL Handling

V1 accepts normal GitHub repository URLs:

```text
https://github.com/owner/repo
https://github.com/owner/repo.git
```

The service normalizes the URL into `owner`, `repo`, and canonical HTTPS URL. It clones the default branch with `git clone --depth 1`, then records the actual checked-out branch and commit with Git commands.

Refresh runs `git pull --ff-only`, records the new commit, and rescans the repository. Refresh never changes installed copies.

## Detection Rules

Skills:

- A skill is any directory containing `SKILL.md`.
- The detected name comes from `SKILL.md` frontmatter `name`, then falls back to the directory name.
- The detected description comes from frontmatter `description`, then falls back to an empty string.

Agents are markdown files under known agent directories:

- `agents/*.md`
- `.claude/agents/*.md`
- `.opencode/agents/*.md`
- The detected name comes from frontmatter `name`, then falls back to the file basename.
- The detected description comes from frontmatter `description`, then falls back to an empty string.

Scanning skips:

- `.git`
- `node_modules`
- `.venv`
- `dist`
- `build`
- hidden directories except `.claude` and `.opencode`

## Install Behavior

Installing copies selected items into existing Jean-Claude managed folders.

Skills:

```text
~/.config/jean-claude/skills/user/<normalized-target-name>/
```

The whole skill directory is copied, including `SKILL.md` and companion files. Source content is preserved exactly.

Agents:

```text
~/.config/jean-claude/agents/user/<normalized-target-name>.md
```

The source markdown file is copied exactly.

After copying, Jean-Claude creates backend symlinks based on install-time checkbox selection. Backend enablement remains observable from existing symlinks and is not duplicated into the manifest.

If the target canonical path already exists, install shows a conflict and does not overwrite.

## Update Behavior

Updating installed items is explicit and per item. A source refresh can show update availability, but it cannot mutate installed copies.

For each installed item, Jean-Claude compares hashes:

- `sourceContentHash`: hash of source item at install time.
- `installedContentHash`: hash of installed copy immediately after install or last update.
- current source hash: hash from latest source scan.
- current installed hash: hash of current installed copy.

Derived statuses:

- `up-to-date`: current source hash matches install source hash and installed copy has no drift.
- `update-available`: current source hash differs and installed copy still matches last installed hash.
- `local-changes`: installed copy differs from last installed hash.
- `source-missing`: source path no longer exists after refresh.
- `installed-missing`: installed path no longer exists.

If local changes exist, Jean-Claude prompts before overwrite. If user confirms update:

- Skill update replaces the entire installed skill directory with the source skill directory.
- Agent update replaces the installed markdown file with the source markdown file.
- Manifest install record updates source commit, source hash, installed hash, and timestamp.

## UI Design

Add Settings > Sources as a shared management view for GitHub sources.

Source list:

- Repository owner/name.
- Current branch and short commit.
- Last refresh time.
- Error state if clone or refresh failed.

Source detail:

- Repository metadata and Refresh button.
- Detected Skills section.
- Detected Agents section.
- Selection controls for install.
- Target name input per selected item.
- Backend enablement checkboxes per selected item or batch defaults.
- Install action.
- Installed/update status badges.

Skills and Agents settings remain focused on installed inventory. Their detail panes can show a provenance badge when an installed item has a source install record:

```text
Source: owner/repo @ abc123
```

## Architecture

New shared types:

- `shared/source-management-types.ts`
- `SourceManifest`
- `ManagedSource`
- `DetectedSourceItem`
- `SourceInstallRecord`
- source and install status types

New Electron service:

- `electron/services/source-management-service.ts`

Responsibilities:

- Parse and normalize GitHub URLs.
- Clone repositories into source cache.
- Refresh repositories with `git pull --ff-only`.
- Scan repositories for skills and agents.
- Hash skill directories and agent files.
- Read and write `manifest.json` atomically.
- Install selected source items into canonical managed folders.
- Update installed items with drift checks.

Existing service integration:

- Export or add helpers from skill management for canonical skill paths and backend symlink creation.
- Export or add helpers from agent management for canonical agent paths and backend symlink creation.
- Keep current create/edit/delete behavior unchanged for manually created items.

IPC namespace:

- `sources:list`
- `sources:addGithub`
- `sources:refresh`
- `sources:installItems`
- `sources:updateInstall`
- `sources:remove`

Renderer hooks:

- `useSources`
- `useAddGithubSource`
- `useRefreshSource`
- `useInstallSourceItems`
- `useUpdateSourceInstall`

Renderer feature folder:

- `src/features/settings/ui-sources-settings/`

## Error Handling

- Invalid GitHub URL: show validation error before clone.
- Clone failure: source is not added unless clone succeeds.
- Refresh failure: keep existing source metadata and show error state.
- Scan failure: keep previous scan data and show error state.
- Install conflict: do not overwrite existing managed skill or agent.
- Local drift on update: require explicit confirmation before overwrite.
- Missing clone path: show `missing-clone` and offer reclone or remove source in future iteration.

## Testing

Unit tests for service logic:

- GitHub URL parsing and normalization.
- Manifest read/write and migration defaults.
- Skill detection from nested `SKILL.md` directories.
- Agent detection under supported agent directories.
- Hashing skill directories and agent files.
- Install conflict detection.
- Drift status derivation.

Integration-style tests with temp directories:

- Add source from local fixture repository.
- Install selected skill and agent.
- Verify copied canonical files.
- Verify backend symlinks are created from install backend choices.
- Refresh source and derive update status without mutating installed copies.
- Update installed skill replaces whole directory after safe drift check.

Renderer tests can focus on source detail state rendering and install/update action wiring if existing test patterns support it.

## Open Follow-Ups

- Support branch selection or GitHub `/tree/<branch>` URLs.
- Support SSH GitHub URLs.
- Add source item ignore state.
- Add "reclone missing source" action.
- Add bulk update for safe update-available items.
- Add source provenance filtering in Skills and Agents settings.
