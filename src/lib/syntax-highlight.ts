import { languages, lang as normalizeLang } from 'sugar-high/lang';
import { parse, type ParseOptions, type TokenType } from 'sugar-high/core';
import type { LanguageName } from 'sugar-high';
import { highlight as sugarHighlight } from 'sugar-high';

/**
 * Synchronous syntax highlighting built on sugar-high.
 *
 * Replaces shiki, which held every loaded TextMate grammar in a process-wide
 * singleton that never evicted. sugar-high tokenizes ~13x faster and its
 * grammar-free lexer has no such residency. (Measured RSS deltas favoured
 * sugar-high by ~2.5x, but that included oniguruma's out-of-heap WASM; the two
 * have not been compared in a real renderer heap snapshot.)
 *
 * Tokens expose `color` as a `var(--sh-*)` reference rather than a literal
 * hex value, so the palette lives in CSS (see `index.css`) and consumers can
 * keep rendering `<span style={{ color: token.color }}>` unchanged.
 */

export type { LanguageName };

/** A single highlighted token. Shape-compatible with shiki's `ThemedToken`. */
export type HighlightToken = {
  content: string;
  color: string;
};

/** Per-line tokens. `lines[i]` corresponds to `code.split('\n')[i]`. */
export type HighlightLines = HighlightToken[][];

const LANGUAGE_CONFIGS = new Map<LanguageName, ParseOptions>(
  languages.map((language) => [language.id, language.config ?? {}]),
);

export const DEFAULT_LANGUAGE: LanguageName = 'plaintext';

/**
 * Token types that carry no visual meaning. `break` never appears inside a
 * line's tokens, but we guard anyway so line indexing can never drift.
 */
const UNSTYLED_TOKEN_TYPES = new Set<TokenType>(['space', 'break']);

const tokenColorCache = new Map<TokenType, string>();

function colorForToken(type: TokenType): string {
  let color = tokenColorCache.get(type);
  if (!color) {
    color = `var(--sh-${type})`;
    tokenColorCache.set(type, color);
  }
  return color;
}

/**
 * Extensions sugar-high cannot resolve on its own, mapped to the closest
 * canonical language. `lang()` handles the rest (ts, tsx, py, rb, yml, ...).
 */
const EXTENSION_OVERRIDES: Record<string, LanguageName> = {
  h: 'c',
  hpp: 'cpp',
  hh: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  less: 'css',
  sass: 'css',
  ini: 'toml',
  cfg: 'toml',
  conf: 'toml',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  patch: 'diff',
  txt: 'plaintext',
  text: 'plaintext',
};

/** Filenames with no extension that still imply a language. */
const FILENAME_OVERRIDES: Record<string, LanguageName> = {
  dockerfile: 'dockerfile',
  makefile: 'shell',
  gemfile: 'ruby',
  rakefile: 'ruby',
  brewfile: 'ruby',
};

/**
 * Dotfiles, which have no extension to key off.
 *
 * Listed explicitly rather than guessed from the name: most `*rc` dotfiles are
 * JSON or INI (`.prettierrc`, `.babelrc`, `.npmrc`), not shell, so an
 * `endsWith('rc')` heuristic is wrong more often than right.
 */
const DOTFILE_OVERRIDES: Record<string, LanguageName> = {
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.zshenv': 'shell',
  '.profile': 'shell',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  '.stylelintrc': 'json',
  '.swcrc': 'json',
  '.npmrc': 'toml',
  '.yarnrc': 'toml',
  '.editorconfig': 'toml',
  '.gitconfig': 'toml',
  '.gitignore': 'shell',
  '.gitattributes': 'shell',
  '.dockerignore': 'shell',
  '.env': 'shell',
};

/**
 * Normalize a language name, markdown fence alias, or extension to a
 * canonical sugar-high language. Returns `plaintext` when unrecognized so
 * callers never need a try/catch.
 */
export function resolveLanguage(name: string | null | undefined): LanguageName {
  if (!name) return DEFAULT_LANGUAGE;
  const key = name.trim().toLowerCase();
  if (!key) return DEFAULT_LANGUAGE;

  return (
    normalizeLang(key) ??
    EXTENSION_OVERRIDES[key] ??
    FILENAME_OVERRIDES[key] ??
    DEFAULT_LANGUAGE
  );
}

/**
 * Get a canonical language from a file path.
 * Returns `plaintext` if the extension is not recognized.
 */
export function getLanguageFromPath(filePath: string): LanguageName {
  const filename = filePath.split('/').pop() || filePath;
  const lower = filename.toLowerCase();

  // Extensionless files (Dockerfile, Makefile).
  if (!lower.includes('.')) {
    return FILENAME_OVERRIDES[lower] ?? resolveLanguage(lower);
  }

  // Dotfiles with no further extension (.zshrc, .prettierrc) — but not
  // dotted-and-extensioned names like `.eslintrc.json`, which fall through to
  // normal extension handling below.
  if (lower.startsWith('.') && lower.lastIndexOf('.') === 0) {
    const known = DOTFILE_OVERRIDES[lower];
    if (known) return known;
    // A bare `.ts` / `.py` is still a language hint.
    return resolveLanguage(lower.slice(1));
  }

  const ext = lower.split('.').pop();
  return resolveLanguage(ext);
}

/**
 * Bound the cache by total characters rather than entry count, so a handful of
 * very large files cannot pin an unbounded amount of memory.
 */
const MAX_CACHED_CHARS = 2_000_000;
const MAX_CACHEABLE_ENTRY_CHARS = 200_000;

/**
 * Each entry stores the exact char count it was charged, so eviction credits
 * back precisely what insertion debited. Recomputing the cost from the tokens
 * at eviction time would undercount, because token contents exclude the `\n`
 * line separators -- cachedChars would then ratchet upward until it sat above
 * the budget permanently and every later insert wiped the whole cache.
 */
type CacheEntry = { lines: HighlightLines; chars: number };

const lineCache = new Map<string, CacheEntry>();
let cachedChars = 0;

function cacheKey(code: string, language: LanguageName): string {
  return `${language}\n${code}`;
}

/** Evict in insertion order (Map preserves it) until back under budget. */
function evictUntilUnderBudget(): void {
  for (const [key, entry] of lineCache) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    lineCache.delete(key);
    cachedChars -= entry.chars;
  }
}


/** A whole line rendered as a single uncoloured token. */
function plainLine(text: string): HighlightToken[] {
  return text ? [{ content: text, color: 'inherit' }] : [];
}

/**
 * sugar-high's lexer is ~quadratic in the length of one contiguous word token,
 * so a single enormous run of word characters can block the main thread for
 * seconds. Measured on one unbroken run: 25K chars 29ms, 50K 212ms, 100K 570ms.
 *
 * The run length is what matters, not the file or line size — real base64 blobs
 * (broken up by `+/=`) and minified bundles (broken up by punctuation) both stay
 * in the tens of milliseconds even at 800KB, so guarding on line length instead
 * would grey out files that highlight perfectly well.
 *
 * Realistic triggers are inlined data URIs and `sourceMappingURL=...base64,...`
 * payloads. No identifier in real source approaches this bound.
 */
const MAX_WORD_RUN_CHARS = 32_000;

function hasPathologicalWordRun(code: string): boolean {
  let run = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    const isWordChar =
      (c >= 97 && c <= 122) || // a-z
      (c >= 65 && c <= 90) || // A-Z
      (c >= 48 && c <= 57) || // 0-9
      c === 95 || // _
      c === 36 || // $
      c > 127; // non-ASCII identifier characters
    if (!isWordChar) {
      run = 0;
    } else if (++run > MAX_WORD_RUN_CHARS) {
      return true;
    }
  }
  return false;
}

function contentLength(tokens: HighlightToken[]): number {
  let total = 0;
  for (const token of tokens) total += token.content.length;
  return total;
}

/**
 * Tokenize `code` into per-line tokens. Synchronous — no loading state needed.
 *
 * Guarantees, for every input:
 * - `result.length === code.split('\n').length`
 * - each line's tokens span exactly that line's characters
 *
 * Callers index tokens by line number and build character-offset maps from
 * them (see utils-search-highlight), so both properties are load-bearing.
 * They are *enforced* below rather than assumed — see the per-line audit.
 */
export function tokenizeLines(
  code: string,
  language: LanguageName = DEFAULT_LANGUAGE,
): HighlightLines {
  if (!code) return [[]];

  const key = cacheKey(code, language);
  const cached = lineCache.get(key);
  if (cached) {
    // Refresh recency: delete + re-insert moves it to the end of iteration.
    lineCache.delete(key);
    lineCache.set(key, cached);
    return cached.lines;
  }

  // A trailing `\r` gets merged into the preceding token and typed as `string`,
  // which miscolours the last visible character of every line in a CRLF file.
  // Tokenize the normalized text and re-attach each `\r` afterwards, so content
  // is still preserved exactly.
  const hasCrlf = code.includes('\r\n');

  // The authoritative line texts. sugar-high's own `line.value` cannot be used
  // for the audit below: on malformed markup it drops the character at the line
  // level too, so it would agree with its own lossy tokens.
  const rawLines = code.split('\n');

  let lines: HighlightLines;
  try {
    // Skip highlighting rather than freeze the renderer. Rendering the file
    // uncoloured is strictly better than a multi-second unresponsive window.
    if (hasPathologicalWordRun(code)) throw new Error('pathological word run');

    const parsed = parse(
      hasCrlf ? code.replace(/\r\n/g, '\n') : code,
      LANGUAGE_CONFIGS.get(language) ?? {},
    );
    if (parsed.lines.length !== rawLines.length) throw new Error('line drift');

    lines = parsed.lines.map((line, index) => {
      const tokens: HighlightToken[] = [];
      for (const token of line.tokens) {
        if (!token.value) continue;
        tokens.push({
          content: token.value,
          color: UNSTYLED_TOKEN_TYPES.has(token.type)
            ? 'inherit'
            : colorForToken(token.type),
        });
      }

      const raw = rawLines[index];
      // Line endings can be mixed, so check this line rather than assume CRLF
      // throughout. The `\r` is a token of its own so it cannot tint text.
      if (hasCrlf && raw.endsWith('\r')) {
        tokens.push({ content: '\r', color: 'inherit' });
      }

      // Enforce the documented invariant. A character drop here would shift
      // every downstream offset and display text that is not in the file, so a
      // failing line falls back to uncoloured raw text — losing colour on that
      // line only, never correctness.
      return contentLength(tokens) === raw.length ? tokens : plainLine(raw);
    });
  } catch {
    // Never let a tokenizer edge case blank out the viewer.
    lines = rawLines.map(plainLine);
  }

  if (code.length <= MAX_CACHEABLE_ENTRY_CHARS) {
    lineCache.set(key, { lines, chars: code.length });
    cachedChars += code.length;
    if (cachedChars > MAX_CACHED_CHARS) evictUntilUnderBudget();
  }

  return lines;
}

/**
 * Highlight `code` to an HTML string of `<span class="sh__line">` rows.
 * Use for read-only blocks; prefer `tokenizeLines` when you need to interleave
 * React nodes such as search marks or line numbers.
 */
export function highlightToHtml(
  code: string,
  language: LanguageName = DEFAULT_LANGUAGE,
): string {
  // Same freeze guard as tokenizeLines — this path shares the same lexer.
  if (hasPathologicalWordRun(code)) return escapeHtml(code);

  try {
    return sugarHighlight(code, { lang: language });
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Only ever inserted as element content (inside `<code>`), never into an
 * attribute, so escaping the three structural characters is sufficient.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Exposed for tests and diagnostics. */
export function clearHighlightCache(): void {
  lineCache.clear();
  cachedChars = 0;
}
