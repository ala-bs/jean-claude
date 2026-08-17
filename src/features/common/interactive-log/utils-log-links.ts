export type LogTextSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'file'; text: string; path: string; line?: number };

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION = /[),.:;!?}\]]+$/;

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

function trimTrailingPunctuation(value: string): {
  url: string;
  trailingText: string;
} {
  const trailingText = value.match(TRAILING_URL_PUNCTUATION)?.[0] ?? '';
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

    // Ignore matches glued to a preceding non-separator char (e.g. tail of a URL)
    const prev = start > 0 ? text[start - 1] : '';
    if (prev && !/[\s('"[\]{}<=,]/.test(prev)) continue;

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

function splitLogTextUrls(text: string): LogTextSegment[] {
  const segments: LogTextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const rawUrl = match[0];
    const start = match.index ?? 0;
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
