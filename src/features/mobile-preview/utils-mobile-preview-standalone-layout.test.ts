import { describe, expect, it } from 'vitest';

import { getMobilePreviewStandaloneLayoutClasses } from './utils-mobile-preview-standalone-layout';

describe('mobile preview standalone layout', () => {
  it('keeps preview width and makes device rail compact while hiding closed inspector', () => {
    const layout = getMobilePreviewStandaloneLayoutClasses({
      isStandalone: true,
      isInspectorOpen: false,
    });

    expect(layout.content).toContain('max-[900px]:flex-col');
    expect(layout.deviceRail).toContain('max-[900px]:w-full');
    expect(layout.deviceList).toContain('max-[900px]:overflow-x-auto');
    expect(layout.deviceButton).toContain('max-[900px]:w-[190px]');
    expect(layout.preview).toContain('min-w-[280px]');
    expect(layout.preview).toContain('max-[900px]:min-w-0');
    expect(layout.inspector).toContain('max-[1180px]:hidden');
    expect(layout.inspectorToggle).toContain('min-[1181px]:hidden');
  });

  it('opens narrow inspector as an overlay instead of shrinking preview', () => {
    const layout = getMobilePreviewStandaloneLayoutClasses({
      isStandalone: true,
      isInspectorOpen: true,
    });

    expect(layout.inspector).toContain('max-[1180px]:absolute');
    expect(layout.inspector).toContain('max-[1180px]:flex');
  });
});
