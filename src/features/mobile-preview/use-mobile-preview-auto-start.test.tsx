// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

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
  const { error, retry } = useMobilePreviewAutoStart({
    enabled: true,
    attemptKey,
    start,
  });
  return error ? <button onClick={retry}>{error}</button> : null;
}

describe('useMobilePreviewAutoStart', () => {
  afterEach(() => {
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
});
