import { describe, expect, it } from 'vitest';

import { isDefaultAppFile } from './default-app-extensions';

describe('isDefaultAppFile', () => {
  it('routes known media/document types to the default app', () => {
    expect(isDefaultAppFile('/tmp/shot.png')).toBe(true);
    expect(isDefaultAppFile('/tmp/report.pdf')).toBe(true);
    expect(isDefaultAppFile('/tmp/clip.mp4')).toBe(true);
    expect(isDefaultAppFile('/tmp/bundle.zip')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isDefaultAppFile('/tmp/IMG.PNG')).toBe(true);
  });

  it('uses the last extension for multi-dot names', () => {
    expect(isDefaultAppFile('/tmp/archive.tar.gz')).toBe(true);
    expect(isDefaultAppFile('/tmp/component.test.ts')).toBe(false);
  });

  it('routes source files, dotfiles and extensionless files to the editor', () => {
    expect(isDefaultAppFile('/repo/src/index.tsx')).toBe(false);
    expect(isDefaultAppFile('/repo/.gitignore')).toBe(false);
    expect(isDefaultAppFile('/repo/Makefile')).toBe(false);
  });

  it('ignores dots in parent directories', () => {
    expect(isDefaultAppFile('/repo/v1.2/Makefile')).toBe(false);
    expect(isDefaultAppFile('/repo/v1.2/shot.png')).toBe(true);
  });

  it('handles windows separators', () => {
    expect(isDefaultAppFile('C:\\shots\\img.png')).toBe(true);
    expect(isDefaultAppFile('C:\\v1.2\\Makefile')).toBe(false);
  });

  it('rejects executables', () => {
    expect(isDefaultAppFile('/tmp/evil.command')).toBe(false);
    expect(isDefaultAppFile('/tmp/evil.exe')).toBe(false);
    expect(isDefaultAppFile('/tmp/Evil.app')).toBe(false);
  });
});
