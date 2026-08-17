import { describe, expect, it } from 'vitest';

import { countLines, parseCiLog } from './utils-ci-log-parser';
import type { LogGroup } from './utils-ci-log-parser';

const LOG = [
  '2026-07-24T10:06:51.4137844Z ##[section]Starting: Setup yarn',
  '2026-07-24T10:06:51.4143243Z ==============================================================================',
  '2026-07-24T10:06:51.4143350Z Task         : Command line',
  '2026-07-24T10:06:51.4143408Z Description  : Run a command line script',
  '2026-07-24T10:06:51.4143507Z Version      : 2.276.0',
  '2026-07-24T10:06:51.4143867Z ==============================================================================',
  '2026-07-24T10:06:51.5262411Z Generating script.',
  '2026-07-24T10:06:51.5265980Z [command]/usr/bin/bash --noprofile x.sh',
  '2026-07-24T10:07:05.1799199Z ➤ YN0000: · Yarn 4.12.0',
  '2026-07-24T10:07:05.1819853Z ➤ YN0000: ┌ Resolution step',
  '2026-07-24T10:07:05.6613623Z ➤ YN0000: └ Completed in 0s 479ms',
  '2026-07-24T10:07:05.6625822Z ➤ YN0000: ┌ Post-resolution validation',
  '2026-07-24T10:07:05.6639585Z ➤ YN0060: │ eslint is listed by your project',
  '2026-07-24T10:07:05.7318688Z ➤ YN0000: └ Completed',
  '2026-07-24T10:07:36.0788785Z ',
  '2026-07-24T10:07:36.0859395Z ##[section]Finishing: Setup yarn',
].join('\n');

describe('parseCiLog', () => {
  const parsed = parseCiLog(LOG);
  const section = parsed.nodes[0] as LogGroup;

  it('wraps everything in the section group', () => {
    expect(parsed.nodes).toHaveLength(1);
    expect(section.type).toBe('group');
    expect(section.kind).toBe('section');
    expect(section.title).toBe('Setup yarn');
  });

  it('folds the task metadata banner and drops separators', () => {
    const banner = section.children[0] as LogGroup;
    expect(banner.kind).toBe('banner');
    expect(banner.title).toBe('Task: Command line');
    expect(banner.defaultCollapsed).toBe(true);
    expect(countLines(banner.children)).toBe(2); // Description + Version
  });

  it('detects commands and strips timestamps', () => {
    const cmd = section.children.find(
      (n) => n.type === 'line' && n.kind === 'command',
    );
    expect(cmd).toMatchObject({
      kind: 'command',
      text: '/usr/bin/bash --noprofile x.sh',
      timestamp: '2026-07-24T10:06:51.5265980Z',
    });
  });

  it('groups yarn steps and captures completion detail', () => {
    const yarnGroups = section.children.filter(
      (n): n is LogGroup => n.type === 'group' && n.kind === 'yarn',
    );
    expect(yarnGroups.map((g) => g.title)).toEqual([
      'Resolution step',
      'Post-resolution validation',
    ]);
    expect(yarnGroups[0].detail).toBe('Completed in 0s 479ms');
    expect(yarnGroups[0].defaultCollapsed).toBe(true);
  });

  it('marks yarn warning codes and keeps warning steps expanded', () => {
    const validation = section.children.find(
      (n): n is LogGroup => n.type === 'group' && n.title.startsWith('Post-'),
    )!;
    expect(validation.severity).toBe('warning');
    expect(validation.defaultCollapsed).toBe(false);
    expect(validation.children[0]).toMatchObject({
      severity: 'warning',
      code: 'YN0060',
      text: 'eslint is listed by your project',
    });
    expect(parsed.warningCount).toBe(1);
  });

  it('drops blank lines but keeps raw line count', () => {
    expect(parsed.totalLines).toBe(16);
    expect(countLines(parsed.nodes)).toBe(6);
  });
});

describe('parseCiLog directives', () => {
  it('handles error/warning directives and issue matching', () => {
    const parsed = parseCiLog(
      [
        '2026-01-01T00:00:00.0000000Z ##[error]boom',
        '2026-01-01T00:00:00.0000000Z ##[warning]careful',
        '2026-01-01T00:00:00.0000000Z plain failure text',
      ].join('\n'),
      { errorMessages: new Set(['plain failure text']) },
    );
    expect(parsed.errorCount).toBe(2);
    expect(parsed.warningCount).toBe(1);
    expect(parsed.nodes[0]).toMatchObject({ severity: 'error', text: 'boom' });
  });

  it('ignores unbalanced end markers instead of closing the section', () => {
    const parsed = parseCiLog(
      [
        '##[section]Starting: Build',
        'inside',
        '##[endgroup]',
        'still inside',
        '➤ YN0000: └ Completed',
        'yet inside',
        '##[section]Finishing: Build',
        'after',
      ].join('\n'),
    );
    const section = parsed.nodes[0] as LogGroup;
    expect(section.kind).toBe('section');
    expect(countLines(section.children)).toBe(4); // incl. orphan `└ Completed`
    expect(parsed.nodes[1]).toMatchObject({ type: 'line', text: 'after' });
  });

  it('flags yarn error codes and keeps failing steps expanded', () => {
    const parsed = parseCiLog(
      [
        '➤ YN0000: ┌ Link step',
        "➤ YN0009: │ pkg couldn't be built successfully",
        '➤ YN0000: └ Failed with errors in 1s',
      ].join('\n'),
    );
    const group = parsed.nodes[0] as LogGroup;
    expect(parsed.errorCount).toBe(2);
    expect(group.severity).toBe('error');
    expect(group.defaultCollapsed).toBe(false);
    expect(group.detail).toBe('Failed with errors in 1s');
  });

  it('detects glyph-prefixed error/warning lines', () => {
    const parsed = parseCiLog(
      ['✖ 12 problems (12 errors, 0 warnings)', '⚠ deprecated api', 'FAILED x'].join(
        '\n',
      ),
    );
    expect(parsed.errorCount).toBe(2);
    expect(parsed.warningCount).toBe(1);
  });

  it('does not fold stray Version:/Author: lines into a banner', () => {
    const parsed = parseCiLog(['Version      : 1.2.3', 'next'].join('\n'));
    expect(parsed.nodes.every((n) => n.type === 'line')).toBe(true);
  });

  it('strips ANSI escapes, normalizes CRLF and handles bare [command]', () => {
    const parsed = parseCiLog(
      '\u001b[32mgreen ok\u001b[0m\r\n[command]/bin/sh -c yarn\r\n',
    );
    expect(parsed.nodes[0]).toMatchObject({ text: 'green ok' });
    expect(parsed.nodes[1]).toMatchObject({
      kind: 'command',
      text: '/bin/sh -c yarn',
    });
  });

  it('reports visible vs raw line counts and precomputes group lineCount', () => {
    const parsed = parseCiLog(
      ['##[group]G', 'a', '', 'b', '##[endgroup]'].join('\n'),
    );
    expect(parsed.totalLines).toBe(5);
    expect(parsed.visibleLines).toBe(2);
    expect((parsed.nodes[0] as LogGroup).lineCount).toBe(2);
  });

  it('handles ##[group]/##[endgroup]', () => {
    const parsed = parseCiLog(
      ['##[group]Install', 'a', 'b', '##[endgroup]', 'after'].join('\n'),
    );
    expect(parsed.nodes).toHaveLength(2);
    const group = parsed.nodes[0] as LogGroup;
    expect(group.title).toBe('Install');
    expect(countLines(group.children)).toBe(2);
  });
});
