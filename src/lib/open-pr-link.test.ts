import { describe, expect, it, vi } from 'vitest';

import { openPrLinkOnModifiedClick } from './open-pr-link';

describe('openPrLinkOnModifiedClick', () => {
  it.each([
    { metaKey: true, ctrlKey: false },
    { metaKey: false, ctrlKey: true },
  ])('opens PR externally for a modified click', (event) => {
    const open = vi.fn();

    expect(
      openPrLinkOnModifiedClick({
        event,
        url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/1',
        open,
      }),
    ).toBe(true);
    expect(open).toHaveBeenCalledWith(
      'https://dev.azure.com/org/project/_git/repo/pullrequest/1',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('preserves normal click behavior', () => {
    const open = vi.fn();

    expect(
      openPrLinkOnModifiedClick({
        event: { metaKey: false, ctrlKey: false },
        url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/1',
        open,
      }),
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('preserves fallback behavior when URL is unavailable', () => {
    const open = vi.fn();

    expect(
      openPrLinkOnModifiedClick({
        event: { metaKey: true, ctrlKey: false },
        open,
      }),
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
