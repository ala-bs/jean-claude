import { describe, expect, it } from 'vitest';

import { parseCompoundCommand, stripRedirections } from './shell-parse';

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

  it('does not strip redirection-like text inside quotes', () => {
    const cmd =
      "perl -0pi -e 's/<<<<<<< HEAD(.*?)>>>>>>> main/$2/gs' a.ts; grep -c '<<<<<<<' a.ts; git diff main | head -40";
    expect(parseCompoundCommand(cmd)).toEqual([
      "perl -0pi -e 's/<<<<<<< HEAD(.*?)>>>>>>> main/$2/gs' a.ts",
      "grep -c '<<<<<<<' a.ts",
      'git diff main',
      'head -40',
    ]);
  });

  it('keeps quoted content intact while stripping real redirections', () => {
    expect(stripRedirections('echo "a  >  b" > /dev/null')).toBe(
      'echo "a  >  b"',
    );
  });

  it('consumes quoted redirection targets as a whole', () => {
    expect(parseCompoundCommand("cat > 'a b' ; rm -rf /tmp/x")).toEqual([
      'cat',
      'rm -rf /tmp/x',
    ]);
    expect(parseCompoundCommand('echo a > "out file"; rm -rf /tmp/x')).toEqual([
      'echo a',
      'rm -rf /tmp/x',
    ]);
  });

  it('does not eat the closing paren of a command substitution', () => {
    expect(parseCompoundCommand('echo $(cat >/tmp/x) && rm -rf /tmp/y')).toEqual(
      ['echo $(cat )', 'rm -rf /tmp/y'],
    );
  });

  it('strips fd duplication and close forms', () => {
    expect(stripRedirections('cmd 2>&1')).toBe('cmd');
    expect(stripRedirections('cmd 2>&-')).toBe('cmd');
    expect(stripRedirections('cmd &>>log && other')).toBe('cmd && other');
    expect(stripRedirections('cmd >>log; other')).toBe('cmd ; other');
    expect(stripRedirections('cmd <<<"hi there"; other')).toBe('cmd ; other');
  });

  it('preserves escaped operators', () => {
    expect(parseCompoundCommand('echo \\> foo && ls')).toEqual([
      'echo \\> foo',
      'ls',
    ]);
  });
});
