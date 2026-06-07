# Fork automation (upstream sync + theme audit)

For **ala-bs/jean-claude** (or any fork of [shantlr/jean-claude](https://github.com/shantlr/jean-claude)).

## What runs automatically

| Workflow | When | What it does |
|----------|------|----------------|
| **Daily upstream sync** | 08:00 UTC daily (+ manual) | Merges `upstream/main` → fork `main`, opens PR `sync/upstream-YYYY-MM-DD` → `local/light-theme` |
| **Theme audit** | On every PR to `local/light-theme` | Scans **only files changed in the PR** for hardcoded colors |

## One-time GitHub setup

1. Push these files to your fork (`local/light-theme`):
   ```bash
   git add .github scripts/theme-audit.mjs docs/local-fork-automation.md
   git commit -m "local: upstream sync and theme audit automation"
   git push origin local/light-theme
   ```

2. **Enable Actions** on the fork:  
   `https://github.com/ala-bs/jean-claude/actions` → enable workflows if prompted.

3. **Workflows on `main`** (required if default branch is `main`):  
   GitHub only registers scheduled / manual workflows from the **default branch**.  
   CI files are committed on fork `main` (no theme code) — keep them in sync when you edit workflows on `local/light-theme`:
   ```bash
   git checkout main
   git checkout local/light-theme -- .github scripts/theme-audit.mjs scripts/theme-audit-allowlist.txt
   # re-apply theme:audit script line in package.json if needed
   git commit -m "local: sync CI workflows from theme branch"
   git push origin main
   git checkout local/light-theme
   ```
   Alternative: set default branch to **`local/light-theme`** instead.

4. **Allow Actions to create PRs**:  
   Settings → Actions → General → Workflow permissions → **Read and write**.

5. **Timezone**: edit `.github/workflows/sync-upstream.yml` cron:
   - `0 8 * * *` = 08:00 UTC
   - 08:00 Paris (CET): `0 7 * * *`
   - 08:00 Paris (CEST): `0 6 * * *`

## Your daily routine

1. Morning: check **Pull requests** on your fork for `Sync upstream/main (…)`.
2. Open PR → wait for **Theme audit** check (green = no new hardcoded styles in the diff).
3. If red: run locally, fix, push to the PR branch:
   ```bash
   pnpm theme:audit --base origin/local/light-theme
   ```
4. Merge PR on GitHub → pull locally:
   ```bash
   git checkout local/light-theme
   git pull origin local/light-theme
   pnpm install && pnpm test
   ```

## Local commands

```bash
# Full scan (known debt allowlisted in scripts/theme-audit-allowlist.txt)
pnpm theme:audit

# Only files you changed vs theme branch
pnpm theme:audit --base origin/local/light-theme

# Ignore one line in source
// theme-audit:ignore
```

## Manual upstream sync (if Action failed)

```bash
git fetch upstream origin
git checkout local/light-theme
git merge upstream/main
pnpm theme:audit --base HEAD~1   # files touched by merge
pnpm test
git push origin local/light-theme
```

## Shrinking technical debt

Remove paths from `scripts/theme-audit-allowlist.txt` as you migrate files to theme tokens.

## Troubleshooting

### Pushing a workflow fix did not re-run the Action

Normal. This workflow triggers only on:

- **Schedule** (daily cron)
- **workflow_dispatch** (manual)

It does **not** run on `push`. After fixing YAML:

1. Go to **Actions → Daily upstream sync**
2. Click **Run workflow** (top right)
3. Branch: **`main`** (if default branch is `main`)

Do **not** use “Re-run jobs” on an old failed run — that replays the broken workflow version.

### Workflow does not appear in Actions tab

- Workflows must exist on your fork’s **default branch** (`main` unless you changed it).
- Enable Actions: Settings → Actions → General.

### Theme audit does not run on PRs

- PRs must target **`local/light-theme`**.
- `theme-audit.yml` must be on the default branch (same as above).
