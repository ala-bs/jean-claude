import { describe, expect, it } from 'vitest';
import {
  buildPastedPromptPlaceholder,
  isPastedPromptFilename,
  removePastedPromptPlaceholder,
  reservePastedPromptFilename,
} from './pasted-prompt-placeholders';

describe('pasted prompt placeholders', () => {
  it('numbers pastes past the highest existing one', () => {
    expect(reservePastedPromptFilename({ counter: { current: 0 } })).toBe(
      'paste-1.md',
    );
    expect(
      reservePastedPromptFilename({ counter: { current: 0 }, files: [] }),
    ).toBe('paste-1.md');
    expect(
      reservePastedPromptFilename({
        counter: { current: 0 },
        files: [
          { filename: 'notes.txt' },
          { filename: 'paste-1.md' },
          { filename: 'paste-3.md' },
        ],
      }),
    ).toBe('paste-4.md');
  });

  it('does not reuse a number freed by removing a chip', () => {
    // paste-1's marker may still be in the text the user typed around.
    expect(
      reservePastedPromptFilename({
        counter: { current: 0 },
        files: [{ filename: 'paste-2.md' }],
      }),
    ).toBe('paste-3.md');
  });

  it('reserves distinct names for pastes whose writes are still in flight', () => {
    // `files` cannot have grown yet: the attachment lands only after the async
    // write resolves. The counter is what keeps the two names apart.
    const counter = { current: 0 };
    const files: { filename: string }[] = [];
    expect(reservePastedPromptFilename({ counter, files })).toBe('paste-1.md');
    expect(reservePastedPromptFilename({ counter, files })).toBe('paste-2.md');
    expect(reservePastedPromptFilename({ counter, files })).toBe('paste-3.md');
  });

  it('does not reuse a number a marker in the draft text already claims', () => {
    // Prompt text copied in from an earlier task brings its markers along.
    expect(
      reservePastedPromptFilename({
        counter: { current: 0 },
        files: [],
        text: 'see [pasted: paste-2.md] above',
      }),
    ).toBe('paste-3.md');
  });

  it('recognises only its own generated names', () => {
    expect(isPastedPromptFilename('paste-12.md')).toBe(true);
    expect(isPastedPromptFilename('paste-.md')).toBe(false);
    expect(isPastedPromptFilename('my-paste-1.md')).toBe(false);
    expect(isPastedPromptFilename('report.md')).toBe(false);
  });

  it('removes a marker that owns its own line without leaving a hole', () => {
    const text = [
      'here are the logs',
      buildPastedPromptPlaceholder('paste-1.md'),
      'and the config',
      buildPastedPromptPlaceholder('paste-2.md'),
    ].join('\n');

    expect(removePastedPromptPlaceholder(text, 'paste-1.md')).toBe(
      'here are the logs\nand the config\n[pasted: paste-2.md]',
    );
  });

  it('removes a marker that sits inline', () => {
    expect(
      removePastedPromptPlaceholder(
        'see [pasted: paste-1.md] for the trace',
        'paste-1.md',
      ),
    ).toBe('see  for the trace');
  });

  it('leaves other markers alone', () => {
    const text = '[pasted: paste-1.md]\n[pasted: paste-10.md]';
    expect(removePastedPromptPlaceholder(text, 'paste-1.md')).toBe(
      '[pasted: paste-10.md]',
    );
  });
});
