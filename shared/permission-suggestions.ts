/**
 * Build suggested permission patterns for a bash subcommand that triggered a
 * prompt, so users can one-click grant a rule instead of hand-writing one.
 *
 * Security model: broad (`binary *`) suggestions use an **allowlist**, not a
 * denylist. `matchBashPattern` lets `*` match anything including `/` and
 * spaces, so `docker *` or `npm *` would be a full arbitrary-code-execution
 * escape hatch. Only binaries that cannot execute arbitrary code (or write
 * files) may be suggested broadly; everything else gets the exact command
 * only. The exact pattern is always glob-escaped so it can never widen.
 */

/**
 * Binaries safe to suggest as `binary *`.
 *
 * Criteria: cannot execute arbitrary code, cannot write/delete files, cannot
 * make network calls. Notably excluded: `sed`/`awk`/`perl` (in-place edits,
 * `system()`), `find`/`xargs` (`-exec`, `-delete`), `curl`/`wget`, every
 * package manager (`npm run <anything>`), and every cloud/container CLI.
 */
const READONLY_BINARIES = new Set([
  'basename',
  'cat',
  'column',
  'cut',
  'date',
  'diff',
  'dirname',
  'du',
  'df',
  'echo',
  'file',
  'grep',
  'head',
  'hostname',
  'jq',
  'ls',
  'nl',
  'pwd',
  'realpath',
  'rg',
  'sort',
  'stat',
  'tail',
  'tr',
  'tree',
  'uname',
  'uniq',
  'wc',
  'whoami',
  'which',
  'yq',
]);

/**
 * Binaries whose first verb is safe to suggest as `binary verb *`.
 *
 * Same criteria as above, applied per subcommand. Deliberately narrow — e.g.
 * `git` is here but `git config`/`git push` are not, and package managers are
 * absent entirely because `npm run <script>` runs arbitrary code.
 */
const SAFE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    'blame',
    'branch',
    'describe',
    'diff',
    'log',
    'ls-files',
    'rev-parse',
    'show',
    'status',
  ]),
};

/**
 * Binaries that make a command dangerous no matter where they appear in the
 * token list (wrappers like `xargs rm -rf` would otherwise look benign).
 * Presence of any of these suppresses every non-exact suggestion.
 */
const DANGEROUS_TOKENS = new Set([
  'awk',
  'bash',
  'chmod',
  'chown',
  'curl',
  'dd',
  'doas',
  'eval',
  'exec',
  'find',
  'kill',
  'killall',
  'mkfs',
  'node',
  'npx',
  'perl',
  'python',
  'python3',
  'reboot',
  'rm',
  'ruby',
  'sh',
  'shutdown',
  'ssh',
  'sudo',
  'wget',
  'xargs',
  'zsh',
]);

export interface PermissionSuggestion {
  /** Pattern to store in the rule (glob-escaped where it must stay exact). */
  pattern: string;
  /** Human-readable text for the chip (unescaped). */
  label: string;
  /** Breadth ranking: 0 = exact command, 1 = binary+verb, 2 = binary. */
  breadth: number;
}

function escapeExact(value: string): string {
  return value.replace(/[\\*?]/g, '\\$&');
}

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** Last path segment of a token, so `/usr/bin/sed` is compared as `sed`. */
function binaryName(token: string): string {
  return token.split('/').pop() ?? token;
}

/**
 * Return suggested rule patterns for a single bash subcommand, ordered
 * narrowest -> broadest. Always includes the exact command; broader patterns
 * only when the command is provably safe to widen.
 *
 * @param subCommand - A single (non-compound) bash command.
 */
export function buildBashSuggestions(
  subCommand: string,
): PermissionSuggestion[] {
  const trimmed = subCommand.trim();
  if (!trimmed) return [];

  const tokens = tokenize(trimmed);

  // Narrowest: the exact command, escaped so metacharacters cannot widen it.
  const suggestions: PermissionSuggestion[] = [
    { pattern: escapeExact(trimmed), label: trimmed, breadth: 0 },
  ];

  // Any dangerous token anywhere (wrappers included) => exact only.
  if (tokens.some((token) => DANGEROUS_TOKENS.has(binaryName(token)))) {
    return suggestions;
  }

  // Skip env-var prefixes (FOO=bar cmd).
  let index = 0;
  while (
    index < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])
  ) {
    index += 1;
  }
  const binary = binaryName(tokens[index] ?? '');
  // Allowlisted names are plain identifiers, so no glob-escaping is needed —
  // but bail out if a lookalike token somehow carries metacharacters.
  if (!binary || /[\\*?]/.test(binary)) return suggestions;

  const safeVerbs = SAFE_SUBCOMMANDS[binary];
  if (safeVerbs) {
    const verb = tokens
      .slice(index + 1)
      .find((token) => !token.startsWith('-'));
    if (verb && safeVerbs.has(verb)) {
      suggestions.push({
        pattern: `${binary} ${verb} *`,
        label: `${binary} ${verb} *`,
        breadth: 1,
      });
    }
  }

  if (READONLY_BINARIES.has(binary)) {
    suggestions.push({ pattern: `${binary} *`, label: `${binary} *`, breadth: 2 });
  }

  return suggestions;
}
