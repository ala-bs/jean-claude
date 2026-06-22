export type LogTextSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; url: string };

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION = /[),.:;!?}\]]+$/;

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

export function splitLogTextLinks(text: string): LogTextSegment[] {
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
