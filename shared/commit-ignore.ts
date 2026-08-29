import ignore, { type Ignore } from 'ignore';

/**
 * Commit-ignore rules (`.jean-claude/ignore`) decide which changed files are
 * left out of staging at commit time.
 *
 * Both the main process (which enforces the rules) and the renderer (which dims
 * the matching rows) build their matcher here, so the two can never disagree
 * about what a rule means. Any parsing nuance — leading whitespace, negation,
 * comments — belongs in this file only.
 */

/** Builds a matcher, or null when the file has no effective rules. */
export function createCommitIgnoreMatcher(content: string): Ignore | null {
  if (!content.trim()) return null;
  // Added as one raw string, exactly like a .gitignore. Do NOT pre-trim lines:
  // `ignore` treats leading whitespace as significant, so trimming would make
  // an indented rule match here and not in git.
  return ignore().add(content);
}

/**
 * Safe match. `ignore` throws on absolute or empty paths, and callers feed this
 * whatever git or a diff happened to produce.
 */
export function matchesCommitIgnore(
  matcher: Ignore | null,
  filePath: string,
): boolean {
  if (!matcher || !filePath || filePath.startsWith('/')) return false;
  try {
    return matcher.ignores(filePath);
  } catch {
    return false;
  }
}

/**
 * Every path that decides a file's ignored state. A rename is ignored when
 * either end matches, mirroring the `R` handling in `getIgnoredCommitPaths`.
 */
export function commitIgnoreMatchPaths({
  path,
  originalPath,
}: {
  path: string;
  originalPath?: string;
}): string[] {
  return originalPath && originalPath !== path ? [path, originalPath] : [path];
}

function splitLines(content: string): string[] {
  return content.split('\n');
}

/** Appends literal rules, skipping ones already present verbatim. */
export function addCommitIgnoreEntries(
  content: string,
  paths: string[],
): string {
  const lines = splitLines(content);
  const existing = new Set(lines.map((line) => line.trim()));
  const additions = paths.filter((path) => !existing.has(path));
  if (additions.length === 0) return content;
  // Drop a single trailing blank so repeated appends don't accumulate gaps.
  const base =
    lines.length > 0 && lines[lines.length - 1].trim() === ''
      ? lines.slice(0, -1)
      : lines;
  return [...base, ...additions].join('\n');
}

/** Removes literal rules equal to any of the paths. Globs are left alone. */
export function removeCommitIgnoreEntries(
  content: string,
  paths: string[],
): string {
  const removals = new Set(paths);
  const lines = splitLines(content);
  const next = lines.filter((line) => !removals.has(line.trim()));
  return next.length === lines.length ? content : next.join('\n');
}

/**
 * Whether removing the literal lines for these paths would actually un-ignore
 * them.
 *
 * This has to be answered by re-evaluating the prospective file rather than by
 * looking for a literal line: a path can be covered by both `*.log` and its own
 * `debug.log` entry, in which case dropping the literal changes nothing and the
 * menu must not offer an action that silently does nothing.
 */
export function canUnignoreCommitPaths(
  content: string,
  paths: string[],
): boolean {
  const nextMatcher = createCommitIgnoreMatcher(
    removeCommitIgnoreEntries(content, paths),
  );
  return paths.every((path) => !matchesCommitIgnore(nextMatcher, path));
}
