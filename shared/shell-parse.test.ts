import { describe, expect, it } from 'vitest';

import { parseCompoundCommand } from './shell-parse';

describe('parseCompoundCommand', () => {
  it('does not split command substitutions', () => {
    expect(parseCompoundCommand('cmd $(other-cmd args)')).toEqual([
      'cmd $(other-cmd args)',
    ]);
  });

  it('splits only top-level compound operators', () => {
    expect(
      parseCompoundCommand('echo $(git status && git diff) && pnpm lint'),
    ).toEqual(['echo $(git status && git diff)', 'pnpm lint']);
  });

  it('keeps quoted operators inside same command', () => {
    expect(parseCompoundCommand('echo "a && b" && echo "c | d"')).toEqual([
      'echo "a && b"',
      'echo "c | d"',
    ]);
  });

  it('keeps backtick substitutions intact', () => {
    expect(
      parseCompoundCommand('echo `git status && git diff` && pnpm lint'),
    ).toEqual(['echo `git status && git diff`', 'pnpm lint']);
  });

  it('strips redirections before splitting', () => {
    expect(
      parseCompoundCommand('pnpm lint --fix 2>&1 && pnpm ts-check'),
    ).toEqual(['pnpm lint --fix', 'pnpm ts-check']);
  });
});
