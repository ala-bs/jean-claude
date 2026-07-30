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
  /<<-?/y,
  /</y,
];

/** Heredoc operator: `<<` or `<<-`, but not `<<<` (herestring). */
const HEREDOC_OP = /<<-?(?!<)/y;

/**
 * Heredoc delimiter word. Bash concatenates quoted and unquoted parts, so
 * `EOF`, `'EOF'`, `"EOF"` and `E"OF"` all denote the same terminator `EOF`.
 */
const HEREDOC_DELIM = /\s*((?:"[^"]*"|'[^']*'|\\.|[^\s;|&<>()"'])+)/y;

/** Resolve a raw delimiter word to the literal text bash matches lines against. */
function unquoteDelimiter(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "'" || char === '"') {
      const end = raw.indexOf(char, i + 1);
      if (end === -1) {
        out += raw.slice(i + 1);
        return out;
      }
      out += raw.slice(i + 1, end);
      i = end;
      continue;
    }
    if (char === '\\' && i + 1 < raw.length) {
      out += raw[i + 1];
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Skip a heredoc body starting at `index` (just past a newline) until the
 * terminating delimiter line. Returns the index just past that line.
 *
 * Trailing whitespace on the terminator line is tolerated even though bash
 * would not terminate there: ending the body early only ever surfaces more
 * commands to the permission engine, which is the safe direction.
 */
function skipHeredocBody(
  command: string,
  index: number,
  delimiter: string,
  allowIndent: boolean,
): { end: number; body: string } {
  let i = index;
  while (i <= command.length) {
    const lineEnd = command.indexOf('\n', i);
    const end = lineEnd === -1 ? command.length : lineEnd;
    const line = command.slice(i, end);
    const candidate = allowIndent ? line.replace(/^\t+/, '') : line;
    if (candidate.trimEnd() === delimiter) {
      return {
        end: lineEnd === -1 ? command.length : lineEnd + 1,
        body: command.slice(index, i),
      };
    }
    if (lineEnd === -1) break;
    i = lineEnd + 1;
  }
  return { end: command.length, body: command.slice(index) };
}

/**
 * If an arithmetic expression (`$((...))` or `((...))`) starts at `index`,
 * return the index just past its closing `))`, else -1.
 *
 * Like bash, `((` is arithmetic whenever a matching `))` closes it — `;`, `|`
 * and `&` inside are arithmetic operators, not command separators, so the
 * content is never inspected. A group that closes on a lone `)` is a nested
 * subshell (`((echo hi); ls)`) and must keep flowing through normal parsing so
 * its commands stay visible to the permission engine.
 *
 * An unterminated opener consumes only the rest of its line: that keeps a
 * stray `<<` from being read as a heredoc without swallowing the commands on
 * the following lines.
 */
function arithmeticEnd(command: string, index: number): number {
  // Legacy `$[expr]` arithmetic: its `<<` is a left shift too.
  if (command[index] === '$' && command[index + 1] === '[') {
    const end = command.indexOf(']', index + 2);
    return end === -1 ? lineEnd(command, index) : end + 1;
  }
  if (command[index] !== '(' || command[index + 1] !== '(') return -1;
  let depth = 0;
  for (let i = index; i < command.length; i += 1) {
    const char = command[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        // Require the group to have closed as `))`, i.e. arithmetic.
        return command[i - 1] === ')' || command[i + 1] === ')' ? i + 1 : -1;
      }
    }
  }
  // Never closed: consume the line so a `<<` inside cannot open a heredoc.
  return lineEnd(command, index);
}

/** Index just past the end of the line containing `index`. */
function lineEnd(command: string, index: number): number {
  const nl = command.indexOf('\n', index);
  return nl === -1 ? command.length : nl;
}

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
  // A process/command substitution target (`>$(cmd)`, `< <(cmd)`) is consumed
  // whole so its inner command can still be harvested by the caller.
  if (
    (command[i] === '$' || command[i] === '<' || command[i] === '>') &&
    command[i + 1] === '('
  ) {
    let depth = 0;
    for (i += 1; i < command.length; i += 1) {
      if (command[i] === '(') depth += 1;
      else if (command[i] === ')') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return command.length;
  }
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
  return stripRedirectionsInternal(command).text;
}

/**
 * Stripped command text with the commands hidden inside heredoc bodies and
 * substitution redirect targets appended as extra `;` segments, so a caller
 * that can only pass a single string (permission matching) still sees them.
 *
 * Each appended command is sanitised first: an unbalanced quote or a trailing
 * backslash would otherwise escape the `;` and merge the next command into it.
 */
export function stripRedirectionsWithNested(command: string): string {
  const { text, harvested } = stripRedirectionsInternal(command);
  return [text, ...harvested.map(sanitizeAppended)].join('; ');
}

function sanitizeAppended(value: string): string {
  let out = value.replace(/\\+$/, '').trim();
  for (const quote of ["'", '"', '`']) {
    const count = out.split(quote).length - 1;
    if (count % 2 === 1) out = out.split(quote).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * `stripRedirections` plus the commands it found in places whose text cannot
 * safely be spliced back into the stripped string: expanded heredoc bodies and
 * substitution redirect targets. They are returned separately so a stray quote
 * or backslash in them can never corrupt the surrounding command text.
 */
function stripRedirectionsInternal(command: string): {
  text: string;
  harvested: string[];
} {
  const harvested: string[] = [];
  let out = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  /** Heredocs opened on the current line, bodies start after next newline. */
  const pendingHeredocs: {
    delimiter: string;
    allowIndent: boolean;
    expands: boolean;
  }[] = [];
  /** Depth of open `${...}` parameter expansions. */
  let braceDepth = 0;

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

    // Copy arithmetic verbatim: its `<<` is a left shift, not a heredoc.
    const arithEnd = arithmeticEnd(command, i);
    if (arithEnd !== -1) {
      out += command.slice(i, arithEnd);
      i = arithEnd - 1;
      continue;
    }

    // Track `${...}` nesting: a `#` inside one is parameter expansion syntax
    // (`${x// #/}`), never a comment.
    if (char === '$' && command[i + 1] === '{') {
      braceDepth += 1;
      out += '${';
      i += 1;
      continue;
    }
    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1;
      out += char;
      continue;
    }

    // A `#` starting a word begins a comment: drop it (its `<<` is not a
    // heredoc) but leave the newline so it still separates commands.
    if (
      char === '#' &&
      braceDepth === 0 &&
      (out.length === 0 || /[\s;|&(]$/.test(out))
    ) {
      const lineEnd = command.indexOf('\n', i);
      i = (lineEnd === -1 ? command.length : lineEnd) - 1;
      continue;
    }

    // Process substitution used as an argument (`diff <(ls a) <(ls b)`): keep
    // it verbatim so its inner commands stay visible.
    if ((char === '<' || char === '>') && command[i + 1] === '(') {
      const end = skipRedirectTarget(command, i);
      out += command.slice(i, end);
      i = end - 1;
      continue;
    }

    // Heredoc: strip `<<DELIM` and remember to skip its body at next newline.
    HEREDOC_OP.lastIndex = i;
    const heredoc = HEREDOC_OP.exec(command);
    if (heredoc) {
      HEREDOC_DELIM.lastIndex = i + heredoc[0].length;
      const delim = HEREDOC_DELIM.exec(command);
      if (delim) {
        const delimiter = unquoteDelimiter(delim[1]);
        pendingHeredocs.push({
          delimiter,
          allowIndent: heredoc[0].endsWith('-'),
          // An unquoted delimiter (`<<EOF`) leaves the body expanded, so any
          // `$( )` or backticks in it really execute.
          expands: !/['"\\]/.test(delim[1]),
        });
        i = HEREDOC_DELIM.lastIndex - 1;
        continue;
      }
    }

    let matched = false;
    for (const re of REDIRECT_OPS) {
      re.lastIndex = i;
      const m = re.exec(command);
      if (!m) continue;
      SPACE.lastIndex = i + m[0].length;
      SPACE.exec(command);
      const targetEnd = skipRedirectTarget(command, SPACE.lastIndex);
      // A substitution target (`>$(cmd)`) runs its inner command: harvest it.
      const target = command.slice(SPACE.lastIndex, targetEnd);
      if (/[$<>]\(|`/.test(target)) {
        harvested.push(...extractSubstitutionCommands(target));
      }
      i = targetEnd - 1;
      matched = true;
      break;
    }
    if (matched) continue;

    // An unquoted newline separates commands just like `;` does.
    if (char === '\n') {
      // Heredoc bodies opened on this line are data, not commands: skip them,
      // but keep any substitution the shell will expand inside them.
      while (pendingHeredocs.length > 0) {
        const doc = pendingHeredocs.shift();
        if (!doc) break;
        const { end, body } = skipHeredocBody(
          command,
          i + 1,
          doc.delimiter,
          doc.allowIndent,
        );
        i = end - 1;
        if (doc.expands) {
          harvested.push(...extractSubstitutionCommands(body, { prose: true }));
        }
      }
      out = out.trimEnd();
      // An escaped `\;` (e.g. `find -exec ... \;`) is an argument, not a
      // separator, so it still needs one appended.
      const endsWithSeparator =
        out.endsWith(';') && !isEscaped(out, out.length - 1);
      if (out.length > 0 && !endsWithSeparator) out += ';';
      continue;
    }

    // Collapse runs of unquoted whitespace to a single space.
    if (/\s/.test(char)) {
      if (out.length > 0 && !out.endsWith(' ')) out += ' ';
      continue;
    }

    out += char;
  }

  return { text: out.trim(), harvested };
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
  const { text: cleaned, harvested } = stripRedirectionsInternal(command);
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

    // `$( )` command substitutions and `<( )` / `>( )` process substitutions
    // keep their inner operators out of the top-level split.
    if (
      (char === '$' || char === '<' || char === '>') &&
      nextChar === '(' &&
      !inSingleQuote &&
      !inBacktick
    ) {
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

  const parsed = refined.length > 0 ? refined : rawSegments;
  // Harvested commands come last so the outer command stays first for display
  // and rule attribution.
  return [...parsed, ...harvested].filter((part) => part.trim().length > 0);
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
    // `$( )` command substitutions and `<( )` / `>( )` process substitutions
    // stay one token, whitespace inside included.
    if (
      !inDoubleQuote &&
      (char === '$' || char === '<' || char === '>') &&
      segment[i + 1] === '('
    ) {
      depth += 1;
      current += char + '(';
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
 * Extract the commands nested inside `$( )`, `<( )`, `>( )` and backtick
 * substitutions of a string, parsed recursively so `X=$(a && b)` yields both
 * `a` and `b`.
 */
function extractSubstitutionCommands(
  value: string,
  options?: { prose: boolean },
): string[] {
  const found: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\') {
      i += 1;
      continue;
    }
    // Heredoc bodies are prose, not shell: an apostrophe in `it's` opens no
    // quote there, so honouring it would hide every later substitution.
    if (value[i] === "'" && !options?.prose) {
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
    if (
      (value[i] === '$' || value[i] === '<' || value[i] === '>') &&
      value[i + 1] === '('
    ) {
      // Never skip `$((...))` here: command substitutions inside arithmetic
      // (`$(( $(id) ))`) really do execute, so their commands must surface.
      // `<( )` / `>( )` are process substitutions and execute too.
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
