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

describe('new task draft store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes the draft entry when clearing a draft', async () => {
    const { useNewTaskDraftStore } = await import('./new-task-draft');

    useNewTaskDraftStore.getState().setDraft('project-1', {
      prompt: 'draft prompt',
      workItemIds: ['123'],
    });

    useNewTaskDraftStore.getState().clearDraft('project-1');

    expect(
      useNewTaskDraftStore.getState().drafts['project-1'],
    ).toBeUndefined();
  });

  it('strips image placeholders from the prompt it persists, since the images themselves are not persisted', async () => {
    const { useNewTaskDraftStore } = await import('./new-task-draft');

    useNewTaskDraftStore.getState().setDraft('project-1', {
      prompt:
        'compare\n\n![a.png](jc-image://a3f9k2 =420x)\n\nwith\n\n![b.png](jc-image://7c1e90 =420x)',
      images: [
        {
          type: 'image',
          data: 'AAAA',
          mimeType: 'image/png',
          filename: 'a.png',
          placeholderToken: 'a3f9k2',
        },
      ],
    });

    const persisted = JSON.parse(
      localStorage.getItem('new-task-draft') ?? '{}',
    );
    const draft = persisted.state.drafts['project-1'];

    // No image survives persistence...
    expect(draft.images).toBeUndefined();
    // ...so no dangling marker may survive either.
    expect(draft.prompt).not.toContain('jc-image://');
    expect(draft.prompt).toBe('compare\n\n\nwith\n');

    // In-memory state keeps both, so an unreloaded draft still works.
    const live = useNewTaskDraftStore.getState().drafts['project-1'];
    expect(live?.prompt).toContain('jc-image://a3f9k2');
    expect(live?.images).toHaveLength(1);
  });

  it('preserves every byte the user typed away from a marker', async () => {
    const { useNewTaskDraftStore } = await import('./new-task-draft');

    // Leading indent, a deliberate 4-newline run, and a markdown hard break
    // (two trailing spaces) all sit far from the image and must survive.
    useNewTaskDraftStore.getState().setDraft('project-1', {
      prompt:
        '  # notes\n\n\n\nline one  \nline two\n\n![a.png](jc-image://a3f9k2 =420x)',
      images: [
        {
          type: 'image',
          data: 'AAAA',
          mimeType: 'image/png',
          filename: 'a.png',
          placeholderToken: 'a3f9k2',
        },
      ],
    });

    const persisted = JSON.parse(
      localStorage.getItem('new-task-draft') ?? '{}',
    );
    expect(persisted.state.drafts['project-1'].prompt).toBe(
      '  # notes\n\n\n\nline one  \nline two\n',
    );
  });

  it('leaves a prompt without placeholders untouched', async () => {
    const { useNewTaskDraftStore } = await import('./new-task-draft');

    useNewTaskDraftStore.getState().setDraft('project-1', {
      prompt: 'plain   \n\n\nprompt with ![real](https://x/y.png)',
    });

    const persisted = JSON.parse(
      localStorage.getItem('new-task-draft') ?? '{}',
    );
    expect(persisted.state.drafts['project-1'].prompt).toBe(
      'plain   \n\n\nprompt with ![real](https://x/y.png)',
    );
  });
});
