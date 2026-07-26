import * as path from 'path';

import { parse as shellParse } from 'shell-quote';

/**
 * Redirection operators that take no target (fd duplication/close):
 * `2>&1`, `>&2`, `2>&-`.
 */
const FD_DUP = /\d*>&[-\d]+/y;

/**
 * Redirection operators that are followed by a target. Ordered longest-first
 * so `&>>` wins over `&>`, `<<<` over `<<`, etc.
 */
const REDIRECT_OPS = [
  /&>>/y,
  /&>/y,
  /\d*>>/y,
  /\d*>/y,
  /<<</y,
  /<</y,
  /</y,
];

/** Whitespace after a redirection operator, before its target. */
const SPACE = /\s*/y;

/**
 * Consume a redirection target starting at `index`, returning the index just
 * past it. Quoted targets (`> 'a b'`) are consumed as a whole so the closing
 * quote is never orphaned; unquoted targets stop at whitespace, at a shell
 * operator (`;`, `|`, `&`) so `>/dev/null; echo` keeps its `;`, and at `)` so
 * `$(cat >/tmp/x)` keeps its closing paren.
 */
function skipRedirectTarget(command: string, index: number): number {
  let i = index;
  const quote = command[i];
  if (quote === "'" || quote === '"') {
    i += 1;
    while (i < command.length && command[i] !== quote) {
      if (command[i] === '\\' && quote === '"') i += 1;
      i += 1;
    }
    // Consume the closing quote when present (unterminated => end of string).
    return i < command.length ? i + 1 : i;
  }
  while (i < command.length && !/[\s;|&)]/.test(command[i])) {
    if (command[i] === '\\') i += 1;
    i += 1;
  }
  return i;
}

/**
 * Strip shell output redirections (e.g. `2>&1`, `>/dev/null`) from a command
 * so that `shell-quote` can parse the remaining operators cleanly.
 *
 * Quote-aware: redirection-looking text inside single quotes, double quotes,
 * or backticks (e.g. a perl regex containing `<<<<<<<`) is left untouched.
 */
export function stripRedirections(command: string): string {
  let out = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    // Preserve escapes verbatim (and whatever they escape).
    if (char === '\\' && !inSingleQuote && i + 1 < command.length) {
      out += char + command[i + 1];
      i += 1;
      continue;
    }

    if (inSingleQuote) {
      out += char;
      if (char === "'") inSingleQuote = false;
      continue;
    }
    if (inDoubleQuote) {
      out += char;
      if (char === '"') inDoubleQuote = false;
      continue;
    }
    if (inBacktick) {
      out += char;
      if (char === '`') inBacktick = false;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      out += char;
      continue;
    }
    if (char === '`') {
      inBacktick = true;
      out += char;
      continue;
    }

    // Unquoted: try to consume a redirection starting here.
    FD_DUP.lastIndex = i;
    const dup = FD_DUP.exec(command);
    if (dup) {
      i += dup[0].length - 1;
      continue;
    }

    let matched = false;
    for (const re of REDIRECT_OPS) {
      re.lastIndex = i;
      const m = re.exec(command);
      if (!m) continue;
      SPACE.lastIndex = i + m[0].length;
      SPACE.exec(command);
      i = skipRedirectTarget(command, SPACE.lastIndex) - 1;
      matched = true;
      break;
    }
    if (matched) continue;

    // Collapse runs of unquoted whitespace to a single space.
    if (/\s/.test(char)) {
      if (!out.endsWith(' ')) out += ' ';
      continue;
    }

    out += char;
  }

  return out.trim();
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
