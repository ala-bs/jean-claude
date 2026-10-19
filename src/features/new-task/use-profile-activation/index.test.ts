// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

import { useNewTaskDraftStore } from '@/stores/new-task-draft';

import { useProfileActivation } from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useProfileActivation>;

/**
 * Mounts the hook in a throwaway component and returns a live handle to its
 * latest result, so each test drives the real ref lifecycle.
 */
function mountHook({
  draftKey = 'project-1',
  activate,
  wasTouched = false,
}: {
  draftKey?: string;
  activate: (profileId: string) => Promise<unknown>;
  wasTouched?: boolean;
}) {
  const addToast = vi.fn();
  const userTouchedSelectionRef = { current: wasTouched };
  const updateDraft = vi.fn((update: Record<string, unknown>) => {
    useNewTaskDraftStore.getState().setDraft(draftKey, update);
  });

  let latest: Hook | undefined;
  function Probe() {
    latest = useProfileActivation({
      draftKey,
      updateDraft,
      activate,
      addToast,
      userTouchedSelectionRef,
    });
    return null;
  }

  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });

  if (!latest) throw new Error('hook did not mount');
  const hook = latest;

  return { hook, addToast, updateDraft, userTouchedSelectionRef };
}

const PROFILE_SENTINEL = {
  agentBackend: undefined,
  modelPreference: undefined,
  thinkingEffort: undefined,
  backendModelPresetId: null,
  shouldAutoSelectBackendModelPreset: false,
};

/** Lets every queued microtask (the activation chain) settle. */
async function drain() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('useProfileActivation', () => {
  beforeEach(() => {
    useNewTaskDraftStore.setState({ drafts: {}, selectedProjectId: null });
  });

  describe('feedback', () => {
    it('shows no toast when the activation succeeds', async () => {
      const { hook, addToast } = mountHook({
        activate: vi.fn().mockResolvedValue(undefined),
      });

      hook.selectProfile('profile-a');
      await hook.waitForPendingActivations();
      await drain();

      expect(addToast).not.toHaveBeenCalled();
    });

    it('shows an error toast when the activation fails', async () => {
      const { hook, addToast } = mountHook({
        activate: vi.fn().mockRejectedValue(new Error('Unknown model profile')),
      });

      hook.selectProfile('profile-a');
      await hook.waitForPendingActivations();
      await drain();

      expect(addToast).toHaveBeenCalledWith({
        message: 'Could not switch model profile.',
        type: 'error',
      });
    });

    it('never reports failure for an activation that resolved', async () => {
      const { hook, addToast } = mountHook({
        activate: vi.fn().mockResolvedValue(undefined),
      });

      hook.selectProfile('profile-a');
      hook.selectProfile('profile-b');
      await hook.waitForPendingActivations();
      await drain();

      expect(addToast).not.toHaveBeenCalled();
    });
  });

  describe('draft handling', () => {
    it('clears the step-level model override when a profile is picked', () => {
      useNewTaskDraftStore.getState().setDraft('project-1', {
        agentBackend: 'opencode',
        modelPreference: 'some-model',
        backendModelPresetId: 'preset-1',
        shouldAutoSelectBackendModelPreset: true,
      });

      const { hook } = mountHook({
        activate: vi.fn().mockResolvedValue(undefined),
      });
      hook.selectProfile('profile-a');

      expect(useNewTaskDraftStore.getState().drafts['project-1']).toMatchObject(
        PROFILE_SENTINEL,
      );
    });

    it('keeps the cleared override when the activation succeeds', async () => {
      useNewTaskDraftStore.getState().setDraft('project-1', {
        agentBackend: 'opencode',
        modelPreference: 'some-model',
      });

      const { hook } = mountHook({
        activate: vi.fn().mockResolvedValue(undefined),
      });
      hook.selectProfile('profile-a');
      await hook.waitForPendingActivations();
      await drain();

      expect(useNewTaskDraftStore.getState().drafts['project-1']).toMatchObject(
        PROFILE_SENTINEL,
      );
    });

    it('restores the previous model override when the activation fails', async () => {
      useNewTaskDraftStore.setState({ selectedProjectId: 'project-1' });
      useNewTaskDraftStore.getState().setDraft('project-1', {
        agentBackend: 'opencode',
        modelPreference: 'some-model',
        backendModelPresetId: 'preset-1',
        shouldAutoSelectBackendModelPreset: true,
      });

      const { hook, userTouchedSelectionRef } = mountHook({
        activate: vi.fn().mockRejectedValue(new Error('boom')),
        wasTouched: false,
      });
      hook.selectProfile('profile-a');
      await hook.waitForPendingActivations();
      await drain();

      expect(useNewTaskDraftStore.getState().drafts['project-1']).toMatchObject(
        {
          agentBackend: 'opencode',
          modelPreference: 'some-model',
          backendModelPresetId: 'preset-1',
          shouldAutoSelectBackendModelPreset: true,
        },
      );
      expect(userTouchedSelectionRef.current).toBe(false);
    });

    it('preserves a manual model choice made while the activation ran', async () => {
      const { hook } = mountHook({
        activate: vi.fn().mockRejectedValue(new Error('boom')),
      });

      hook.selectProfile('profile-a');
      // The user picks a model by hand before the activation settles.
      useNewTaskDraftStore.getState().setDraft('project-1', {
        agentBackend: 'claude-code',
      });
      await hook.waitForPendingActivations();
      await drain();

      expect(
        useNewTaskDraftStore.getState().drafts['project-1']?.agentBackend,
      ).toBe('claude-code');
    });

    it('does not roll back when an earlier activation in the burst succeeded', async () => {
      useNewTaskDraftStore.getState().setDraft('project-1', {
        agentBackend: 'opencode',
      });

      const activate = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('boom'));
      const { hook } = mountHook({ activate });

      hook.selectProfile('profile-a');
      hook.selectProfile('profile-b');
      await hook.waitForPendingActivations();
      await drain();

      expect(useNewTaskDraftStore.getState().drafts['project-1']).toMatchObject(
        PROFILE_SENTINEL,
      );
    });
  });

  describe('queueing', () => {
    it('activates profiles in the order they were picked', async () => {
      const order: string[] = [];
      const activate = vi.fn(async (profileId: string) => {
        order.push(`start:${profileId}`);
        await Promise.resolve();
        order.push(`end:${profileId}`);
      });
      const { hook } = mountHook({ activate });

      hook.selectProfile('profile-a');
      hook.selectProfile('profile-b');
      await hook.waitForPendingActivations();
      await drain();

      expect(order).toEqual([
        'start:profile-a',
        'end:profile-a',
        'start:profile-b',
        'end:profile-b',
      ]);
    });

    it('keeps draining the queue after a failure', async () => {
      const activate = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined);
      const { hook } = mountHook({ activate });

      hook.selectProfile('profile-a');
      await drain();
      hook.selectProfile('profile-b');
      await hook.waitForPendingActivations();
      await drain();

      expect(activate).toHaveBeenNthCalledWith(1, 'profile-a');
      expect(activate).toHaveBeenNthCalledWith(2, 'profile-b');
    });

    it('reports whether it had to wait for a pending activation', async () => {
      const { hook } = mountHook({
        activate: vi.fn().mockResolvedValue(undefined),
      });

      hook.selectProfile('profile-a');
      await expect(hook.waitForPendingActivations()).resolves.toBe(true);
      await drain();
      await expect(hook.waitForPendingActivations()).resolves.toBe(false);
    });
  });

  describe('pending profile tracking', () => {
    it('exposes the profile being activated so the switcher can show it', () => {
      const { hook } = mountHook({
        activate: vi.fn().mockResolvedValue(undefined),
      });

      hook.selectProfile('profile-a');

      expect(hook.pendingProfileRef.current).toEqual({
        draftKey: 'project-1',
        profileId: 'profile-a',
      });
    });

    it('stops reporting a pending profile once its activation fails', async () => {
      const { hook } = mountHook({
        activate: vi.fn().mockRejectedValue(new Error('boom')),
      });

      hook.selectProfile('profile-a');
      await hook.waitForPendingActivations();
      await drain();

      expect(hook.pendingProfileRef.current).toBeNull();
    });

    it('clears the pending profile on request', () => {
      const { hook } = mountHook({
        activate: vi.fn().mockResolvedValue(undefined),
      });

      hook.selectProfile('profile-a');
      hook.clearPendingProfile();

      expect(hook.pendingProfileRef.current).toBeNull();
    });
  });
});
