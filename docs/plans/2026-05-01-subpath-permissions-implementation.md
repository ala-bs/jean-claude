# Subpath Permissions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `{subpath}` placeholder to bash permission patterns so commands like `mv`, `cp`, `rm` are auto-allowed only when all path arguments resolve inside the working directory.

**Architecture:** At rule load time, `{subpath}` patterns are expanded: the placeholder is replaced with the resolved working directory path and the rule is tagged with `subpathRoot`. At match time, tagged rules shell-parse the command, resolve each path-like argument, and verify all paths fall inside `subpathRoot`. Rules with `subpathRoot` are skipped during Claude backend compilation since our runtime evaluator handles them.

**Tech Stack:** TypeScript, `shell-quote` (already in use), `path` (Node built-in)

---

### Task 1: Add `subpathRoot` to `ResolvedPermissionRule`

**Files:**
- Modify: `shared/permission-types.ts:57-61`

**Step 1: Add optional `subpathRoot` field**

In `shared/permission-types.ts`, update the `ResolvedPermissionRule` interface:

```typescript
export interface ResolvedPermissionRule {
  tool: string;
  pattern: string; // '*' for scalar rules, glob pattern for pattern-map rules
  action: PermissionAction;
  /** When set, this rule uses subpath validation instead of glob matching.
   *  The value is the resolved working directory (worktree or project root). */
  subpathRoot?: string;
}
```

**Step 2: Commit**

```bash
git add shared/permission-types.ts
git commit -m "feat(permissions): add subpathRoot field to ResolvedPermissionRule"
```

---

### Task 2: Add `validateSubpathArgs` to `shell-parse.ts`

**Files:**
- Modify: `shared/shell-parse.ts`

**Step 1: Add path validation helpers at bottom of file**

Add imports and three new functions to `shared/shell-parse.ts`:

```typescript
import * as path from 'path';

/**
 * Check if an argument looks like a CLI flag (starts with `-`).
 */
export function isFlag(arg: string): boolean {
  return arg.startsWith('-');
}

/**
 * Check if an argument looks like a file path.
 * Matches: relative paths (src/foo), dotfiles (.gitignore), absolute paths (/usr/bin),
 * tilde paths (~/.config).
 * Does NOT match: bare words without path separators or dots (e.g. "hello").
 */
export function looksLikePath(arg: string): boolean {
  return arg.includes('/') || arg.includes('.') || arg.startsWith('~') || path.isAbsolute(arg);
}

/**
 * Validate that all path-like arguments in a bash command resolve inside a root directory.
 *
 * Parses the command with `shell-quote`, skips the command name (first token) and flags,
 * then resolves each remaining path-like argument against `subpathRoot`. If any resolved
 * path falls outside `subpathRoot`, returns `false`.
 *
 * @param command - The full bash command string (e.g., "mv src/a.ts src/b.ts")
 * @param subpathRoot - The root directory that all paths must resolve within
 * @returns `true` if all path-like arguments are inside subpathRoot, `false` otherwise
 */
export function validateSubpathArgs(
  command: string,
  subpathRoot: string,
): boolean {
  const parsed = shellParse(command);
  // Skip first token (command name), keep only string tokens
  const args = parsed.slice(1).filter(
    (arg): arg is string => typeof arg === 'string',
  );

  // Normalize subpathRoot to remove any trailing separator
  const normalizedRoot = subpathRoot.endsWith(path.sep)
    ? subpathRoot.slice(0, -1)
    : subpathRoot;

  for (const arg of args) {
    if (isFlag(arg)) continue;
    if (!looksLikePath(arg)) continue;

    const resolved = path.resolve(normalizedRoot, arg);
    if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
      return false;
    }
  }

  return true;
}
```

Note: `shellParse` is already imported at the top of the file as `import { parse as shellParse } from 'shell-quote';`. Add `import * as path from 'path';` alongside it.

**Step 2: Commit**

```bash
git add shared/shell-parse.ts
git commit -m "feat(permissions): add validateSubpathArgs for subpath permission checking"
```

---

### Task 3: Add `expandSubpathPlaceholders` and update `resolveRules`

**Files:**
- Modify: `electron/services/permission-settings-service.ts`

**Step 1: Add `expandSubpathPlaceholders` function**

Add this function after the `resolveRules` function (after line ~291):

```typescript
/**
 * Expand `{subpath}` placeholders in bash permission patterns.
 *
 * When a bash rule pattern contains `{subpath}`, it is replaced with
 * a glob pattern matching the command prefix + any args (`prefix *`),
 * and the rule is tagged with `subpathRoot` for smart path validation
 * during matching.
 *
 * @param rules - Flattened permission rules
 * @param workingDir - The resolved working directory (worktree or project root)
 * @returns Rules with `{subpath}` expanded and tagged
 */
function expandSubpathPlaceholders(
  rules: ResolvedPermissionRule[],
  workingDir: string,
): ResolvedPermissionRule[] {
  return rules.map((rule) => {
    if (rule.tool !== 'bash' || !rule.pattern.includes('{subpath}')) {
      return rule;
    }
    const prefix = rule.pattern.replace('{subpath}', '').trim();
    return {
      ...rule,
      pattern: prefix ? `${prefix} *` : '*',
      subpathRoot: workingDir,
    };
  });
}
```

**Step 2: Update `resolveRules` signature to accept `workingDir`**

Change the `resolveRules` function signature and add expansion call before return statements. Current signature (line ~269):

```typescript
export function resolveRules(
  settings: JeanClaudeSettings,
  isWorktree: boolean,
  globalRules?: ResolvedPermissionRule[],
): ResolvedPermissionRule[] {
```

New signature:

```typescript
export function resolveRules(
  settings: JeanClaudeSettings,
  isWorktree: boolean,
  globalRules?: ResolvedPermissionRule[],
  workingDir?: string,
): ResolvedPermissionRule[] {
```

Then update the two return points in `resolveRules`:

Return 1 (line ~278, when not worktree):
```typescript
  if (!isWorktree || !settings.permissions.worktrees) {
    return workingDir
      ? expandSubpathPlaceholders(baseRules, workingDir)
      : baseRules;
  }
```

Return 2 (line ~285, extends project):
```typescript
  if (worktreeScope.extends === 'project') {
    const merged = [...baseRules, ...worktreeRules];
    return workingDir
      ? expandSubpathPlaceholders(merged, workingDir)
      : merged;
  }

  // No extends — worktree rules only (but still include global)
  const noExtend = [...(globalRules ?? []), ...worktreeRules];
  return workingDir
    ? expandSubpathPlaceholders(noExtend, workingDir)
    : noExtend;
```

**Step 3: Commit**

```bash
git add electron/services/permission-settings-service.ts
git commit -m "feat(permissions): expand {subpath} placeholders at rule load time"
```

---

### Task 4: Update `evaluateSinglePermission` for subpath rules

**Files:**
- Modify: `electron/services/permission-settings-service.ts`

**Step 1: Add import for `validateSubpathArgs`**

Update the import from `@shared/shell-parse` at the top of the file (line ~7):

```typescript
import { parseCompoundCommand, stripRedirections, validateSubpathArgs } from '@shared/shell-parse';
```

**Step 2: Update `evaluateSinglePermission` function**

Replace the matching logic inside the `for` loop in `evaluateSinglePermission` (lines ~379-384):

Current code:
```typescript
  for (const rule of rules) {
    if (rule.tool !== toolKey && rule.tool !== '*') continue;
    if (matchPattern(rule.pattern, normalized, isBash)) {
      result = rule.action;
    }
  }
```

New code:
```typescript
  for (const rule of rules) {
    if (rule.tool !== toolKey && rule.tool !== '*') continue;

    if (rule.subpathRoot && isBash) {
      // Subpath rule: first-pass glob on command name, then validate all path args
      if (
        matchPattern(rule.pattern, normalized, true) &&
        validateSubpathArgs(normalized, rule.subpathRoot)
      ) {
        result = rule.action;
      }
    } else if (matchPattern(rule.pattern, normalized, isBash)) {
      result = rule.action;
    }
  }
```

**Step 3: Commit**

```bash
git add electron/services/permission-settings-service.ts
git commit -m "feat(permissions): evaluate subpath rules with path validation"
```

---

### Task 5: Update `compileForClaude` to skip subpath rules

**Files:**
- Modify: `electron/services/permission-settings-service.ts`

**Step 1: Add skip condition at top of the for-loop**

In `compileForClaude` function (line ~818), add a skip for subpath rules right after the existing `if (rule.tool === '*') continue;` line:

```typescript
  for (const rule of rules) {
    if (rule.tool === '*') continue; // Claude doesn't support wildcard tool
    if (rule.subpathRoot) continue;  // Subpath rules handled by runtime evaluator
    const claudeName = toolNameMap[rule.tool] ?? rule.tool;
```

**Step 2: Commit**

```bash
git add electron/services/permission-settings-service.ts
git commit -m "feat(permissions): skip subpath rules in Claude backend compilation"
```

---

### Task 6: Pass `workingDir` to `resolveRules` from callers

**Files:**
- Modify: `electron/services/agent-service.ts:462-465`
- Modify: `electron/services/permission-settings-service.ts` (two callers)

**Step 1: Update `agent-service.ts`**

Find the `resolveRules` call in `agent-service.ts` (around line 465). Current code:

```typescript
    const rules = resolveRules(settings, isWorktree, globalRules);
```

New code:

```typescript
    const rules = resolveRules(settings, isWorktree, globalRules, workingDir);
```

`workingDir` is already defined on line 421 as `let workingDir = task.worktreePath ?? project.path;`.

**Step 2: Update `evaluateToolPermission` in `permission-settings-service.ts`**

Find the `evaluateToolPermission` function (around line 920). Add `workingDir` param and pass it through:

Current signature:
```typescript
export async function evaluateToolPermission({
  projectPath,
  isWorktree,
  toolName,
  input,
}: {
  projectPath: string;
  isWorktree: boolean;
  toolName: string;
  input: Record<string, unknown>;
}): Promise<PermissionEvalResult> {
```

New signature:
```typescript
export async function evaluateToolPermission({
  projectPath,
  isWorktree,
  toolName,
  input,
  workingDir,
}: {
  projectPath: string;
  isWorktree: boolean;
  toolName: string;
  input: Record<string, unknown>;
  workingDir?: string;
}): Promise<PermissionEvalResult> {
```

And update the `resolveRules` call inside it:

```typescript
  const rules = resolveRules(settings, isWorktree, globalRules, workingDir);
```

**Step 3: Update `buildWorktreeSettings` in `permission-settings-service.ts`**

Find `buildWorktreeSettings` (around line 877). Current `resolveRules` call:

```typescript
  const rules = resolveRules(settings, true, globalRules);
```

New:

```typescript
  const rules = resolveRules(settings, true, globalRules, destPath);
```

**Step 4: Commit**

```bash
git add electron/services/agent-service.ts electron/services/permission-settings-service.ts
git commit -m "feat(permissions): wire workingDir through resolveRules callers"
```

---

### Task 7: Lint, type-check, and verify

**Step 1: Install dependencies**

```bash
pnpm install
```

**Step 2: Auto-fix lint issues**

```bash
pnpm lint --fix
```

**Step 3: Type check**

```bash
pnpm ts-check
```

Expected: no errors.

**Step 4: Fix any issues found**

If `ts-check` or `lint` report errors, fix them. Common things to watch for:
- Missing `path` import in `shell-parse.ts` (Node built-in, should work since it's already used in the project)
- Any callers of `evaluateToolPermission` that need the new `workingDir` param (it's optional so should be backward compatible)

**Step 5: Commit if there were fixes**

```bash
git add -A
git commit -m "fix: resolve lint and type-check issues for subpath permissions"
```

---

### Task 8: Final commit with all changes

**Step 1: Run full verification**

```bash
pnpm install && pnpm lint --fix && pnpm ts-check && pnpm lint
```

Expected: clean output, no errors.

**Step 2: Review changes**

```bash
git diff main --stat
```

Expected files changed:
- `shared/permission-types.ts` — added `subpathRoot?` field
- `shared/shell-parse.ts` — added `validateSubpathArgs`, `isFlag`, `looksLikePath`, `path` import
- `electron/services/permission-settings-service.ts` — added `expandSubpathPlaceholders`, updated `resolveRules`, `evaluateSinglePermission`, `compileForClaude`, `evaluateToolPermission`, `buildWorktreeSettings`
- `electron/services/agent-service.ts` — passed `workingDir` to `resolveRules`
- `docs/plans/` — design + implementation docs
