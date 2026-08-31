// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { clearAllDismissedNotices } from './mobile-preview-dismissed-notices-store';
import { useMobilePreviewAutoStart } from './use-mobile-preview-auto-start';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function Harness({
  attemptKey,
  start,
}: {
  attemptKey: string;
  start: () => Promise<unknown>;
}) {
  const { error, retry, dismissError } = useMobilePreviewAutoStart({
    enabled: true,
    attemptKey,
    start,
  });
  if (!error) return null;
  return (
    <>
      <button onClick={retry}>{error}</button>
      <button data-testid="dismiss" onClick={dismissError}>
        dismiss
      </button>
    </>
  );
}

/** Mount a fresh root, as reopening the preview workspace does. */
async function mountHarness(props: {
  attemptKey: string;
  start: () => Promise<unknown>;
}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  return { container, root };
}

describe('useMobilePreviewAutoStart', () => {
  beforeEach(() => {
    // Module-scope store: reset so dismissals never leak between tests.
    clearAllDismissedNotices();
  });

  afterEach(() => {
    clearAllDismissedNotices();
    document.body.innerHTML = '';
  });

  it('attempts a failed launch once and starts a new attempt only on Retry', async () => {
    const start = vi.fn().mockRejectedValue(new Error('stream failed'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness attemptKey="runtime-1:device-1" start={start} />);
    });
    expect(start).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('stream failed');

    await act(async () => {
      root.render(<Harness attemptKey="runtime-1:device-1" start={start} />);
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledOnce();

    await act(async () => {
      container.querySelector('button')!.click();
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
  });

  it('keeps a dismissed error hidden after the preview is closed and reopened', async () => {
    const start = vi.fn().mockRejectedValue(new Error('stream failed'));
    const attemptKey = 'runtime-1:device-1';

    const first = await mountHarness({ attemptKey, start });
    expect(first.container.textContent).toContain('stream failed');

    await act(async () => {
      first.container
        .querySelector<HTMLButtonElement>('[data-testid="dismiss"]')!
        .click();
    });
    expect(first.container.textContent).not.toContain('stream failed');

    // Closing the workspace unmounts the pane entirely.
    await act(async () => first.root.unmount());

    // Reopening remounts it: the attempt re-fires and fails again, but the
    // banner the user already dismissed must not come back.
    const second = await mountHarness({ attemptKey, start });
    expect(start).toHaveBeenCalledTimes(2);
    expect(second.container.textContent).not.toContain('stream failed');

    await act(async () => second.root.unmount());
  });

  it('still surfaces a different failure after an earlier dismissal', async () => {
    const attemptKey = 'runtime-1:device-1';
    const first = await mountHarness({
      attemptKey,
      start: vi.fn().mockRejectedValue(new Error('stream failed')),
    });
    await act(async () => {
      first.container
        .querySelector<HTMLButtonElement>('[data-testid="dismiss"]')!
        .click();
    });
    await act(async () => first.root.unmount());

    const second = await mountHarness({
      attemptKey,
      start: vi.fn().mockRejectedValue(new Error('simulator went away')),
    });
    expect(second.container.textContent).toContain('simulator went away');

    await act(async () => second.root.unmount());
  });

  it('does not suppress a later identical failure on a fresh attempt', async () => {
    const start = vi.fn().mockRejectedValue(new Error('stream failed'));
    const first = await mountHarness({
      attemptKey: 'runtime-1:device-1',
      start,
    });
    await act(async () => {
      first.container
        .querySelector<HTMLButtonElement>('[data-testid="dismiss"]')!
        .click();
    });
    await act(async () => first.root.unmount());

    // A dev server restart / device switch changes the attempt key.
    const second = await mountHarness({
      attemptKey: 'runtime-1:device-2',
      start,
    });
    expect(second.container.textContent).toContain('stream failed');

    await act(async () => second.root.unmount());
  });

});
