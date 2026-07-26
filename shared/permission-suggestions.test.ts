import { describe, expect, it } from 'vitest';

import { buildBashSuggestions } from './permission-suggestions';

const patterns = (command: string): string[] =>
  buildBashSuggestions(command).map((suggestion) => suggestion.pattern);

describe('buildBashSuggestions', () => {
  it('always offers the exact command, glob-escaped', () => {
    expect(patterns('ls *.ts')[0]).toBe('ls \\*.ts');
    expect(buildBashSuggestions('ls *.ts')[0].label).toBe('ls *.ts');
  });

  it('offers a broad pattern only for read-only binaries', () => {
    expect(patterns('grep -rn foo src')).toEqual(['grep -rn foo src', 'grep *']);
    // sed can edit in place (-i), so it must never be widened
    expect(patterns('sed -n 1,5p file.ts')).toEqual(['sed -n 1,5p file.ts']);
  });

  it('offers a verb-scoped pattern only for safe subcommands', () => {
    expect(patterns('git show stash@{0}:a.ts')).toEqual([
      'git show stash@{0}:a.ts',
      'git show *',
    ]);
    expect(patterns('git push --force')).toEqual(['git push --force']);
  });

  it('never widens package managers or container/cloud CLIs', () => {
    for (const command of [
      'pnpm lint --fix',
      'npm run build',
      'npx tsc',
      'docker run -v /:/host alpine',
      'kubectl delete pod x',
      'make deploy',
      'systemctl restart nginx',
      'aws s3 rm s3://bucket',
    ]) {
      expect(patterns(command)).toEqual([command]);
    }
  });

  it('detects dangerous binaries behind wrappers', () => {
    expect(patterns('xargs rm -rf build')).toEqual(['xargs rm -rf build']);
    expect(patterns('env rm -rf x')).toEqual(['env rm -rf x']);
    expect(patterns('time /bin/rm -rf x')).toEqual(['time /bin/rm -rf x']);
    expect(patterns('doas ls /root')).toEqual(['doas ls /root']);
  });

  it('ignores env-var prefixes and binary paths', () => {
    expect(patterns('FOO=1 /usr/bin/cat a.ts')).toContain('cat *');
  });

  it('returns nothing for an empty command', () => {
    expect(buildBashSuggestions('   ')).toEqual([]);
  });
});
