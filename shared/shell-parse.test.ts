import { describe, expect, it } from 'vitest';

import { parseCompoundCommand, stripRedirections } from './shell-parse';

describe('parseCompoundCommand', () => {
  it('surfaces command substitutions without splitting the command text', () => {
    expect(parseCompoundCommand('cmd $(other-cmd args)')).toEqual([
      'other-cmd args',
      'cmd $(other-cmd args)',
    ]);
  });

  it('splits only top-level compound operators', () => {
    expect(
      parseCompoundCommand('echo $(git status && git diff) && pnpm lint'),
    ).toEqual([
      'git status',
      'git diff',
      'echo $(git status && git diff)',
      'pnpm lint',
    ]);
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
    ).toEqual([
      'git status',
      'git diff',
      'echo `git status && git diff`',
      'pnpm lint',
    ]);
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
      ['cat', 'echo $(cat )', 'rm -rf /tmp/y'],
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

describe('parseCompoundCommand flow control and assignments', () => {
  it('drops for-loop scaffolding and keeps body commands', () => {
    expect(
      parseCompoundCommand(
        'cd "$(git rev-parse --show-toplevel)"; for f in a/*.ts b.ts; do echo "$f"; grep -n foo $f; done',
      ),
    ).toEqual([
      'git rev-parse --show-toplevel',
      'cd "$(git rev-parse --show-toplevel)"',
      'echo "$f"',
      'grep -n foo $f',
    ]);
  });

  it('keeps commands nested in a for-loop word list', () => {
    expect(parseCompoundCommand('for f in $(ls src); do cat $f; done')).toEqual([
      'ls src',
      'cat $f',
    ]);
  });

  it('strips if/while/until scaffolding', () => {
    expect(parseCompoundCommand('if [ -f a ]; then rm a; else ls; fi')).toEqual(
      ['[ -f a ]', 'rm a', 'ls'],
    );
    expect(parseCompoundCommand('while read l; do echo $l; done')).toEqual([
      'read l',
      'echo $l',
    ]);
  });

  it('extracts commands from variable assignments', () => {
    expect(parseCompoundCommand('export FOO=$(git rev-parse HEAD)')).toEqual([
      'git rev-parse HEAD',
    ]);
    expect(parseCompoundCommand('FOO=`whoami` && echo done')).toEqual([
      'whoami',
      'echo done',
    ]);
  });

  it('keeps env-prefixed commands without the assignment', () => {
    expect(parseCompoundCommand('NODE_ENV=test CI=1 pnpm test')).toEqual([
      'pnpm test',
    ]);
  });

  it('falls back to the raw command when nothing executable remains', () => {
    expect(parseCompoundCommand('ROOT=/tmp/x')).toEqual(['ROOT=/tmp/x']);
  });
});

describe('parseCompoundCommand keeps substituted commands visible', () => {
  it('keeps substitutions from env-prefixed assignments', () => {
    expect(
      parseCompoundCommand('echo hi && NODE_ENV=$(rm -rf /) pnpm test'),
    ).toEqual(['echo hi', 'rm -rf /', 'pnpm test']);
    expect(parseCompoundCommand('echo hi && local X=$(id) foo')).toEqual([
      'echo hi',
      'id',
      'foo',
    ]);
  });

  it('keeps substitutions hidden in array subscripts', () => {
    expect(parseCompoundCommand('echo hi && arr[$(id)]=1 && ls')).toEqual([
      'echo hi',
      'id',
      'ls',
    ]);
  });

  it('unwraps nested and standalone substitutions', () => {
    expect(parseCompoundCommand('X=$($(id))')).toEqual(['id']);
    expect(parseCompoundCommand('echo hi && $(id)')).toEqual(['echo hi', 'id']);
    expect(parseCompoundCommand('echo hi && $(id)x')).toEqual([
      'echo hi',
      'id',
      '$(id)x',
    ]);
  });

  it('never emits empty parts', () => {
    expect(parseCompoundCommand('echo hi && X=$() && ls')).toEqual([
      'echo hi',
      'ls',
    ]);
  });

  it('strips subshell and function scaffolding without leaving stray parens', () => {
    expect(parseCompoundCommand('echo hi && ( rm -rf /tmp/x )')).toEqual([
      'echo hi',
      'rm -rf /tmp/x',
    ]);
    expect(parseCompoundCommand('echo hi; function f() { rm -rf /tmp/x; }')).toEqual(
      ['echo hi', 'rm -rf /tmp/x'],
    );
  });
});

describe('parseCompoundCommand newlines, arrays and keyword arguments', () => {
  it('treats unquoted newlines as command separators', () => {
    expect(parseCompoundCommand('git status\nrm -rf /')).toEqual([
      'git status',
      'rm -rf /',
    ]);
    expect(parseCompoundCommand('if true\nthen\nrm -rf /\nfi')).toEqual([
      'true',
      'rm -rf /',
    ]);
  });

  it('joins line continuations into one command', () => {
    expect(parseCompoundCommand('git commit \\\n  -m "msg"')).toEqual([
      'git commit -m "msg"',
    ]);
  });

  it('keeps newlines inside quotes', () => {
    expect(parseCompoundCommand('echo "a\nb" && ls')).toEqual([
      'echo "a\nb"',
      'ls',
    ]);
  });

  it('harvests substitutions inside array literals', () => {
    expect(parseCompoundCommand('echo hi && files=(*.ts $(id))')).toEqual([
      'echo hi',
      'id',
    ]);
  });

  it('keeps keywords used as ordinary arguments', () => {
    expect(parseCompoundCommand('echo done')).toEqual(['echo done']);
    expect(parseCompoundCommand('git checkout -- in')).toEqual([
      'git checkout -- in',
    ]);
    expect(parseCompoundCommand('echo hi && ./deploy.sh in')).toEqual([
      'echo hi',
      './deploy.sh in',
    ]);
    expect(parseCompoundCommand('grep -r time .')).toEqual(['grep -r time .']);
  });
});
