import * as path from 'path';

import { parse as shellParse } from 'shell-quote';

/**
 * Strip shell output redirections (e.g. `2>&1`, `>/dev/null`) from a command
 * so that `shell-quote` can parse the remaining operators cleanly.
 *
 * The target-file portion uses `[^\s;|&]+` instead of `\S+` so that shell
 * operators (`;`, `|`, `&&`, `||`) adjacent to the target are preserved.
 */
export function stripRedirections(command: string): string {
  // Match a redirection target: one or more chars that are NOT whitespace,
  // semicolons, pipes, or ampersands.  This ensures operators like `;` and
  // `&&` that follow a target (e.g. `>/dev/null; echo`) are not consumed.
  const T = '[^\\s;|&]+';

  return command
    .replace(/\d*>&\d+/g, '') // 2>&1, >&2
    .replace(new RegExp(`&>>\\s*${T}`, 'g'), '') // &>>/dev/null
    .replace(new RegExp(`&>\\s*${T}`, 'g'), '') // &>/dev/null
    .replace(new RegExp(`\\d*>>\\s*${T}`, 'g'), '') // 2>>/tmp/err, >>file
    .replace(new RegExp(`\\d*>\\s*${T}`, 'g'), '') // 2>/dev/null, >/dev/null
    .replace(new RegExp(`<<<\\s*${T}`, 'g'), '') // <<<string
    .replace(new RegExp(`<<\\s*${T}`, 'g'), '') // <<EOF
    .replace(new RegExp(`<\\s*${T}`, 'g'), '') // <input
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

function isEscaped(command: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && command[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/**
 * Parse compound shell command into top-level sub-commands.
 *
 * Splits only on top-level `&&`, `||`, `;`, and `|` operators. Operators
 * inside quotes, backticks, or command substitutions like `$(...)` stay part
 * of current command so exact permission patterns still match original text.
 */
export function parseCompoundCommand(command: string): string[] {
  const cleaned = stripRedirections(command);
  const commands: string[] = [];
  let segmentStart = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let commandSubstitutionDepth = 0;

  const pushSegment = (end: number): void => {
    const segment = cleaned.slice(segmentStart, end).trim();
    if (segment) {
      commands.push(segment);
    }
  };

  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    const nextChar = cleaned[i + 1];

    if (char === '\\' && !isEscaped(cleaned, i)) {
      i += 1;
      continue;
    }

    if (inSingleQuote) {
      if (char === "'" && !isEscaped(cleaned, i)) {
        inSingleQuote = false;
      }
      continue;
    }

    if (inBacktick) {
      if (char === '`' && !isEscaped(cleaned, i)) {
        inBacktick = false;
      }
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = true;
      continue;
    }

    if (char === '`' && !inSingleQuote) {
      inBacktick = true;
      continue;
    }

    if (char === '"' && !isEscaped(cleaned, i)) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === '$' && nextChar === '(' && !inSingleQuote && !inBacktick) {
      commandSubstitutionDepth += 1;
      i += 1;
      continue;
    }

    if (
      char === '(' &&
      commandSubstitutionDepth > 0 &&
      !inSingleQuote &&
      !inBacktick
    ) {
      commandSubstitutionDepth += 1;
      continue;
    }

    if (
      char === ')' &&
      commandSubstitutionDepth > 0 &&
      !inSingleQuote &&
      !inBacktick
    ) {
      commandSubstitutionDepth -= 1;
      continue;
    }

    if (
      !inDoubleQuote &&
      !inSingleQuote &&
      !inBacktick &&
      commandSubstitutionDepth === 0
    ) {
      const isDoubleOperator =
        (char === '&' && nextChar === '&') ||
        (char === '|' && nextChar === '|');

      if (isDoubleOperator) {
        pushSegment(i);
        segmentStart = i + 2;
        i += 1;
        continue;
      }

      if (char === ';' || char === '|') {
        pushSegment(i);
        segmentStart = i + 1;
      }
    }
  }

  pushSegment(cleaned.length);

  return commands.length > 0 ? commands : [cleaned.trim()];
}

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
  return (
    arg.includes('/') ||
    arg.includes('.') ||
    arg.startsWith('~') ||
    path.isAbsolute(arg)
  );
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
  let parsed: ReturnType<typeof shellParse>;
  try {
    parsed = shellParse(command);
  } catch {
    // Fail-closed: if we can't parse the command, deny it
    return false;
  }

  // Skip first token (command name), keep only string tokens
  const args = parsed
    .slice(1)
    .filter((arg): arg is string => typeof arg === 'string');

  // Normalize subpathRoot to remove any trailing separator
  const normalizedRoot = subpathRoot.endsWith(path.sep)
    ? subpathRoot.slice(0, -1)
    : subpathRoot;

  for (const arg of args) {
    if (isFlag(arg)) continue;
    if (!looksLikePath(arg)) continue;

    const resolved = path.resolve(normalizedRoot, arg);
    if (
      resolved !== normalizedRoot &&
      !resolved.startsWith(normalizedRoot + path.sep)
    ) {
      return false;
    }
  }

  return true;
}
