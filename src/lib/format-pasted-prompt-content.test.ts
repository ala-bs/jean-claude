import { describe, expect, it } from 'vitest';

import { formatPastedPromptContent } from './format-pasted-prompt-content';

describe('formatPastedPromptContent', () => {
  it('wraps JSON with a json fence', () => {
    expect(formatPastedPromptContent('{"ok":true}')).toBe(
      '```json\n{"ok":true}\n```',
    );
  });

  it('wraps curl commands with a bash fence', () => {
    const curl =
      "curl 'https://example.com' \\" + "\n  -H 'accept: application/json'";

    expect(formatPastedPromptContent(curl)).toBe(`\`\`\`bash\n${curl}\n\`\`\``);
  });

  it('wraps HTTP request blocks with an http fence', () => {
    const request = 'POST /api/tasks HTTP/1.1\nHost: example.com';

    expect(formatPastedPromptContent(request)).toBe(
      `\`\`\`http\n${request}\n\`\`\``,
    );
  });

  it('leaves prose that starts with an HTTP verb unchanged', () => {
    expect(formatPastedPromptContent('GET this done')).toBe('GET this done');
  });

  it('wraps YAML-ish content with a yaml fence', () => {
    const yaml = 'name: Jean-Claude\nenabled: true';

    expect(formatPastedPromptContent(yaml)).toBe(`\`\`\`yaml\n${yaml}\n\`\`\``);
  });

  it('wraps unknown multi-line text in a plain fence', () => {
    const text = 'first line\nsecond line';

    expect(formatPastedPromptContent(text)).toBe(`\`\`\`\n${text}\n\`\`\``);
  });

  it('leaves normal single-line text unchanged', () => {
    expect(formatPastedPromptContent('hello world')).toBe('hello world');
  });

  it('trims normal single-line text', () => {
    expect(formatPastedPromptContent('  hello world\n')).toBe('hello world');
  });

  it('leaves fenced content unchanged', () => {
    const fenced = '```ts\nconst ok = true;\n```';

    expect(formatPastedPromptContent(fenced)).toBe(fenced);
  });

  it('trims fenced content', () => {
    const fenced = '```ts\nconst ok = true;\n```';

    expect(formatPastedPromptContent(`\n${fenced}\n`)).toBe(fenced);
  });

  it('trims before wrapping multi-line text', () => {
    expect(formatPastedPromptContent(' first line\nsecond line\n')).toBe(
      '```\nfirst line\nsecond line\n```',
    );
  });
});
