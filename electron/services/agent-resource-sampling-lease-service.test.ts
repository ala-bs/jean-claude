import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { AgentResourceSamplingLeaseService } from './agent-resource-sampling-lease-service';

function createSender(id: number) {
  let destroyListener: (() => void) | undefined;
  let crashListener: (() => void) | undefined;
  let navigationListener:
    | ((details: { isMainFrame: boolean; isSameDocument: boolean }) => void)
    | undefined;
  const sender = {
    id,
    on: vi.fn(
      (
        event: 'render-process-gone' | 'did-start-navigation',
        listener:
          | (() => void)
          | ((details: { isMainFrame: boolean; isSameDocument: boolean }) => void),
      ) => {
        if (event === 'render-process-gone') {
          crashListener = listener as () => void;
        } else {
          navigationListener = listener as typeof navigationListener;
        }
      },
    ),
    once: vi.fn((event: 'destroyed', listener: () => void) => {
      if (event === 'destroyed') destroyListener = listener;
    }),
  };
  return {
    sender: sender as unknown as WebContents,
    on: sender.on,
    once: sender.once,
    crash: () => crashListener?.(),
    destroy: () => destroyListener?.(),
    navigate: (details: { isMainFrame: boolean; isSameDocument: boolean }) =>
      navigationListener?.(details),
  };
}

describe('AgentResourceSamplingLeaseService', () => {
  it('keeps high-frequency sampling while any renderer holds a lease', () => {
    const setHighFrequencySampling = vi.fn();
    const service = new AgentResourceSamplingLeaseService({
      setHighFrequencySampling,
    });
    const first = createSender(1);
    const second = createSender(2);

    service.setSampling(first.sender, true);
    service.setSampling(second.sender, true);
    service.setSampling(first.sender, false);

    expect(setHighFrequencySampling.mock.calls).toEqual([[true]]);

    service.setSampling(second.sender, false);
    expect(setHighFrequencySampling.mock.calls).toEqual([[true], [false]]);
  });

  it('releases a renderer lease when its web contents is destroyed', () => {
    const setHighFrequencySampling = vi.fn();
    const service = new AgentResourceSamplingLeaseService({
      setHighFrequencySampling,
    });
    const renderer = createSender(1);

    service.setSampling(renderer.sender, true);
    renderer.destroy();

    expect(setHighFrequencySampling.mock.calls).toEqual([[true], [false]]);
  });

  it('releases a renderer lease when its renderer process exits', () => {
    const setHighFrequencySampling = vi.fn();
    const service = new AgentResourceSamplingLeaseService({
      setHighFrequencySampling,
    });
    const renderer = createSender(1);

    service.setSampling(renderer.sender, true);
    renderer.crash();

    expect(setHighFrequencySampling.mock.calls).toEqual([[true], [false]]);
  });

  it('releases a renderer lease on full main-frame navigation only', () => {
    const setHighFrequencySampling = vi.fn();
    const service = new AgentResourceSamplingLeaseService({
      setHighFrequencySampling,
    });
    const renderer = createSender(1);

    service.setSampling(renderer.sender, true);
    renderer.navigate({ isMainFrame: true, isSameDocument: true });
    renderer.navigate({ isMainFrame: false, isSameDocument: false });
    expect(setHighFrequencySampling.mock.calls).toEqual([[true]]);

    renderer.navigate({ isMainFrame: true, isSameDocument: false });
    expect(setHighFrequencySampling.mock.calls).toEqual([[true], [false]]);
  });

  it('registers destruction cleanup once per renderer', () => {
    const service = new AgentResourceSamplingLeaseService({
      setHighFrequencySampling: vi.fn(),
    });
    const renderer = createSender(1);

    service.setSampling(renderer.sender, true);
    service.setSampling(renderer.sender, false);
    service.setSampling(renderer.sender, true);

    expect(renderer.once).toHaveBeenCalledTimes(1);
    expect(renderer.on).toHaveBeenCalledTimes(2);
  });
});
