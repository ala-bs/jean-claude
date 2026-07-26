/**
 * Heuristics to detect whether a Bash command is likely to mutate files in the
 * working tree.
 *
 * Agents sometimes edit files through the shell (`sed -i`, a python script, a
 * heredoc redirect, ...) instead of the Edit/Write tools. Those edits are
 * invisible to the prompt-group diff summary, which only understands `edit` and
 * `write` tool uses. When a command looks mutating we snapshot the git tree
 * around it so the changes can be attributed back to the command.
 *
 * The classifier is intentionally conservative in one direction only: false
 * positives merely cost one extra git snapshot, false negatives lose data. So
 * when in doubt, treat the command as mutating.
 */

/** Commands that write to disk when invoked at all. */
const ALWAYS_MUTATING_COMMANDS = new Set([
  'chmod', // git tracks the executable bit
  'cp',
  'dd',
  'install',
  'ln',
  'mkdir',
  'mv',
  'patch',
  'rename',
  'rm',
  'rmdir',
  'shred',
  'tee',
  'touch',
  'truncate',
  'unlink',
]);

/** Formatters and codemods whose whole purpose is rewriting files. */
const FORMATTER_COMMANDS = new Set([
  'biome',
  'black',
  'clang-format',
  'dprint',
  'gofmt',
  'isort',
  'prettier',
  'rustfmt',
]);

/** Commands that run another command, whose arguments must be re-inspected. */
const COMMAND_WRAPPERS = new Set([
  'bash',
  'dash',
  'sh',
  'timeout',
  'xargs',
  'zsh',
]);

/** Flags that make an otherwise-mutating command print instead of write. */
const DRY_RUN_FLAGS = new Set(['-n', '--dry-run', '--dry_run']);

/** Flags after which a command only prints information. */
const INERT_FLAGS = new Set(['-v', '-V', '--version', '-h', '--help']);

/** Interpreters that can write files depending on the script they run. */
const SCRIPT_INTERPRETERS = new Set([
  'bun',
  'deno',
  'cargo',
  'go',
  'gunzip',
  'make',
  'node',
  'npm',
  'npx',
  'perl',
  'php',
  'pnpm',
  'python',
  'python2',
  'python3',
  'ruby',
  'tar',
  'tsc',
  'tsx',
  'unzip',
  'yarn',
]);

/** `git` subcommands that change tracked files in the working tree. */
const MUTATING_GIT_SUBCOMMANDS = new Set([
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'merge',
  'mv',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
]);

/** In-place edit flags for stream editors (`sed -i`, `perl -pi -e`, ...). */
const IN_PLACE_FLAG = /^-{1,2}[a-zA-Z]*i/;

const STREAM_EDITORS = new Set(['sed', 'gsed', 'perl', 'ruby', 'awk', 'gawk']);

/**
 * Splits a shell command line into individual simple commands, breaking on
 * separators (`;`, `&&`, `||`, `|`, newlines) while ignoring separators that
 * appear inside quotes.
 */
function splitSimpleCommands(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      if (char === '\\' && quote === '"') {
        current += char + (next ?? '');
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && next === '\n') {
      index += 1;
      continue;
    }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      if ((char === '|' || char === '&') && next === char) index += 1;
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Tokenizes a simple command, keeping quoted segments together. */
function tokenize(simpleCommand: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;
  for (let index = 0; index < simpleCommand.length; index += 1) {
    const char = simpleCommand[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      hasContent = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) tokens.push(current);
      current = '';
      hasContent = false;
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

/** Strips leading `VAR=value` assignments and command prefixes like `sudo`. */
function stripCommandPrefixes(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token === 'sudo' || token === 'command' || token === 'env' || token === 'time') {
      index += 1;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

/** Returns the base name of an executable path (`/usr/bin/sed` -> `sed`). */
function baseName(executable: string): string {
  const withoutDir = executable.split('/').pop() ?? executable;
  return withoutDir.toLowerCase();
}

function hasWriteRedirect(simpleCommand: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < simpleCommand.length; index += 1) {
    const char = simpleCommand[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '>') continue;
    // `2>&1`-style duplications do not create files.
    const next = simpleCommand[index + 1];
    if (next === '&') {
      index += 1;
      continue;
    }
    return true;
  }
  return false;
}

/** `find` only writes when told to delete or execute something. */
function isMutatingFind(args: string[]): boolean {
  return args.some(
    (arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir',
  );
}

function isMutatingSimpleCommand(simpleCommand: string, depth: number): boolean {
  if (hasWriteRedirect(simpleCommand)) return true;

  const tokens = stripCommandPrefixes(tokenize(simpleCommand));
  const executable = tokens[0];
  if (!executable) return false;
  const name = baseName(executable);
  const args = tokens.slice(1);

  // `node -v`, `python3 --version`, ... only print.
  if (args.length > 0 && args.every((arg) => INERT_FLAGS.has(arg))) return false;

  // A wrapper's real command lives in its arguments; re-inspect them.
  // `xargs sed -i ...`, `bash -c "sed -i ..."`, `timeout 5 python x.py`.
  if (COMMAND_WRAPPERS.has(name) && depth < MAX_WRAPPER_DEPTH) {
    const start = args.findIndex(
      (arg) => !arg.startsWith('-') && !/^\d+[smhd]?$/.test(arg),
    );
    if (start === -1) return false;
    return isLikelyFileMutatingCommand(args.slice(start).join(' '), depth + 1);
  }

  if (ALWAYS_MUTATING_COMMANDS.has(name)) {
    return !args.includes('--dry-run');
  }

  if (FORMATTER_COMMANDS.has(name)) return true;

  if (name === 'find') return isMutatingFind(args);

  if (name === 'curl') {
    return args.some((arg) => arg === '-o' || arg === '-O' || arg === '--output');
  }
  if (name === 'wget') {
    return !args.includes('--spider');
  }

  if (name === 'git') {
    // Skip global options and their values (`git -C path`, `git -c k=v`).
    let cursor = 0;
    while (cursor < args.length && args[cursor]!.startsWith('-')) {
      const flag = args[cursor]!;
      cursor += flag === '-C' || flag === '-c' ? 2 : 1;
    }
    const subcommand = args[cursor];
    if (!subcommand || !MUTATING_GIT_SUBCOMMANDS.has(subcommand)) return false;
    const subArgs = args.slice(cursor + 1);
    // `git stash list`, `git clean -n`, `git checkout --help` do not write.
    if (
      subArgs.some((arg) => DRY_RUN_FLAGS.has(arg) || arg === '--help') ||
      (subcommand === 'clean' && !subArgs.some((arg) => /^-[a-zA-Z]*f/.test(arg)))
    ) {
      return false;
    }
    if (subcommand === 'stash') {
      const stashAction = subArgs[0];
      if (stashAction === 'list' || stashAction === 'show') return false;
    }
    return true;
  }

  if (STREAM_EDITORS.has(name) && args.some((arg) => IN_PLACE_FLAG.test(arg))) {
    return true;
  }

  // Interpreters running inline code or a script file may write anything.
  if (SCRIPT_INTERPRETERS.has(name)) return args.length > 0;

  // A shell script or build tool can do anything; assume it writes.
  if (/\.(sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts)$/.test(name)) return true;

  return false;
}

/** Guard against pathological nesting in wrapper commands. */
const MAX_WRAPPER_DEPTH = 3;

/**
 * Returns true when the command is likely to have modified files on disk.
 *
 * Heredocs are treated as mutating because they are almost always used to write
 * a file (`cat <<'EOF' > file`), and the redirect may live on a later line.
 * Command substitutions (`$(...)`, backticks) are inspected as well, since a
 * mutating command can hide inside one.
 */
export function isLikelyFileMutatingCommand(
  command: string,
  depth = 0,
): boolean {
  if (!command.trim()) return false;
  if (/<<-?\s*['"]?[A-Za-z_]/.test(command)) return true;
  if (splitSimpleCommands(command).some((part) => isMutatingSimpleCommand(part, depth))) {
    return true;
  }
  if (depth < MAX_WRAPPER_DEPTH) {
    for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
      const inner = match[1] ?? match[2] ?? '';
      if (inner && isLikelyFileMutatingCommand(inner, depth + 1)) return true;
    }
  }
  return false;
}
