import picomatch from 'picomatch';
import type { AutoReviewRule } from '@shared/types';

/**
 * `dot: true` so patterns like `**\/*.json` still match files under dot
 * directories (`.github/`, `.vscode/`), which is almost always what someone
 * means when they write a rule to skip config noise.
 */
const PICOMATCH_OPTIONS: picomatch.PicomatchOptions = { dot: true };

/**
 * Compiled matchers are cached by pattern because the file tree re-derives
 * matches on every diff render; recompiling a glob per file per render is the
 * one part of this that could actually show up in a profile.
 */
const matcherCache = new Map<string, (path: string) => boolean>();

function matcherFor(pattern: string) {
  const cached = matcherCache.get(pattern);
  if (cached) return cached;
  let matcher: (path: string) => boolean;
  try {
    matcher = picomatch(pattern, PICOMATCH_OPTIONS);
  } catch {
    // A half-typed glob in the settings field must not break the diff view.
    matcher = () => false;
  }
  matcherCache.set(pattern, matcher);
  return matcher;
}

/**
 * Diff paths arrive in two conventions: worktree diffs are repo-relative
 * ("src/a.ts") while pull request diffs are repo-absolute ("/src/a.ts") — see
 * the same split in `buildTree` in ui-file-diff/file-tree.tsx. Matching the raw
 * path would make any rule not starting with `**` silently dead on PRs only
 * (`src/**` never matches `/src/a.ts`), so normalize before matching.
 */
function normalizePath(path: string) {
  return path.startsWith('/') ? path.slice(1) : path;
}

/**
 * Maps each path to the first enabled rule that matches it. First match wins so
 * rule order in settings is a meaningful priority, letting a narrow rule shadow
 * a broad one placed after it.
 */
export function matchAutoReviewRules({
  paths,
  rules,
}: {
  paths: Iterable<string>;
  rules: AutoReviewRule[];
}): Map<string, AutoReviewRule> {
  const matched = new Map<string, AutoReviewRule>();
  const active = rules.filter((rule) => rule.enabled && rule.pattern.trim());
  if (active.length === 0) return matched;

  const compiled = active.map((rule) => ({
    rule,
    isMatch: matcherFor(rule.pattern),
  }));

  for (const path of paths) {
    const candidate = normalizePath(path);
    const hit = compiled.find(({ isMatch }) => isMatch(candidate));
    // Keyed by the original path, since that is what the tree renders with.
    if (hit) matched.set(path, hit.rule);
  }
  return matched;
}
