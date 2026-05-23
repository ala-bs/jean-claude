import { describe, expect, it } from 'vitest';

import { parseChangelogFile } from './changelog';

describe('parseChangelogFile', () => {
  it('parses structured entries with scope and nested bullets', () => {
    expect(
      parseChangelogFile(
        `- [feature] [settings]\n  - Added dark mode toggle\n  - Saved preference between launches`,
      ),
    ).toEqual([
      {
        type: 'feature',
        scope: 'settings',
        bullets: [
          'Added dark mode toggle',
          'Saved preference between launches',
        ],
      },
    ]);
  });

  it('keeps backward compatibility with inline legacy entries', () => {
    expect(
      parseChangelogFile(`- [fix] Fixed sidebar collapsing on narrow screens`),
    ).toEqual([
      {
        type: 'fix',
        scope: 'general',
        bullets: ['Fixed sidebar collapsing on narrow screens'],
      },
    ]);
  });
});
