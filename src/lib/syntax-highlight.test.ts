import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearHighlightCache,
  DEFAULT_LANGUAGE,
  getLanguageFromPath,
  highlightToHtml,
  resolveLanguage,
  tokenizeLines,
} from './syntax-highlight';
import type { HighlightLines, LanguageName } from './syntax-highlight';

beforeEach(() => {
  clearHighlightCache();
});

describe('getLanguageFromPath', () => {
  it('resolves common extensions', () => {
    expect(getLanguageFromPath('src/app.ts')).toBe('typescript');
    expect(getLanguageFromPath('src/app.tsx')).toBe('typescript');
    expect(getLanguageFromPath('src/app.js')).toBe('javascript');
    expect(getLanguageFromPath('main.py')).toBe('python');
    expect(getLanguageFromPath('lib.rs')).toBe('rust');
    expect(getLanguageFromPath('config.yml')).toBe('yaml');
    expect(getLanguageFromPath('README.md')).toBe('markdown');
  });

  it('maps extensions sugar-high does not know natively', () => {
    // These returned `undefined` from sugar-high's own lang() helper, so the
    // overrides in syntax-highlight.ts are what keep them highlighted.
    expect(getLanguageFromPath('src/util.h')).toBe('c');
    expect(getLanguageFromPath('src/util.hpp')).toBe('cpp');
    expect(getLanguageFromPath('theme.less')).toBe('css');
    expect(getLanguageFromPath('setup.ini')).toBe('toml');
  });

  it('handles shell aliases', () => {
    expect(getLanguageFromPath('run.sh')).toBe('shell');
    expect(getLanguageFromPath('run.bash')).toBe('shell');
    expect(getLanguageFromPath('run.zsh')).toBe('shell');
  });

  it('handles extensionless filenames', () => {
    expect(getLanguageFromPath('Dockerfile')).toBe('dockerfile');
    expect(getLanguageFromPath('some/dir/Dockerfile')).toBe('dockerfile');
    expect(getLanguageFromPath('Gemfile')).toBe('ruby');
  });

  // An endsWith('rc') heuristic used to send every *rc dotfile to the shell
  // grammar, but most of them are JSON or INI.
  it('classifies dotfiles from an explicit list, not an rc heuristic', () => {
    expect(getLanguageFromPath('.zshrc')).toBe('shell');
    expect(getLanguageFromPath('.bashrc')).toBe('shell');
    expect(getLanguageFromPath('.prettierrc')).toBe('json');
    expect(getLanguageFromPath('.babelrc')).toBe('json');
    expect(getLanguageFromPath('.eslintrc')).toBe('json');
    expect(getLanguageFromPath('.npmrc')).toBe('toml');
    expect(getLanguageFromPath('repo/.prettierrc')).toBe('json');
  });

  it('prefers the real extension on dotted-and-extensioned dotfiles', () => {
    expect(getLanguageFromPath('.eslintrc.json')).toBe('json');
    expect(getLanguageFromPath('.eslintrc.yml')).toBe('yaml');
    expect(getLanguageFromPath('.prettierrc.toml')).toBe('toml');
  });

  it('is case insensitive', () => {
    expect(getLanguageFromPath('src/App.TS')).toBe('typescript');
    expect(getLanguageFromPath('DOCKERFILE')).toBe('dockerfile');
  });

  it('uses the last extension on multi-dotted names', () => {
    expect(getLanguageFromPath('a.b.c.ts')).toBe('typescript');
    expect(getLanguageFromPath('bundle.min.js')).toBe('javascript');
  });

  it('falls back to plaintext for unknown paths', () => {
    expect(getLanguageFromPath('data.sqlite3')).toBe(DEFAULT_LANGUAGE);
    expect(getLanguageFromPath('noextension')).toBe(DEFAULT_LANGUAGE);
    expect(getLanguageFromPath('')).toBe(DEFAULT_LANGUAGE);
  });
});

describe('resolveLanguage', () => {
  it('normalizes markdown fence aliases', () => {
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('TSX')).toBe('typescript');
    expect(resolveLanguage('  python  ')).toBe('python');
    expect(resolveLanguage('tf')).toBe('hcl');
  });

  it('falls back to plaintext instead of throwing', () => {
    expect(resolveLanguage(null)).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage('')).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage('not-a-language')).toBe(DEFAULT_LANGUAGE);
  });
});

describe('tokenizeLines', () => {
  // Consumers index tokens by line number (diff rows, line-number gutters,
  // snippet slices), so a drift here silently misaligns highlighting.
  it('returns exactly one entry per line of input', () => {
    const cases = [
      'const a = 1;',
      'const a = 1;\nconst b = 2;',
      'a\n\nb',
      'trailing newline\n',
      '\n',
      '\n\n\n',
    ];

    for (const code of cases) {
      expect(tokenizeLines(code, 'typescript')).toHaveLength(
        code.split('\n').length,
      );
    }
  });

  it('preserves content exactly when tokens are rejoined', () => {
    const code = 'function f(x: number) {\n  return `a${x}b`;\n}\n';
    const rejoined = tokenizeLines(code, 'typescript')
      .map((line) => line.map((token) => token.content).join(''))
      .join('\n');

    expect(rejoined).toBe(code);
  });

  it('keeps multi-line strings aligned to their lines', () => {
    const code = 'x = """line one\nline two"""\ny = 1';
    const lines = tokenizeLines(code, 'python');

    expect(lines).toHaveLength(3);
    expect(lines[1].map((t) => t.content).join('')).toBe('line two"""');
  });

  // sugar-high drops a character on malformed markup (a `/` following `<` in an
  // unclosed tag). Consumers render token content and build character-offset
  // maps from it, so a drop would display text that is not in the file and
  // shift every search highlight after it. tokenizeLines audits each line and
  // falls back to uncoloured raw text rather than lose a character.
  it('never loses characters on malformed markup', () => {
    const cases: [string, LanguageName][] = [
      ['<a/</', 'typescript'],
      ['<a/</b>', 'typescript'],
      ['<//</', 'typescript'],
      ['<A b="1"//>', 'html'],
      ['<a\n/</', 'typescript'],
      ['<a//>', 'html'],
      ['<a href="x"//>', 'html'],
    ];

    for (const [code, language] of cases) {
      const rawLines = code.split('\n');
      const lines = tokenizeLines(code, language);

      expect(lines).toHaveLength(rawLines.length);
      lines.forEach((tokens, i) => {
        expect(tokens.map((t) => t.content).join('')).toBe(rawLines[i]);
      });
    }
  });

  // A trailing \r was merged into the preceding token and typed as `string`,
  // so the last visible character of every line in a CRLF file was miscoloured.
  it('does not let CRLF miscolour the last character of each line', () => {
    const lines = tokenizeLines('const a = 1;\r\nconst b = 2;\r\n', 'typescript');

    const semicolon = lines[0].find((t) => t.content === ';');
    expect(semicolon?.color).toBe('var(--sh-sign)');

    // No token may merge \r into visible text.
    for (const line of lines) {
      for (const token of line) {
        if (token.content.includes('\r')) expect(token.content).toBe('\r');
      }
    }
  });

  // Line endings can be mixed, and a trailing CRLF leaves a final line with no
  // `\r` at all — so the `\r` must be re-attached per line, never blanket-applied.
  it('preserves content exactly across mixed line endings', () => {
    const cases = [
      'const a = 1;\r\n\r\nconst b = "x";\r\n',
      'a\r\nb',
      'a\r\nb\r\n',
      'a\nb\r\nc\n',
      '\r\n',
      'x\ry\r\nz',
      '<a/</\r\nnext',
    ];

    for (const code of cases) {
      clearHighlightCache();
      const rawLines = code.split('\n');
      const lines = tokenizeLines(code, 'typescript');

      expect(lines, code).toHaveLength(rawLines.length);
      lines.forEach((tokens, i) => {
        expect(tokens.map((t) => t.content).join(''), `${code} line ${i}`).toBe(
          rawLines[i],
        );
      });
    }
  });

  // sugar-high's lexer is ~quadratic in one contiguous word run, so an inlined
  // data URI could block the renderer for seconds. The guard degrades to plain
  // text instead — and must NOT fire on content that highlights fine.
  describe('pathological word run guard', () => {
    const isHighlighted = (lines: HighlightLines) =>
      lines.some((line) => line.some((t) => t.color !== 'inherit'));

    it('degrades to plain text on a huge unbroken word run', () => {
      const code = `const data = "${'a'.repeat(40_000)}";`;
      const lines = tokenizeLines(code, 'typescript');

      expect(isHighlighted(lines)).toBe(false);
      // Content must still be intact and line-aligned.
      expect(lines).toHaveLength(1);
      expect(lines[0].map((t) => t.content).join('')).toBe(code);
    });

    it('still highlights base64 and minified content, which are fast', () => {
      // Broken up by +/= and punctuation, so no long word run.
      const base64 = 'aGVsbG8gd29ybGQrLy9hYmM='.repeat(9000);
      const minified = 'function f(a,b){return{x:a+b,y:a-b};}'.repeat(6000);

      expect(base64.length).toBeGreaterThan(200_000);
      expect(isHighlighted(tokenizeLines(base64, 'typescript'))).toBe(true);
      expect(isHighlighted(tokenizeLines(minified, 'typescript'))).toBe(true);
    });

    it('does not fire on ordinary source with long lines', () => {
      const code = `const x = { ${'key: "value", '.repeat(5000)} };`;
      expect(isHighlighted(tokenizeLines(code, 'typescript'))).toBe(true);
    });

    it('guards the HTML path too', () => {
      const code = 'x'.repeat(40_000);
      const html = highlightToHtml(code, 'typescript');

      expect(html).not.toContain('sh__token');
      expect(html).toContain('x');
    });
  });

  it('assigns CSS variable colors by token type', () => {
    const [line] = tokenizeLines('const a = 1;', 'typescript');
    const keyword = line.find((token) => token.content === 'const');

    expect(keyword?.color).toBe('var(--sh-keyword)');
    // Whitespace must not carry a color, or it would override selection styles.
    expect(line.find((token) => token.content === ' ')?.color).toBe('inherit');
  });

  it('marks comments and strings distinctly', () => {
    const [line] = tokenizeLines('x = "hi" # note', 'python');
    const colors = new Set(line.map((token) => token.color));

    expect(colors).toContain('var(--sh-string)');
    expect(colors).toContain('var(--sh-comment)');
  });

  it('handles empty input without throwing', () => {
    expect(tokenizeLines('', 'typescript')).toEqual([[]]);
  });

  it('returns a cached, referentially equal result for repeat calls', () => {
    const code = 'const a = 1;';
    expect(tokenizeLines(code, 'typescript')).toBe(
      tokenizeLines(code, 'typescript'),
    );
  });

  it('does not share cache entries across languages', () => {
    const code = 'x = 1';
    expect(tokenizeLines(code, 'python')).not.toBe(
      tokenizeLines(code, 'ruby'),
    );
  });

  // Regression: eviction used to credit back a recomputed char count that
  // excluded newlines, while insertion debited code.length. The counter
  // ratcheted upward until it exceeded the budget permanently, at which point
  // every insert evicted the entire cache and caching silently stopped working.
  it('keeps caching after eviction, even for newline-heavy content', () => {
    // Half of each file is newlines — the worst case for that mismatch.
    const bulky = (i: number) => `x${i}\n` + 'a\n'.repeat(90_000);

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 15; i++) {
        tokenizeLines(bulky(round * 100 + i), 'plaintext');
      }

      const probe = `const p${round} = 1;`;
      expect(tokenizeLines(probe, 'typescript')).toBe(
        tokenizeLines(probe, 'typescript'),
      );
    }
  });

  it('still tokenizes correctly after the cache is cleared', () => {
    const code = 'const a = 1;';
    const first = tokenizeLines(code, 'typescript');
    clearHighlightCache();
    const second = tokenizeLines(code, 'typescript');

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe('highlightToHtml', () => {
  it('emits one sh__line span per line, newline separated', () => {
    const html = highlightToHtml('const a = 1;\nconst b = 2;', 'typescript');
    const lineSpans = html.match(/<span class="sh__line"/g);

    expect(lineSpans).toHaveLength(2);
    // The newline between line spans is what produces the visual line break
    // inside <pre>, which the FilePreviewPane line-number math depends on.
    expect(html).toContain('</span>\n<span class="sh__line"');
  });

  it('emits a span even for blank lines so numbering stays aligned', () => {
    const html = highlightToHtml('a\n\nb', 'typescript');
    expect(html.match(/<span class="sh__line"/g)).toHaveLength(3);
  });

  it('references CSS variables rather than literal colors', () => {
    const html = highlightToHtml('const a = 1;', 'typescript');
    expect(html).toContain('var(--sh-keyword)');
    expect(html).not.toMatch(/color:\s*#[0-9a-f]{6}/i);
  });

  it('escapes HTML in plaintext content', () => {
    const html = highlightToHtml('<script>alert(1)</script>', 'plaintext');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;');
  });
});
