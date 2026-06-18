import { describe, expect, it } from 'vitest';

import { parseRunCommandLogBatch } from './utils-run-command-log-parser';

describe('parseRunCommandLogBatch', () => {
  it('keeps output without newline as pending line', () => {
    const result = parseRunCommandLogBatch({
      trailingText: '',
      stream: 'stdout',
      text: 'building...',
      timestamp: 1,
    });

    expect(result.completedLines).toEqual([]);
    expect(result.pendingLine).toMatchObject({ line: 'building...' });
    expect(result.trailingText).toBe('building...');
  });

  it('converts pending text into completed line when newline arrives', () => {
    const result = parseRunCommandLogBatch({
      trailingText: 'building...',
      stream: 'stdout',
      text: 'done\nnext',
      timestamp: 2,
    });

    expect(result.completedLines.map((line) => line.line)).toEqual([
      'building...done',
    ]);
    expect(result.pendingLine?.line).toBe('next');
    expect(result.trailingText).toBe('next');
  });

  it('normalizes crlf and carriage-return overwrites', () => {
    const result = parseRunCommandLogBatch({
      trailingText: '',
      stream: 'stdout',
      text: '10%\r20%\r100%\r\ndone\r\n',
      timestamp: 3,
    });

    expect(result.completedLines.map((line) => line.line)).toEqual([
      '100%',
      'done',
    ]);
    expect(result.pendingLine).toBeNull();
    expect(result.trailingText).toBe('');
  });

  it('normalizes crlf split across batches', () => {
    const first = parseRunCommandLogBatch({
      trailingText: '',
      stream: 'stdout',
      text: 'hello\r',
      timestamp: 4,
    });

    const second = parseRunCommandLogBatch({
      trailingText: first.trailingText,
      stream: 'stdout',
      text: '\n',
      timestamp: 5,
    });

    expect(second.completedLines.map((line) => line.line)).toEqual(['hello']);
    expect(second.pendingLine).toBeNull();
    expect(second.trailingText).toBe('');
  });

  it('compacts carriage-return pending output', () => {
    const result = parseRunCommandLogBatch({
      trailingText: '',
      stream: 'stdout',
      text: '10%\r20%\r30%',
      timestamp: 6,
    });

    expect(result.completedLines).toEqual([]);
    expect(result.pendingLine?.line).toBe('30%');
    expect(result.trailingText).toBe('30%');
  });

  it('keeps dangling carriage return for split crlf', () => {
    const result = parseRunCommandLogBatch({
      trailingText: '',
      stream: 'stdout',
      text: '10%\r20%\r',
      timestamp: 7,
    });

    expect(result.completedLines).toEqual([]);
    expect(result.pendingLine?.line).toBe('20%');
    expect(result.trailingText).toBe('20%\r');
  });
});
