import { beforeEach, describe, expect, it, vi } from 'vitest';

const appMock = { isReady: vi.fn(() => true), quit: vi.fn() };
const dialogMock = { showMessageBoxSync: vi.fn(() => 0) };
const browserWindowMock = { getFocusedWindow: vi.fn(() => null) };

vi.mock('electron', () => ({
  app: appMock,
  dialog: dialogMock,
  BrowserWindow: browserWindowMock,
}));

async function loadModule() {
  vi.resetModules();
  return import('./quit-confirmation');
}

describe('quit confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appMock.isReady.mockReturnValue(true);
    browserWindowMock.getFocusedWindow.mockReturnValue(null);
    dialogMock.showMessageBoxSync.mockReturnValue(0);
  });

  it('proceeds when the user picks Quit', async () => {
    const { confirmQuit } = await loadModule();
    expect(confirmQuit()).toBe(true);
  });

  it('vetoes when the user picks Cancel', async () => {
    dialogMock.showMessageBoxSync.mockReturnValue(1);
    const { confirmQuit } = await loadModule();
    expect(confirmQuit()).toBe(false);
  });

  it('prompts once per quit attempt so every before-quit listener agrees', async () => {
    dialogMock.showMessageBoxSync.mockReturnValue(1);
    const { confirmQuit } = await loadModule();

    // Two listeners in the same synchronous dispatch.
    expect(confirmQuit()).toBe(false);
    expect(confirmQuit()).toBe(false);
    expect(dialogMock.showMessageBoxSync).toHaveBeenCalledTimes(1);

    // A later attempt prompts again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmQuit()).toBe(false);
    expect(dialogMock.showMessageBoxSync).toHaveBeenCalledTimes(2);
  });

  it('skips the prompt for one programmatic quit only', async () => {
    dialogMock.showMessageBoxSync.mockReturnValue(1);
    const { confirmQuit, quitWithoutConfirmation } = await loadModule();

    quitWithoutConfirmation();
    expect(appMock.quit).toHaveBeenCalledTimes(1);
    expect(confirmQuit()).toBe(true);
    expect(dialogMock.showMessageBoxSync).not.toHaveBeenCalled();

    // The flag is one-shot — it must not suppress later prompts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(confirmQuit()).toBe(false);
  });

  it('does not prompt before the app is ready', async () => {
    appMock.isReady.mockReturnValue(false);
    const { confirmQuit } = await loadModule();

    expect(confirmQuit()).toBe(true);
    expect(dialogMock.showMessageBoxSync).not.toHaveBeenCalled();
  });
});
