/**
 * Detection and description helpers for JSON payloads pasted into feed notes.
 *
 * Lives in `shared/` because the main process (feed markdown rendering) and the
 * renderer (paste handling, block card) both need the exact same wording and
 * detection rules. Keep it free of React/BlockNote imports.
 */

/** BlockNote block type used to store a pasted JSON payload. */
export const JSON_BLOCK_TYPE = 'jsonSnippet';

/**
 * Shortest payload we bother detecting. `{"status":"ok"}` (16 chars) stays a
 * normal text paste — below this length a card is more disruptive than useful.
 */
const MIN_JSON_LENGTH = 20;

/**
 * Above this size the payload is left as plain text: it would be stored in a
 * DOM attribute and re-serialized on every keystroke of the note.
 */
export const MAX_JSON_LENGTH = 256 * 1024;

export type JsonSummary = {
  /** `object` for `{...}`, `array` for `[...]`. */
  kind: 'object' | 'array';
  /** Number of top level keys (object) or items (array). */
  entryCount: number;
  /** Short single line preview of the payload. */
  preview: string;
};

export type DetectedJson = JsonSummary & {
  /** Compact JSON, used as the canonical stored value. */
  json: string;
};

/**
 * Returns detection info when `text` is a JSON object or array, otherwise
 * `null`. Scalars (`"hello"`, `42`, `true`) are intentionally ignored so
 * ordinary text pastes are never hijacked.
 */
export function detectJson(text: string): DetectedJson | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_JSON_LENGTH) return null;
  if (trimmed.length > MAX_JSON_LENGTH) return null;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const looksLikeObject = first === '{' && last === '}';
  const looksLikeArray = first === '[' && last === ']';
  if (!looksLikeObject && !looksLikeArray) return null;

  const parsed = parseJsonTolerantly(trimmed);
  if (parsed === PARSE_FAILED) return null;

  const summary = summarizeJsonValue(parsed);
  if (!summary) return null;

  // Re-check the size after serialization, not just on the input: escaping
  // control characters grows the payload (up to 6x for chars without a short
  // escape), and it is the serialized value that lands in a DOM attribute.
  const json = JSON.stringify(parsed);
  if (json.length > MAX_JSON_LENGTH) return null;

  return { ...summary, json };
}

/** Sentinel so `undefined`/`null` parse results stay distinguishable from failure. */
const PARSE_FAILED = Symbol('json-parse-failed');

/**
 * `JSON.parse`, with one retry for the most common real-world paste defect:
 * literal control characters (newlines, tabs) inside string values. Copying a
 * multi-line message field out of a log viewer, DB client or API console keeps
 * the raw newline, which strict JSON forbids — so the payload is obviously JSON
 * to a human but throws "Bad control character in string literal".
 */
function parseJsonTolerantly(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the repaired retry
  }

  try {
    return JSON.parse(escapeControlCharsInStrings(text));
  } catch {
    return PARSE_FAILED;
  }
}

/**
 * Escapes literal control characters that sit inside a JSON string literal.
 * Walks the text tracking string/escape state so control characters in the
 * structural whitespace (between tokens) are left untouched.
 */
function escapeControlCharsInStrings(text: string): string {
  let result = '';
  let inString = false;
  let isEscaped = false;

  for (const char of text) {
    if (isEscaped) {
      result += char;
      isEscaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      isEscaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    const code = char.codePointAt(0) ?? 0;
    if (inString && code < 0x20) {
      result +=
        CONTROL_CHAR_ESCAPES[char] ??
        `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    result += char;
  }

  return result;
}

const CONTROL_CHAR_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/** Summarizes an already-parsed value, or `null` if it isn't an object/array. */
export function summarizeJsonValue(parsed: unknown): JsonSummary | null {
  if (parsed === null || typeof parsed !== 'object') return null;

  if (Array.isArray(parsed)) {
    return {
      kind: 'array',
      entryCount: parsed.length,
      preview: truncate(JSON.stringify(parsed)),
    };
  }

  const keys = Object.keys(parsed as Record<string, unknown>);
  return {
    kind: 'object',
    entryCount: keys.length,
    preview: truncate(keys.join(', ')),
  };
}

/** Summarizes stored JSON text, or `null` when it can't be parsed. */
export function summarizeJsonText(value: unknown): JsonSummary | null {
  if (typeof value !== 'string') return null;

  try {
    return summarizeJsonValue(JSON.parse(value));
  } catch {
    return null;
  }
}

export function formatJsonSize(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  return `${(byteLength / 1024).toFixed(1)} KB`;
}

export function describeJson({ kind, entryCount }: JsonSummary): string {
  const unit =
    kind === 'array'
      ? entryCount === 1
        ? 'item'
        : 'items'
      : entryCount === 1
        ? 'key'
        : 'keys';
  return `JSON ${kind} · ${entryCount} ${unit}`;
}

/** Single-line label used when a note is rendered as markdown (feed previews). */
export function describeJsonBlockProp(value: unknown): string {
  const summary = summarizeJsonText(value);
  return summary ? `{ } ${describeJson(summary)}` : '{ } JSON';
}

/**
 * Decides how a detected JSON paste should be inserted relative to the block
 * the cursor sits in. Pure so the destructive "replace" branch is testable.
 *
 * - `null` — don't intercept, let the editor paste text normally.
 * - `replace` — the block is a genuinely empty, childless text block.
 * - `after` — insert below and leave the existing block untouched.
 */
export function planJsonPasteInsertion({
  block,
  hasSelectedText,
}: {
  block: { type?: string; content?: unknown; children?: unknown };
  hasSelectedText: boolean;
}): 'replace' | 'after' | null {
  // Pasting JSON into a code block is almost certainly deliberate.
  if (block.type === 'codeBlock') return null;
  // Replacing a selection is normal paste semantics we don't reimplement.
  if (hasSelectedText) return null;

  const hasChildren = Array.isArray(block.children) && block.children.length > 0;
  // Only inline-content blocks are safe to drop: images, tables and other
  // `content: 'none'` blocks hold their payload in props, so an empty-looking
  // `content` does NOT mean the block is empty.
  const isInlineBlock = Array.isArray(block.content);
  const isEmpty = isInlineBlock && getInlineText(block.content).trim() === '';

  return isEmpty && !hasChildren ? 'replace' : 'after';
}

/** Joins every text segment of BlockNote inline content, including links. */
function getInlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';

      const record = item as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      // Link inline content nests its text under `content`.
      return getInlineText(record.content);
    })
    .join('');
}

function truncate(value: string, maxLength = 80): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
