export type LogTextSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'file'; text: string; path: string; line?: number };

/**
 * URLs. Excludes whitespace, quoting chars, and the decorative glyph blocks
 * terminal UIs butt straight up against a URL (`│http://localhost:5173/│`,
 * `➜ http://a.com`, `• https://a.com`): box drawing, block elements, geometric
 * shapes, arrows, dingbats and general punctuation.
 *
 * Everything else non-ASCII stays allowed on purpose — raw UTF-8 paths
 * (`https://ja.wikipedia.org/wiki/日本語`) are common in log output, and
 * truncating one yields a link to a real but WRONG page, with no visible clue.
 */
const URL_PATTERN =
  /https?:\/\/[^\s<>"'` -⁯←-⇿─-╿▀-▟■-◿✀-➿]+/gi;
const TRAILING_URL_PUNCTUATION = /[),.:;!?}\]]+$/;
/**
 * A second `scheme://` inside one match means two URLs were glued together by
 * ANSI stripping. The preceding char disambiguates: `=`, `?`, `&`, `/` and `,`
 * mean it is a legitimately nested URL (`?next=http://…`, OAuth redirect_uri),
 * anything else means two separate URLs ran together.
 */
const SECOND_SCHEME_PATTERN = /[^=?&/,](https?:\/\/)/i;

/**
 * File paths in terminal output.
 * - absolute: `/Users/me/project/src/a.ts`, `~/notes/a.ts`
 * - relative: `src/a.ts`, `./src/a.ts`, `../a.ts`
 * Both may carry a `:line` or `:line:col` suffix.
 * A `/` is always required so plain words like `e.g.` or `v1.2.3` are ignored.
 */
const FILE_PATH_PATTERN =
  /(?:\.{1,2}\/|\/|~\/)?(?:[\w.@+-]+\/)+[\w.@+-]+(?::\d+(?::\d+)?)?/g;
const TRAILING_PATH_PUNCTUATION = /[),.:;!?'"}\]]+$/;
/** File-ish tail: `name.ext` with a short alphanumeric extension. */
const FILE_NAME_PATTERN = /\/[\w.@+-]*[\w@+-]\.[A-Za-z][A-Za-z0-9]{0,9}$/;
/** Dates such as `2024/01/02` should not be treated as paths. */
const DATE_LIKE_PATTERN = /^\d{1,4}\/\d{1,2}\/\d{1,4}$/;
/**
 * Chars that could plausibly continue a path, so a match glued to one is bogus.
 * `:` is included because it is overwhelmingly a separator in terminal output
 * (`git@github.com:org/repo.git`, `ETA 00:01/00:02`, `key:value/x`) rather than
 * a real prefix; compilers emit `Error: src/a.ts` with a space anyway.
 */
const PATH_CONTINUATION_CHAR = /[\w.@+~/:-]/;

function trimTrailingPunctuation(value: string): {
  url: string;
  trailingText: string;
} {
  let trailingText = value.match(TRAILING_URL_PUNCTUATION)?.[0] ?? '';
  if (!trailingText) return { url: value, trailingText: '' };

  // Give back a closing paren that balances one inside the URL, so
  // `https://en.wikipedia.org/wiki/Mercury_(planet)` keeps its tail.
  while (trailingText.startsWith(')')) {
    const candidate = value.slice(0, value.length - trailingText.length + 1);
    const opened = (candidate.match(/\(/g) ?? []).length;
    const closed = (candidate.match(/\)/g) ?? []).length;
    if (opened < closed) break;
    trailingText = trailingText.slice(1);
  }

  if (!trailingText) return { url: value, trailingText: '' };

  return {
    url: value.slice(0, -trailingText.length),
    trailingText,
  };
}

/**
 * Splits a plain-text chunk into text + file segments.
 * Relative paths are only linkified when a working directory is known.
 */
function splitFilePaths(text: string, hasWorkingDir: boolean): LogTextSegment[] {
  // Cheap guard: no separator means no path, and skips the scan on long
  // slash-free lines (base64 blobs, progress bars).
  if (!text.includes('/')) return [{ type: 'text', text }];

  const segments: LogTextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(FILE_PATH_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];

    // Ignore matches glued to a preceding path-ish char (e.g. the tail of a URL,
    // or a word run together with a path). Expressed as a deny-list of chars
    // that could plausibly continue a path: an allow-list wrongly rejected the
    // box-drawing/bullet/arrow prefixes terminal UIs emit (`│src/a.ts`, `➜src/a.ts`).
    const prev = start > 0 ? text[start - 1] : '';
    if (prev && PATH_CONTINUATION_CHAR.test(prev)) continue;

    const trailing = raw.match(TRAILING_PATH_PUNCTUATION)?.[0] ?? '';
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    if (!candidate.includes('/')) continue;
    if (DATE_LIKE_PATTERN.test(candidate)) continue;

    const isAbsolute = candidate.startsWith('/') || candidate.startsWith('~/');
    if (!isAbsolute && !hasWorkingDir) continue;

    const lineMatch = candidate.match(/:(\d+)(?::\d+)?$/);
    const withoutLine = lineMatch
      ? candidate.slice(0, candidate.length - lineMatch[0].length)
      : candidate;

    // Relative paths are noisy (`and/or`, `key/value`, `org/repo`), so require
    // a file-looking name or an explicit `:line` suffix before linkifying.
    if (!isAbsolute && !lineMatch && !FILE_NAME_PATTERN.test(withoutLine)) {
      continue;
    }

    const path = withoutLine;
    if (!path) continue;

    if (start > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, start) });
    }

    segments.push({
      type: 'file',
      text: candidate,
      path,
      ...(lineMatch ? { line: Number(lineMatch[1]) } : {}),
    });

    if (trailing) segments.push({ type: 'text', text: trailing });

    cursor = start + raw.length;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }

  return segments;
}

export function splitLogTextLinks(
  text: string,
  options?: { hasWorkingDir?: boolean },
): LogTextSegment[] {
  const urlSegments = splitLogTextUrls(text);
  const segments = urlSegments.flatMap((segment) =>
    segment.type === 'text'
      ? splitFilePaths(segment.text, options?.hasWorkingDir ?? false)
      : [segment],
  );

  return segments.length > 0 ? segments : [{ type: 'text', text }];
}

export type LogTextSpan = LogTextSegment & { start: number; end: number };

/**
 * Same as `splitLogTextLinks`, but each segment carries its character range in
 * the source text. Terminal emitters (Vite, Next, …) style parts of a URL
 * differently (`http://localhost:` + bold `5800` + `/`), so links are detected
 * on the whole line; the ranges let the renderer nest the ANSI styling back
 * inside each link instead of splitting the link across styled elements.
 */
export function splitLogTextLinkSpans(
  text: string,
  options?: { hasWorkingDir?: boolean },
): LogTextSpan[] {
  let cursor = 0;
  return splitLogTextLinks(text, options).map((segment) => {
    const start = cursor;
    cursor += segment.text.length;
    return { ...segment, start, end: cursor };
  });
}

function splitLogTextUrls(text: string): LogTextSegment[] {
  const segments: LogTextSegment[] = [];
  let cursor = 0;

  // Own regex instance: `lastIndex` is rewound below to rescan after a cut.
  const pattern = new RegExp(URL_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;

    // Two adjacent styled URLs join into one match once ANSI codes are removed;
    // cut at the second scheme and resume scanning there so each stays a link.
    const secondScheme = match[0].match(SECOND_SCHEME_PATTERN);
    const rawUrl =
      secondScheme?.index === undefined
        ? match[0]
        : match[0].slice(0, secondScheme.index + 1);
    pattern.lastIndex = start + rawUrl.length;

    const { url, trailingText } = trimTrailingPunctuation(rawUrl);

    if (!url) continue;

    if (start > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, start) });
    }

    segments.push({ type: 'link', text: url, url });

    if (trailingText) {
      segments.push({ type: 'text', text: trailingText });
    }

    cursor = start + rawUrl.length;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', text }];
}
