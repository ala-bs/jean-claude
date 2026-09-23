import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createLocalStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('new task form store — interaction mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves interaction mode unset on a fresh draft so the project default applies', async () => {
    const { newTaskFormStoreApi } = await import('./new-task-form');

    newTaskFormStoreApi.getState().setDraft('project-1', {
      prompt: 'draft prompt',
    });

    expect(
      newTaskFormStoreApi.getState().drafts['project-1']?.interactionMode,
    ).toBeUndefined();
  });

  // Regression: writing the *resolved* project default back into the draft on
  // an unrelated change (backend switch, preset apply, rate-limit swap) used to
  // pin the mode, so later toggling the project's auto-accept setting was
  // ignored for that draft forever. This drives the real write-back shape —
  // renormalize the draft value, then merge — so reverting the call sites to
  // write the resolved default would fail here.
  it('does not pin a mode when a backend switch is written with mode unset', async () => {
    const { newTaskFormStoreApi } = await import('./new-task-form');
    const { renormalizeDraftInteractionMode } = await import(
      '@/lib/default-interaction-mode'
    );

    newTaskFormStoreApi.getState().setDraft('project-1', {
      prompt: 'half written',
    });

    const before =
      newTaskFormStoreApi.getState().drafts['project-1']?.interactionMode;
    newTaskFormStoreApi.getState().setDraft('project-1', {
      agentBackend: 'opencode',
      interactionMode: renormalizeDraftInteractionMode({
        draftMode: before,
        backend: 'opencode',
      }),
    });

    expect(
      newTaskFormStoreApi.getState().drafts['project-1']?.interactionMode,
    ).toBeUndefined();
    expect(
      newTaskFormStoreApi.getState().drafts['project-1']?.agentBackend,
    ).toBe('opencode');
  });

  // The mirror image: an explicit choice must survive the same write-back, and
  // must be corrected for a backend that cannot express it.
  it('renormalizes an explicit mode for the newly selected backend', async () => {
    const { newTaskFormStoreApi } = await import('./new-task-form');
    const { renormalizeDraftInteractionMode } = await import(
      '@/lib/default-interaction-mode'
    );

    newTaskFormStoreApi.getState().setDraft('project-1', {
      interactionMode: 'ask',
    });

    const before =
      newTaskFormStoreApi.getState().drafts['project-1']?.interactionMode;
    newTaskFormStoreApi.getState().setDraft('project-1', {
      agentBackend: 'opencode',
      interactionMode: renormalizeDraftInteractionMode({
        draftMode: before,
        backend: 'opencode',
      }),
    });

    // opencode has no 'ask' mode, so it collapses to that backend's default.
    expect(
      newTaskFormStoreApi.getState().drafts['project-1']?.interactionMode,
    ).toBe('auto');
  });

  it('keeps an explicitly chosen mode across later unrelated draft writes', async () => {
    const { newTaskFormStoreApi } = await import('./new-task-form');

    newTaskFormStoreApi.getState().setDraft('project-1', {
      interactionMode: 'plan',
    });
    newTaskFormStoreApi.getState().setDraft('project-1', {
      modelPreference: 'default',
    });

    expect(
      newTaskFormStoreApi.getState().drafts['project-1']?.interactionMode,
    ).toBe('plan');
  });
});
