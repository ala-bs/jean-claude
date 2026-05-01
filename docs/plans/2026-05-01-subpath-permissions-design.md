# Subpath Permissions for Bash Commands

## Summary

Add `{subpath}` placeholder to bash permission patterns. Allows commands like `mv`, `cp`, `rm` only when all path arguments resolve to inside the working directory (worktree or project root).

## Syntax

```json
{
  "version": 1,
  "permissions": {
    "project": {},
    "worktrees": {
      "extends": "project",
      "bash": {
        "mv {subpath}": "allow",
        "cp {subpath}": "allow",
        "rm {subpath}": "allow",
        "mkdir {subpath}": "allow",
        "cat {subpath}": "allow"
      }
    }
  }
}
```

`Bash(mv {subpath})` means: "Allow `mv` when **all path-like arguments** resolve to inside the working directory."

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Placeholder syntax | `{subpath}` in pattern | Explicit, self-documenting, opt-in per command |
| Path resolution | Single `{subpath}`, auto-resolves | Worktree path if worktree, project path otherwise |
| Argument validation | Shell-parse all args, check paths | Robust — handles variable arg counts, flags, quoting |
| Tool scope | Bash only (v1) | File tools already have picomatch path patterns |
| Resolution timing | Rule load time | Working dir set once at session start, simpler matcher |

## Implementation

### 1. Rule Resolution (`permission-settings-service.ts`)

Add `subpathRoot` field to `ResolvedPermissionRule`:

```typescript
interface ResolvedPermissionRule {
  tool: string;
  pattern: string;
  action: PermissionAction;
  subpathRoot?: string;  // set when rule had {subpath}
}
```

New function `expandSubpathPlaceholders()` runs after `flattenScope()`:

```typescript
function expandSubpathPlaceholders(
  rules: ResolvedPermissionRule[],
  workingDir: string,
): ResolvedPermissionRule[] {
  return rules.map(rule => {
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

`resolveRules()` gets new param `workingDir?: string` — called from agent service which already has it.

### 2. Subpath Matching (`evaluateSinglePermission`)

When rule has `subpathRoot`, do smart validation instead of normal glob:

```typescript
if (rule.subpathRoot && isBash) {
  if (matchPattern(rule.pattern, normalized, true) &&
      validateSubpathArgs(normalized, rule.subpathRoot)) {
    result = rule.action;
  }
}
```

### 3. Path Validation (`shared/shell-parse.ts`)

```typescript
export function validateSubpathArgs(
  command: string,
  subpathRoot: string,
): boolean {
  const parsed = shellQuote.parse(command);
  const args = parsed.slice(1).filter(
    (arg): arg is string => typeof arg === 'string'
  );

  for (const arg of args) {
    if (isFlag(arg)) continue;
    if (!looksLikePath(arg)) continue;
    const resolved = path.resolve(subpathRoot, arg);
    if (!resolved.startsWith(subpathRoot + path.sep) &&
        resolved !== subpathRoot) {
      return false;
    }
  }
  return true;
}

function isFlag(arg: string): boolean {
  return arg.startsWith('-');
}

function looksLikePath(arg: string): boolean {
  return arg.includes('/') || arg.includes('.') ||
         arg.startsWith('~') || path.isAbsolute(arg);
}
```

### 4. Claude Backend Compilation

`compileForClaude()` skips subpath rules — they're handled by our runtime evaluator in `handleToolRequest()`, not Claude's native permission model.

`buildWorktreeSettings()` same — subpath rules omitted from `.claude/settings.local.json`.

## Edge Cases

| Case | Behavior |
|------|----------|
| `mv ../escape.txt foo.txt` | ❌ Denied — resolves outside subpath |
| `mv src/a.ts src/b.ts` | ✅ Allowed — both resolve inside |
| `mv /absolute/outside/path foo` | ❌ Denied — absolute path outside |
| `mv -f src/a.ts src/b.ts` | ✅ Allowed — `-f` skipped as flag |
| `mv src/a.ts && rm /etc/passwd` | ❌ Denied — compound, `rm` fails subpath |
| `mv src/a.ts src/../../../etc/passwd` | ❌ Denied — `path.resolve()` normalizes |
| `echo hello` with `echo {subpath}` | ✅ Allowed — no path args to validate |

## Out of Scope (v1)

- Symlink resolution (needs async `fs.realpath` in sync matcher)
- Tilde expansion (`~/file` — agents use absolute paths)
- Glob args (`mv src/*.ts dest/` — shell expands before agent sees it)
- `{subpath}` for non-bash tools (file tools already have picomatch)

## Files Changed

| File | Change |
|------|--------|
| `shared/permission-types.ts` | Add `subpathRoot?` to `ResolvedPermissionRule` |
| `shared/shell-parse.ts` | Add `validateSubpathArgs()`, `isFlag()`, `looksLikePath()` |
| `electron/services/permission-settings-service.ts` | Add `expandSubpathPlaceholders()`, update `resolveRules()` signature, update `evaluateSinglePermission()`, update `compileForClaude()` |
| `electron/services/agent-service.ts` | Pass `workingDir` to `resolveRules()` |

## Test Plan

1. `validateSubpathArgs()` — relative safe, relative escape, absolute safe, absolute escape, flags skipped, empty args
2. `expandSubpathPlaceholders()` — replaces placeholder, preserves non-subpath rules, missing workingDir
3. `evaluateSinglePermission()` with subpath rules — end-to-end
4. `compileForClaude()` — subpath rules skipped
5. Compound commands with mixed subpath/non-subpath rules
