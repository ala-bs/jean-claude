const HTTP_METHOD_PATTERN =
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?:\/|\*|https?:\/\/)\S*(?:\s+HTTP\/\d(?:\.\d)?)?$/i;
const HTTP_HEADER_PATTERN = /^[A-Za-z0-9-]+:\s*.+$/;
const COMMON_HTTP_HEADER_PATTERN =
  /^(host|accept|content-type|authorization|user-agent|cookie|origin|referer|cache-control|x-[a-z0-9-]+):\s*.+$/i;
const HTML_TAG_PATTERN = /^<([a-z][a-z0-9-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/i;
const XML_PATTERN =
  /^<\?xml\s|^<[A-Za-z_][\w:.-]*(?:\s[^>]*)?>[\s\S]*<\/[A-Za-z_][\w:.-]*>$/;
const YAML_KEY_PATTERN = /^\s*[A-Za-z0-9_-]+:\s*.+$/;
const SHELL_COMMAND_PATTERN =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:pnpm|npm|yarn|git|node|python|python3|docker|kubectl|npx|bun|deno)\b/;

function isJson(value: string): boolean {
  if (!value.startsWith('{') && !value.startsWith('[')) return false;

  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function getPasteLanguage(value: string): string | null {
  const trimmed = value.trim();
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0] ?? '';

  if (isJson(trimmed)) return 'json';
  if (/^curl(?:\s|$)/.test(trimmed)) return 'bash';
  if (
    HTTP_METHOD_PATTERN.test(firstLine) ||
    (lines.length > 1 &&
      lines.some((line) => COMMON_HTTP_HEADER_PATTERN.test(line)) &&
      lines.filter((line) => HTTP_HEADER_PATTERN.test(line)).length >= 2)
  ) {
    return 'http';
  }
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return 'html';
  }
  if (HTML_TAG_PATTERN.test(trimmed)) return 'html';
  if (XML_PATTERN.test(trimmed)) return 'xml';
  if (lines.filter((line) => YAML_KEY_PATTERN.test(line)).length >= 2) {
    return 'yaml';
  }
  if (
    SHELL_COMMAND_PATTERN.test(firstLine) ||
    lines.some((line) => /\\\s*$/.test(line))
  ) {
    return 'bash';
  }

  return null;
}

function isAlreadyFenced(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('```') && trimmed.endsWith('```');
}

export function formatPastedPromptContent(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || isAlreadyFenced(value)) return value;

  const language = getPasteLanguage(trimmed);
  const shouldWrap = language !== null || /\r?\n/.test(value);
  if (!shouldWrap) return value;

  return `\`\`\`${language ?? ''}\n${value}\n\`\`\``;
}
