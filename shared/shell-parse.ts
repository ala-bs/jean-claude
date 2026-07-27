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

    // Preserve escapes verbatim (and whatever they escape), except line
    // continuations, which are not part of the command text.
    if (char === '\\' && !inSingleQuote && i + 1 < command.length) {
      if (command[i + 1] === '\n') {
        i += 1;
        continue;
      }
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

    // An unquoted newline separates commands just like `;` does.
    if (char === '\n') {
      out = out.trimEnd();
      if (out.length > 0 && !out.endsWith(';')) out += ';';
      continue;
    }

    // Collapse runs of unquoted whitespace to a single space.
    if (/\s/.test(char)) {
      if (out.length > 0 && !out.endsWith(' ')) out += ' ';
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

  const rawSegments = commands.length > 0 ? commands : [cleaned.trim()];
  const refined = rawSegments
    .flatMap(refineSegment)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return refined.length > 0 ? refined : rawSegments;
}

/**
 * Split a segment into top-level whitespace-separated tokens, keeping quotes.
 * Whitespace inside quotes, backticks or `$( )` does not split.
 */
function tokenizeTopLevel(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let depth = 0;

  const push = (): void => {
    if (current) tokens.push(current);
    current = '';
  };

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];

    if (char === '\\' && !inSingleQuote && i + 1 < segment.length) {
      current += char + segment[i + 1];
      i += 1;
      continue;
    }
    if (inSingleQuote) {
      current += char;
      if (char === "'") inSingleQuote = false;
      continue;
    }
    if (inBacktick) {
      current += char;
      if (char === '`') inBacktick = false;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = true;
      current += char;
      continue;
    }
    if (char === '`' && !inDoubleQuote) {
      inBacktick = true;
      current += char;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }
    // Inside double quotes whitespace never splits, so substitution depth only
    // needs tracking outside them (tracking it inside mis-nests literal parens).
    if (!inDoubleQuote && char === '$' && segment[i + 1] === '(') {
      depth += 1;
      current += '$(';
      i += 1;
      continue;
    }
    // Array literal: `files=(a b $(cmd))` stays one token.
    if (!inDoubleQuote && char === '(' && current.endsWith('=')) {
      depth += 1;
      current += char;
      continue;
    }
    if (!inDoubleQuote && depth > 0 && char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (!inDoubleQuote && depth > 0 && char === ')') {
      depth -= 1;
      current += char;
      continue;
    }
    if (!inDoubleQuote && depth === 0 && /\s/.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  push();

  return tokens;
}

/**
 * Extract the commands nested inside `$( )` / backtick substitutions of a
 * string, parsed recursively so `X=$(a && b)` yields both `a` and `b`.
 */
function extractSubstitutionCommands(value: string): string[] {
  const found: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\') {
      i += 1;
      continue;
    }
    if (value[i] === "'") {
      i += 1;
      while (i < value.length && value[i] !== "'") i += 1;
      continue;
    }
    if (value[i] === '`') {
      const start = i + 1;
      i += 1;
      while (i < value.length && value[i] !== '`') i += 1;
      found.push(value.slice(start, i));
      continue;
    }
    if (value[i] === '$' && value[i + 1] === '(') {
      const start = i + 2;
      let depth = 1;
      i += 2;
      while (i < value.length && depth > 0) {
        if (value[i] === '(') depth += 1;
        else if (value[i] === ')') depth -= 1;
        if (depth === 0) break;
        i += 1;
      }
      found.push(value.slice(start, i));
      continue;
    }
  }

  return found
    .flatMap((inner) => parseCompoundCommand(inner))
    .map((inner) => inner.trim())
    .filter((inner) => inner.length > 0);
}

/** Keywords that introduce a block header whose body is a command. */
const STRIP_LEADING_KEYWORDS = new Set([
  'if',
  'elif',
  'while',
  'until',
  'then',
  'else',
  'do',
  'done',
  'fi',
  'esac',
  'time',
  'function',
  '!',
  '{',
  '}',
  '(',
  ')',
  ';;',
]);

/** Keywords that introduce a word list, not a command (`for x in a b c`). */
const WORD_LIST_KEYWORDS = new Set(['for', 'select', 'case']);

/** Keywords that can trail a header (`while read x; do`) or close a block. */
const TRAILING_KEYWORDS = new Set([
  'do',
  'then',
  'in',
  '}',
  ')',
  ';;',
]);

/** A function definition name token, e.g. `deploy()` in `function deploy() {`. */
const FUNCTION_NAME = /^[\w.-]+\(\)$/;

/**
 * True when the token is exactly one substitution (`$(…)` or `` `…` ``) with
 * nothing before or after it, e.g. `$(id)` but not `$(id)x` or `$(a)$(b)`.
 */
function isWholeSubstitution(token: string): boolean {
  if (/^`[^`]*`$/.test(token)) return true;
  if (!token.startsWith('$(') || !token.endsWith(')')) return false;
  let depth = 0;
  for (let i = 1; i < token.length; i += 1) {
    if (token[i] === '(') depth += 1;
    else if (token[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === token.length - 1;
    }
  }
  return false;
}

const ASSIGNMENT_PREFIXES = new Set([
  'export',
  'local',
  'declare',
  'typeset',
  'readonly',
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/**
 * Reduce one raw segment to the actual commands it runs:
 * - drops shell flow-control keywords (`for`, `do`, `done`, `if`, `then`, ...)
 * - drops variable assignments (`X=1`, `export X=1`), keeping any command
 *   substitution inside their value (`X=$(git rev-parse HEAD)` -> `git rev-parse HEAD`)
 * - keeps env-prefixed commands (`NODE_ENV=test pnpm test` -> `pnpm test`)
 * - surfaces command substitutions used as arguments (`echo $(id)` -> `id`)
 */
function refineSegment(segment: string): string[] {
  let tokens = tokenizeTopLevel(segment);
  let isBlockHeader = false;

  while (tokens.length > 0) {
    const head = tokens[0];
    if (WORD_LIST_KEYWORDS.has(head)) {
      return extractSubstitutionCommands(tokens.slice(1).join(' '));
    }
    if (!STRIP_LEADING_KEYWORDS.has(head) && !FUNCTION_NAME.test(head)) break;
    isBlockHeader = true;
    tokens = tokens.slice(1);
  }

  // Only a block header can end with a keyword; for a plain command a trailing
  // `in` or `do` is a real argument (`git checkout -- in`) and must be kept.
  while (
    isBlockHeader &&
    tokens.length > 0 &&
    TRAILING_KEYWORDS.has(tokens[tokens.length - 1])
  ) {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) return [];

  let index =
    ASSIGNMENT_PREFIXES.has(tokens[0]) &&
    tokens.length > 1 &&
    ASSIGNMENT.test(tokens[1])
      ? 1
      : 0;

  const assignments: string[] = [];
  while (index < tokens.length && ASSIGNMENT.test(tokens[index])) {
    assignments.push(tokens[index]);
    index += 1;
  }

  // Assignments themselves are not commands, but anything they substitute runs.
  // Always harvest those, including for env-prefixed commands (`X=$(id) cmd`)
  // and array subscripts (`arr[$(id)]=1`), so nothing escapes evaluation.
  const substituted = assignments.flatMap((assignment) =>
    extractSubstitutionCommands(assignment),
  );

  if (assignments.length > 0) {
    tokens = tokens.slice(index);
  }

  if (tokens.length === 0) return substituted;

  // Substitutions used as arguments (`echo $(rm -rf /)`) run too, so they are
  // surfaced as their own parts instead of hiding inside the command text.
  const nested = tokens.flatMap((token) => extractSubstitutionCommands(token));

  // A segment that is nothing but a substitution unwraps to what it runs.
  if (tokens.length === 1 && isWholeSubstitution(tokens[0]) && nested.length > 0) {
    return [...substituted, ...nested];
  }

  return [...substituted, ...nested, tokens.join(' ')];
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
