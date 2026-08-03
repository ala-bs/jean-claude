/**
 * Static detection of "script edits": bash commands whose only effect is
 * reading/rewriting files with a small interpreter snippet, e.g.
 *
 *   python3 - <<'EOF'
 *   p = 'src/foo.ts'
 *   s = open(p).read()
 *   open(p, 'w').write(s.replace('a', 'b'))
 *   EOF
 *
 * Agents reach for this instead of the Edit tool. Rather than reclassifying
 * such commands as `edit`, we keep them as bash and let the user opt into
 * auto-allowing them — but ONLY when every file touched is statically known
 * and the snippet is provably nothing but that file I/O.
 *
 * SECURITY MODEL — read this before touching anything below.
 *
 * The snippet is matched against a CLOSED GRAMMAR: a short list of statement
 * and expression forms. Anything the grammar does not recognise is rejected,
 * so the answer to "what else could this snippet do?" is bounded by what is
 * written here, not by a blocklist of known-bad names. A blocklist over
 * unparsed text cannot work — `z = 0; import posix`, `w = open`, `p += '..'`
 * and `fs.cpSync` all slip past one trivially.
 *
 * Consequences, kept deliberately:
 *  - no blocks (`if`/`for`/`while`/`def`), no `;`, no line continuations
 *  - rebinding only string  string (read-modify-write); never a module/handle
 *  - no aliasing of `open`/`fs`: they are keywords of the grammar
 *  - only literal or literal-bound paths
 *
 * The caller must still resolve the returned paths against the working
 * directory (including symlinks) and check them against permission rules.
 */

/**
 * Pseudo-tool key for the "auto-allow script edits" toggle. Stored like any
 * other permission rule (`"script_edit": "allow"`) so it inherits the
 * global  project  worktrees merge, but evaluated by our runtime only —
 * it is never compiled into backend settings.
 */
export const SCRIPT_EDIT_TOOL = 'script_edit';

export type ScriptEditKind = 'python' | 'node' | 'sed';

export type ScriptEditAnalysis =
  | {
      ok: true;
      kind: ScriptEditKind;
      /** Paths opened for reading, exactly as written in the script. */
      reads: string[];
      /** Paths opened for writing, exactly as written in the script. */
      writes: string[];
    }
  | { ok: false; reason: string };

const fail = (reason: string): ScriptEditAnalysis => ({ ok: false, reason });

/**
 * A path is only "statically known" if the shell will hand it to the
 * interpreter unchanged. Anything the shell rewrites first — variable and
 * tilde expansion, globs — resolves to something else at run time while the
 * text we checked looked perfectly contained (`$HOME/.ssh/authorized_keys`
 * resolves under the working dir as a literal, and `sed -i s/a/b/ *` edits
 * every file in it).
 */
function unsafePathReason(target: string): string | null {
  if (!target) return 'empty path';
  // Allowlist, not blocklist: one missing metacharacter is a full escape.
  // `{x,../../etc/hosts}` used to pass as a single contained path \u2014 brace
  // expansion turns it into two words long before the interpreter runs.
  if (!/^[\w./@+,: -]+$/.test(target)) {
    return `path is not a plain literal: ${target}`;
  }
  if (/(^|\/)~/.test(target)) return `tilde expansion in path: ${target}`;
  // A leading `-` is an option, not a file: `sed ... -f/tmp/evil.sed`. This
  // covers any segment, because creating `./-e` is what lets a later command
  // pass `-e` off as an existing file.
  if (/(^|\/)-/.test(target)) return `path looks like an option: ${target}`;
  if (target.includes('..')) return `path traversal: ${target}`;
  return null;
}

/** Final gate: every reported path must be literal, or the report is a lie. */
function finish(
  kind: ScriptEditKind,
  reads: string[],
  writes: string[],
): ScriptEditAnalysis {
  for (const target of [...reads, ...writes]) {
    const reason = unsafePathReason(target);
    if (reason) return fail(reason);
  }
  if (reads.length === 0 && writes.length === 0) {
    return fail('snippet touches no statically known file');
  }
  return { ok: true, kind, reads, writes };
}

// ---------------------------------------------------------------------------
// Shell-level guards
// ---------------------------------------------------------------------------

/**
 * Shell metacharacters that would let the command do more than run the
 * snippet (command substitution, chaining, extra redirections).
 * `<<` is allowed once, as the heredoc that carries the snippet.
 */
function checkShellShape(head: string): string | null {
  if (/\$\(|`|\$\{|\$'/.test(head)) return 'shell expansion in command';
  if (/&&|\|\||;|\||&/.test(head)) return 'compound command';
  if (/>|(?<!<)<(?!<)/.test(head)) return 'redirection in command';
  if (/\\\s*$/.test(head)) return 'line continuation';
  if (/\n/.test(head.trim())) return 'multiple command lines';
  return null;
}

type Heredoc = { head: string; body: string };

/**
 * Split `cmd <<'EOF' \n body \n EOF` into head + body.
 * The delimiter MUST be quoted: an unquoted delimiter lets the shell expand
 * `$(...)` inside the body before the interpreter ever sees it.
 */
function splitHeredoc(command: string): Heredoc | { error: string } | null {
  const opener = /<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\n/.exec(command);
  if (!opener) {
    if (/<<-?\s*[A-Za-z_]/.test(command)) {
      return { error: 'unquoted heredoc delimiter' };
    }
    return null;
  }

  const head = command.slice(0, opener.index);
  const rest = command.slice(opener.index + opener[0].length);
  const delim = opener[2];
  const closer = new RegExp(`^[ \\t]*${delim}[ \\t]*$`, 'm').exec(rest);
  if (!closer) return { error: 'unterminated heredoc' };

  const body = rest.slice(0, closer.index);
  const trailing = rest.slice(closer.index + closer[0].length).trim();
  if (trailing) return { error: 'commands after heredoc' };

  return { head, body };
}

// ---------------------------------------------------------------------------
// Tiny recursive-descent parser shared by the python and node grammars
// ---------------------------------------------------------------------------

class ParseError extends Error {}

/** A parsed value: `text` is its static string value when fully known. */
type Value = { text: string | null };

const UNKNOWN: Value = { text: null };

type Binding = { kind: 'string'; value: string | null } | { kind: 'fs' };

type Grammar = {
  language: 'python' | 'node';
  /** Postfix methods callable on a string value: name  arity. */
  methods: Record<string, number>;
};

const PYTHON_GRAMMAR: Grammar = {
  language: 'python',
  methods: {
    replace: 2,
    strip: 0,
    lstrip: 0,
    rstrip: 0,
    upper: 0,
    lower: 0,
  },
};

const NODE_GRAMMAR: Grammar = {
  language: 'node',
  methods: {
    replace: 2,
    replaceAll: 2,
    trim: 0,
    trimStart: 0,
    trimEnd: 0,
    toUpperCase: 0,
    toLowerCase: 0,
    toString: 0,
  },
};

class Parser {
  private index = 0;

  readonly reads: string[] = [];
  readonly writes: string[] = [];
  private readonly bindings = new Map<string, Binding>();

  constructor(
    private source: string,
    private readonly grammar: Grammar,
  ) {}

  // -- primitives ----------------------------------------------------------

  private get rest(): string {
    return this.source.slice(this.index);
  }

  private skipSpace(): void {
    while (/[ \t]/.test(this.source[this.index] ?? '')) this.index += 1;
  }

  private eat(token: string): boolean {
    this.skipSpace();
    if (this.source.startsWith(token, this.index)) {
      this.index += token.length;
      return true;
    }
    return false;
  }

  private expect(token: string): void {
    if (!this.eat(token)) this.reject(`expected \`${token}\``);
  }

  private atEnd(): boolean {
    this.skipSpace();
    return this.index >= this.source.length;
  }

  private reject(what: string): never {
    throw new ParseError(`${what} near "${this.rest.slice(0, 24)}"`);
  }

  /** Identifier, or null if the cursor is not on one. */
  private tryName(): string | null {
    this.skipSpace();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.rest);
    if (!match) return null;
    this.index += match[0].length;
    return match[0];
  }

  /**
   * A single-line string literal. Only simple escapes are honoured; prefixes
   * (f-strings, raw strings, byte strings) and template literals are not part
   * of the grammar because their value is not statically obvious.
   */
  private tryString(): string | null {
    this.skipSpace();
    const quote = this.source[this.index];
    if (quote !== "'" && quote !== '"') return null;
    let index = this.index + 1;
    let value = '';
    while (index < this.source.length) {
      const char = this.source[index];
      if (char === '\n') break;
      if (char === '\\') {
        const escaped = this.source[index + 1];
        const simple: Record<string, string> = {
          n: '\n',
          t: '\t',
          '\\': '\\',
          "'": "'",
          '"': '"',
        };
        if (!(escaped in simple)) this.reject('unsupported string escape');
        value += simple[escaped];
        index += 2;
        continue;
      }
      if (char === quote) {
        this.index = index + 1;
        return value;
      }
      value += char;
      index += 1;
    }
    this.reject('unterminated string literal');
  }

  // -- bindings ------------------------------------------------------------

  private bind(name: string, binding: Binding): void {
    // A string name may be re-bound to another statically known string: the
    // grammar has no control flow, so evaluation stays linear and every path
    // is still resolved (and containment-checked) at its use site. The common
    // read-modify-write idiom (`s = s.replace(...)`) depends on this.
    //
    // Re-binding anything else — or shadowing a module/handle binding with a
    // string — is still rejected: that is the aliasing the grammar forbids.
    // (Python cannot produce an `fs` binding today, so that half is
    // defense-in-depth for a future grammar, not a live check.)
    //
    // The relaxation is python-only, for TWO independent reasons — lifting the
    // gate here alone would not give node the idiom:
    //  1. node binds only through `const`/`let`, where a redeclaration is a
    //     SyntaxError — accepting it would auto-allow a command that cannot run;
    //  2. `parseNodeStatement` has no undeclared-assignment form at all, so the
    //     legal `let s = …` / `s = s.replace(…)` shape never reaches `bind()`.
    // Supporting node means adding that statement form as well.
    const rebindable =
      this.grammar.language === 'python' && binding.kind === 'string';
    const existing = this.bindings.get(name);
    if (existing && !(rebindable && existing.kind === 'string')) {
      this.reject(`\`${name}\` is reassigned`);
    }
    this.bindings.set(name, binding);
  }

  private lookup(name: string): Binding {
    const binding = this.bindings.get(name);
    if (!binding) this.reject(`\`${name}\` is not defined in the snippet`);
    return binding;
  }

  // -- expressions ---------------------------------------------------------

  /** A path argument: literal string, or a name bound to one. */
  private parsePath(): string {
    const value = this.parseExpression();
    if (value.text === null) this.reject('path is not statically known');
    return value.text;
  }

  private parseExpression(): Value {
    let value = this.parsePrimary();
    for (;;) {
      if (!this.eat('.')) return value;
      const method = this.tryName();
      if (method === null || !(method in this.grammar.methods)) {
        this.reject(`unsupported method \`.${method ?? '?'}()\``);
      }
      const args = this.parseArguments();
      if (args.length !== this.grammar.methods[method]) {
        this.reject(`wrong argument count for \`.${method}()\``);
      }
      // Derived strings are never treated as statically known, so they can
      // never be used as a path.
      value = UNKNOWN;
    }
  }

  private parseArguments(): Value[] {
    this.expect('(');
    const args: Value[] = [];
    if (this.eat(')')) return args;
    for (;;) {
      args.push(this.parseExpression());
      if (this.eat(')')) return args;
      this.expect(',');
    }
  }

  private parsePrimary(): Value {
    const literal = this.tryString();
    if (literal !== null) return { text: literal };

    const save = this.index;
    const name = this.tryName();
    if (name === null) this.reject('unsupported expression');

    if (this.grammar.language === 'python') {
      if (name === 'open') return this.parsePythonOpen();
      if (name === 're') {
        this.expect('.');
        if (this.tryName() !== 'sub') this.reject('only `re.sub` is allowed');
        const args = this.parseArguments();
        if (args.length !== 3) this.reject('`re.sub` needs 3 arguments');
        return UNKNOWN;
      }
    }

    const binding = this.lookup(name);
    if (binding.kind === 'fs') {
      this.index = save;
      return this.parseNodeFsCall('read');
    }
    if (binding.kind !== 'string') this.reject(`\`${name}\` is not a value`);
    // A call on a bound name is not part of the grammar (blocks aliasing).
    this.skipSpace();
    if (this.source[this.index] === '(') this.reject(`\`${name}\` is not callable`);
    return { text: binding.value };
  }

  // -- python `open(...)` --------------------------------------------------

  /** `open(PATH)` / `open(PATH, MODE)` followed by `.read()` or `.write(x)`. */
  private parsePythonOpen(): Value {
    const args = this.parseArgumentList();
    if (args.length === 0 || args.length > 2) this.reject('bad `open()` arity');
    const target = args[0];
    if (target === null) this.reject('`open()` path is not statically known');
    const mode = args.length === 2 ? args[1] : 'r';
    if (mode === null) this.reject('`open()` mode is not statically known');
    if (!/^[rwax]b?\+?$/.test(mode)) this.reject(`unsupported open mode ${mode}`);
    const isWrite = /[wax+]/.test(mode);

    this.expect('.');
    const method = this.tryName();
    if (method === 'read') {
      if (isWrite) this.reject('reading a file opened for writing');
      this.expect('(');
      this.expect(')');
      this.reads.push(target);
      return UNKNOWN;
    }
    if (method === 'write') {
      if (!isWrite) this.reject('writing a file opened for reading');
      const written = this.parseArguments();
      if (written.length !== 1) this.reject('`write()` needs 1 argument');
      this.writes.push(target);
      return UNKNOWN;
    }
    this.reject(`unsupported file method \`.${method ?? '?'}()\``);
  }

  /** Argument list where each argument must be a statically known string. */
  private parseArgumentList(): (string | null)[] {
    this.expect('(');
    const args: (string | null)[] = [];
    if (this.eat(')')) return args;
    for (;;) {
      args.push(this.parseExpression().text);
      if (this.eat(')')) return args;
      this.expect(',');
    }
  }

  // -- node `fs.*` ---------------------------------------------------------

  /**
   * `fs.readFileSync(PATH, 'utf8')` / `fs.writeFileSync(PATH, EXPR)`.
   * Only these two exist in the grammar — the rest of the `fs` surface
   * (cpSync, truncateSync, symlinkSync, the async forms ) is not reachable.
   */
  private parseNodeFsCall(context: 'read' | 'statement'): Value {
    const name = this.tryName();
    if (name === null || this.lookup(name).kind !== 'fs') {
      this.reject('expected an `fs` call');
    }
    this.expect('.');
    const method = this.tryName();

    if (method === 'readFileSync') {
      this.expect('(');
      const target = this.parsePath();
      if (this.eat(',')) {
        const encoding = this.parseExpression().text;
        if (encoding !== 'utf8' && encoding !== 'utf-8') {
          this.reject('only utf8 reads are supported');
        }
      }
      this.expect(')');
      this.reads.push(target);
      return UNKNOWN;
    }

    if (method === 'writeFileSync') {
      if (context !== 'statement') this.reject('`writeFileSync` is a statement');
      this.expect('(');
      const target = this.parsePath();
      this.expect(',');
      this.parseExpression();
      if (this.eat(',')) this.parseExpression(); // options
      this.expect(')');
      this.writes.push(target);
      return UNKNOWN;
    }

    this.reject(`unsupported fs method \`${method ?? '?'}\``);
  }

  // -- statements ----------------------------------------------------------

  parseStatement(line: string): void {
    this.source = line;
    this.index = 0;
    if (this.atEnd()) return;

    if (this.grammar.language === 'python') this.parsePythonStatement();
    else this.parseNodeStatement();

    this.skipSpace();
    if (!this.atEnd()) this.reject('trailing input');
  }

  private parsePythonStatement(): void {
    if (this.eat('import ')) {
      const module = this.tryName();
      if (module !== 're') this.reject(`import of \`${module ?? '?'}\``);
      return;
    }

    const save = this.index;
    const name = this.tryName();
    if (name !== null && name !== 'open' && name !== 'print' && name !== 're') {
      this.skipSpace();
      if (this.source[this.index] === '=' && this.source[this.index + 1] !== '=') {
        this.index += 1;
        const value = this.parseExpression();
        this.bind(name, { kind: 'string', value: value.text });
        return;
      }
    }
    this.index = save;

    if (this.eat('print')) {
      this.parseArguments();
      return;
    }

    // Bare expression statement: only `open(...).write(...)` qualifies.
    this.parseExpression();
  }

  private parseNodeStatement(): void {
    const declared = this.eat('const ') || this.eat('let ');
    const save = this.index;
    const name = this.tryName();

    if (name !== null && declared) {
      this.skipSpace();
      if (this.source[this.index] !== '=') this.reject('expected `=`');
      this.index += 1;
      this.skipSpace();
      if (this.source.startsWith('require', this.index)) {
        this.index += 'require'.length;
        this.expect('(');
        const module = this.tryString();
        this.expect(')');
        this.eat(';');
        if (module === 'fs') return this.bind(name, { kind: 'fs' });
        this.reject(`require of \`${module ?? '?'}\``);
      }
      const value = this.parseExpression();
      this.eat(';');
      this.bind(name, { kind: 'string', value: value.text });
      return;
    }
    this.index = save;

    if (this.eat('console.log')) {
      this.parseArguments();
      this.eat(';');
      return;
    }

    this.parseNodeFsCall('statement');
    this.eat(';');
  }
}

// ---------------------------------------------------------------------------
// Snippet drivers
// ---------------------------------------------------------------------------

function analyzeSnippet(
  body: string,
  grammar: Grammar,
): ScriptEditAnalysis {
  const kind = grammar.language;
  const commentPrefix = kind === 'python' ? '#' : '//';
  const parser = new Parser('', grammar);

  // Python (universal newlines) and JS both treat more characters as line
  // breaks than `\n` (CR, U+2028, U+2029, and for python \f/\v), so splitting
  // on `\n` alone let `# c\rimport os\ros.system(...)` hide a whole program
  // inside what looked like one comment line. Rather than enumerate them,
  // require printable ASCII: an editing snippet never needs anything else.
  // eslint-disable-next-line no-control-regex -- matching them is the point
  if (/[^\n\t\x20-\x7e]/.test(body)) {
    return fail('exotic line terminator or control character in snippet');
  }

  for (const rawLine of body.split('\n')) {
    if (/\\\s*$/.test(rawLine)) return fail('line continuation');
    if (/^[ \t]+\S/.test(rawLine)) return fail('indented block');
    const line = rawLine.trim();
    if (!line || line.startsWith(commentPrefix)) continue;
    // One statement per line keeps the grammar honest: `;` is how
    // `z = 0; import posix` hid an import behind a valid assignment.
    if (kind === 'python' && line.includes(';')) return fail('`;` in snippet');
    if (kind === 'node' && line.slice(0, -1).includes(';')) {
      return fail('multiple statements on one line');
    }

    try {
      parser.parseStatement(line);
    } catch (error) {
      if (error instanceof ParseError) return fail(error.message);
      throw error;
    }
  }

  return finish(kind, parser.reads, parser.writes);
}

// ---------------------------------------------------------------------------
// sed one-liners
// ---------------------------------------------------------------------------

/** Tokenize a simple command, honouring quotes. Fails on shell magic. */
function tokenizeSimple(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\') {
      current += command[++i] ?? '';
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) return null;
  if (started || current) tokens.push(current);
  return tokens;
}

/**
 * A regex with no executable constructs and nothing the shell rewrites.
 * Applied to every regex in an expression — pattern half AND address — because
 * a check that covers only some of them is the same as no check.
 */
function isInertRegex(source: string): boolean {
  // sed has no code blocks; this guards against a `(?{CODE})`-capable dialect
  // being wired up here later, which is how perl got in three times.
  if (/\(\?\??\{/.test(source)) return false;
  // `$` is a literal/anchor to sed, but the SHELL expands `$X` before sed sees
  // it, and the expansion lands inside the expression we validated — enough to
  // graft on a `w /tmp/file` write flag. Only a trailing anchor is allowed.
  if (/\$(?!\/?$)/.test(source)) return false;
  return true;
}

/**
 * A substitution/deletion expression with no side effects.
 * Rejects sed's `e` (execute), `w` (write to another file) and `r` (read file)
 * commands.
 */
function isSafeSubstitution(expression: string): boolean {
  const address = /^(?:\d+(?:,\d+)?|\/(?:[^/\\]|\\.)*\/)/.exec(expression);
  const rest = expression.slice(address?.[0].length ?? 0);

  // The address is a regex too, and it used to skip every check below: an
  // expression like `/(?{CODE})/d` hid its payload entirely inside it.
  if (address && !isInertRegex(address[0])) return false;

  if (/^d$/.test(rest)) return true;
  if (rest[0] !== 's') return false;

  // Hand-scan the three delimited fields: a regex cannot express "any char
  // except this backreference", and letting the delimiter slip into a field
  // is exactly how `s/a/b/w /tmp/x` sneaks a file-write flag through.
  const delimiter = rest[1];
  // `$` is excluded here too: only the field CONTENTS are inspected below, so
  // `sed -i s$HOME$x$ f` would hand a raw `$` to the shell unexamined.
  if (!delimiter || /[\\\s\w$]/.test(delimiter)) return false;

  let index = 2;
  const fields: string[] = [];
  for (let field = 0; field < 2; field += 1) {
    let value = '';
    while (index < rest.length && rest[index] !== delimiter) {
      if (rest[index] === '\\') value += rest[index++] ?? '';
      value += rest[index++] ?? '';
    }
    if (rest[index] !== delimiter) return false; // unterminated field
    index += 1;
    fields.push(value);
  }
  if (fields.length !== 2) return false;

  if (!isInertRegex(fields[0])) return false;

  // Same reasoning for the replacement half: `$X` is expanded by the shell
  // before sed parses the expression, so it could introduce flags.
  const replacement = fields[1];
  if (/\$/.test(replacement)) return false;

  // Remaining text is the flag set: only idempotent match flags, and no
  // whitespace (which would introduce a `w file` / `e` argument).
  return /^[gimIsxp]*\d*$/.test(rest.slice(index));
}

/**
 * `sed [-Er] -i ['' ] (-e EXPR)* [EXPR] FILE...`
 *
 * Deliberately stricter than either sed: no option token may follow the first
 * file operand. GNU permutes options past operands and BSD does not, so the
 * two disagree about which words are files — and every attempt to model that
 * split produced a bypass in one direction or the other:
 *   GNU: `sed -i '/tmp/d' -e 's/A/B/' f`   → `/tmp/d` is a FILE, edited
 *   BSD: `sed -i '' 's/A/B/' f -e /tmp/d`  → `/tmp/d` is a FILE, edited
 * Requiring options-then-operands makes both agree, at the cost of rejecting
 * unusual (but still promptable) orderings.
 */
function analyzeSed(tokens: string[]): ScriptEditAnalysis {
  const expressions: string[] = [];
  const files: string[] = [];
  let inPlace = false;
  let expectExpression = false;
  let operandSeen = false;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (expectExpression) {
      expressions.push(token);
      expectExpression = false;
      continue;
    }
    // Any operand — the bare script as much as a file — ends the option
    // section. `sed -i '/tmp/d' -e 's/A/B/' f` looks like "script then -e"
    // here, but GNU reads `/tmp/d` as a file and edits it.
    if (token.startsWith('-') && operandSeen) {
      return fail(`sed option ${token} after an operand`);
    }
    if (token === '-e') {
      expectExpression = true;
      continue;
    }
    if (token === '-i') {
      inPlace = true;
      // BSD sed REQUIRES a suffix argument, so it swallows whatever comes
      // next: `sed -i -e 's/a/b/' f` writes `f-e`, a file we never report or
      // permission-check. Only the explicit empty suffix is unambiguous.
      const next = tokens[i + 1];
      if (next === '') {
        i += 1;
        continue;
      }
      if (next !== undefined && next.startsWith('-')) {
        return fail('ambiguous sed backup suffix after -i');
      }
      continue;
    }
    if (/^-i\S+$/.test(token)) {
      // A backup suffix creates a second, unreported file — and GNU sed lets
      // it carry a directory component and a `*` standing for the filename,
      // i.e. an arbitrary write. Only bare `-i` is auditable.
      return fail('sed backup suffix not allowed');
    }
    if (/^-[Er]+$/.test(token)) continue;
    // Everything else, `-n` included: it suppresses auto-print, so with `-i`
    // it rewrites every target to empty — a delete dressed as an edit.
    if (token.startsWith('-')) return fail(`sed flag ${token} not allowed`);
    // With options confined to the front, the first bare operand is the
    // script exactly when no `-e` supplied one.
    operandSeen = true;
    if (expressions.length === 0) {
      expressions.push(token);
    } else {
      files.push(token);
    }
  }

  if (!inPlace) return fail('sed without -i does not edit files');
  if (expressions.length === 0) return fail('sed with no expression');
  if (files.length === 0) return fail('sed with no file argument');
  for (const expression of expressions) {
    if (!isSafeSubstitution(expression)) {
      return fail(`sed expression not a plain substitution: ${expression}`);
    }
  }
  return finish('sed', [], files);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const PYTHON_BIN = /^python[\d.]*$/;

/**
 * Analyze a bash command. Returns `ok: true` with the files it touches only
 * when the command is a single interpreter invocation whose snippet parses
 * cleanly against the closed grammar above.
 *
 * The caller is still responsible for resolving the returned paths against
 * the working directory and checking them against permission rules.
 */
export function analyzeScriptEditCommand(command: string): ScriptEditAnalysis {
  const trimmed = command.trim();
  if (!trimmed) return fail('empty command');

  const heredoc = splitHeredoc(trimmed);
  if (heredoc && 'error' in heredoc) return fail(heredoc.error);

  if (heredoc) {
    const shellError = checkShellShape(heredoc.head);
    if (shellError) return fail(shellError);
    const tokens = tokenizeSimple(heredoc.head);
    if (!tokens || tokens.length === 0) return fail('unparseable command');
    const [bin, ...rest] = tokens;
    const stdinArgs = rest.filter((token) => token !== '-');
    if (stdinArgs.length > 0) {
      return fail(`unexpected arguments: ${stdinArgs.join(' ')}`);
    }
    if (PYTHON_BIN.test(bin)) return analyzeSnippet(heredoc.body, PYTHON_GRAMMAR);
    if (bin === 'node') return analyzeSnippet(heredoc.body, NODE_GRAMMAR);
    return fail(`${bin} heredoc not supported`);
  }

  const shellError = checkShellShape(trimmed);
  if (shellError) return fail(shellError);
  const tokens = tokenizeSimple(trimmed);
  if (!tokens || tokens.length === 0) return fail('unparseable command');

  if (tokens[0] === 'sed') return analyzeSed(tokens);
  // `perl -pi -e` is deliberately NOT supported. Perl's regex grammar is a
  // programming language: `s/(?{CODE})x/y/`, `/(?{CODE})/d` and `@{[...]}`
  // all execute code with no `/e` flag, and three separate rounds of review
  // found a new execution primitive each time. A "safe subset" of it cannot
  // be validated without reimplementing perl's parser, so perl commands keep
  // prompting like any other bash command.
  if (tokens[0] === 'perl') return fail('perl is not auto-allowed');
  if (PYTHON_BIN.test(tokens[0]) || tokens[0] === 'node') {
    // Inline `-c` / `-e` snippets.
    const flagIndex = tokens.findIndex((t) => t === '-c' || t === '-e');
    if (flagIndex !== 1) return fail('interpreter without inline snippet');
    const snippet = tokens[2];
    if (snippet === undefined) return fail('missing inline snippet');
    if (tokens.length !== 3) return fail('extra interpreter arguments');
    return PYTHON_BIN.test(tokens[0])
      ? analyzeSnippet(snippet, PYTHON_GRAMMAR)
      : analyzeSnippet(snippet, NODE_GRAMMAR);
  }

  return fail('not a script edit command');
}
