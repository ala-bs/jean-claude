import { describe, expect, it } from 'vitest';

import { parsePastedArguments, parsePastedEnvironment } from './global-mcp-input';

describe('global MCP paste parsers', () => {
  it('parses JSON argument arrays', () => {
    expect(parsePastedArguments('["--flag", "a=b"]')).toEqual(['--flag', 'a=b']);
  });

  it('parses any nonempty multiline arguments with CRLF', () => {
    expect(parsePastedArguments('--first\r\n\r\nvalue without equals\r\na=b')).toEqual([
      '--first',
      'value without equals',
      'a=b',
    ]);
  });

  it('parses JSON environment objects', () => {
    expect(parsePastedEnvironment('{"TOKEN":"a=b"}')).toEqual([{ key: 'TOKEN', value: 'a=b' }]);
  });

  it('splits environment values only on first equals', () => {
    expect(parsePastedEnvironment('TOKEN=a=b=c\r\nEMPTY=')).toEqual([
      { key: 'TOKEN', value: 'a=b=c' },
      { key: 'EMPTY', value: '' },
    ]);
  });
});
