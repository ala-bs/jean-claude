// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleMobilePreviewWorkspaceEscape,
  MOBILE_PREVIEW_WORKSPACE_KEYBOARD_LAYER_OPTIONS,
} from '../utils-mobile-preview-workspace';
import {
  RootKeyboardBindings,
  useKeyboardLayer,
} from '@/common/context/keyboard-bindings';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useCommands } from '@/common/hooks/use-commands';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function KeyboardHarness({
  close,
  sendDeviceEscape,
  hiddenTaskCommand,
  globalCommand,
}: {
  close: () => void;
  sendDeviceEscape: () => void;
  hiddenTaskCommand: () => void;
  globalCommand: () => void;
}) {
  const globalLayer = useKeyboardLayer('global-nav');
  const layer = useKeyboardLayer(
    'overlay',
    MOBILE_PREVIEW_WORKSPACE_KEYBOARD_LAYER_OPTIONS,
  );
  useCommands('hidden-task-command-test', [
    {
      label: 'Hidden task action',
      shortcut: 'k',
      handler: hiddenTaskCommand,
    },
  ]);
  useCommands(
    'global-passthrough-command-test',
    [
      {
        label: 'Global action',
        shortcut: 'cmd+p',
        handler: globalCommand,
      },
    ],
    { layer: globalLayer },
  );
  useCommands(
    'mobile-preview-workspace-keyboard-test',
    [
      {
        label: 'Close Mobile Preview',
        shortcut: 'escape',
        handler: () => handleMobilePreviewWorkspaceEscape(close),
      },
    ],
    { layer },
  );

  return (
    <div
      role="application"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Escape') sendDeviceEscape();
      }}
    />
  );
}

describe('mobile preview workspace keyboard binding', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('consumes Escape before the preview input, but leaves other app bindings alive', async () => {
    const close = vi.fn();
    const sendDeviceEscape = vi.fn();
    const hiddenTaskCommand = vi.fn();
    const globalCommand = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <KeyboardHarness
            close={close}
            sendDeviceEscape={sendDeviceEscape}
            hiddenTaskCommand={hiddenTaskCommand}
            globalCommand={globalCommand}
          />
        </RootKeyboardBindings>,
      );
    });

    const previewInput = container.querySelector('[role="application"]');
    expect(previewInput).not.toBeNull();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    previewInput!.dispatchEvent(event);

    expect(close).toHaveBeenCalledOnce();
    expect(sendDeviceEscape).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);

    // The preview now sits next to the feed, so unlayered app commands (feed
    // navigation and friends) must keep working while it is mounted.
    previewInput!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', bubbles: true }),
    );
    expect(hiddenTaskCommand).toHaveBeenCalledOnce();

    previewInput!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
        bubbles: true,
      }),
    );
    expect(globalCommand).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
  });
});
