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

const deleteAttachmentFile = vi.fn(async () => true);
const getFileSize = vi.fn(async (_filePath: string) => 1 as number | null);

const fileA = {
  type: 'file' as const,
  filePath: '/proj/.jean-claude/tmp/aaa-pasted-content.md',
  filename: 'pasted-content.md',
};
const fileB = {
  type: 'file' as const,
  filePath: '/proj/.jean-claude/tmp/bbb-notes.md',
  filename: 'notes.md',
};

describe('task prompts store', () => {
  beforeEach(() => {
    vi.resetModules();
    deleteAttachmentFile.mockClear();
    deleteAttachmentFile.mockResolvedValue(true);
    getFileSize.mockClear();
    getFileSize.mockResolvedValue(1);
    vi.stubGlobal('localStorage', createLocalStorage());
    vi.stubGlobal('window', {
      api: { fs: { deleteAttachmentFile, getFileSize } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('persists file attachments alongside the text draft', async () => {
    const { useTaskPromptsStore } = await import('./task-prompts');

    useTaskPromptsStore.getState().setDraft('task-1', 'hello');
    useTaskPromptsStore.getState().setFiles('task-1', [fileA], '/proj');

    const entry = useTaskPromptsStore.getState().drafts['task-1'];
    expect(entry.text).toBe('hello');
    expect(entry.files).toEqual([fileA]);
    expect(entry.projectPath).toBe('/proj');

    const persisted = JSON.parse(localStorage.getItem('task-prompts') ?? '{}');
    expect(persisted.state.drafts['task-1'].files).toEqual([fileA]);
  });

  it('keeps text when files change and keeps files when text changes', async () => {
    const { useTaskPromptsStore } = await import('./task-prompts');

    useTaskPromptsStore.getState().setDraft('task-1', 'hello');
    useTaskPromptsStore.getState().setFiles('task-1', [fileA], '/proj');
    useTaskPromptsStore.getState().setDraft('task-1', 'hello world');

    const entry = useTaskPromptsStore.getState().drafts['task-1'];
    expect(entry.text).toBe('hello world');
    expect(entry.files).toEqual([fileA]);
  });

  it('hydrates pre-existing drafts that have no files field', async () => {
    localStorage.setItem(
      'task-prompts',
      JSON.stringify({
        state: { drafts: { 'task-1': { text: 'old', updatedAt: 1 } } },
        version: 0,
      }),
    );

    const { useTaskPromptsStore } = await import('./task-prompts');
    const entry = useTaskPromptsStore.getState().drafts['task-1'];

    expect(entry.text).toBe('old');
    expect(entry.files).toBeUndefined();
  });

  it('deletes attachment files for pruned orphan drafts only', async () => {
    const { useTaskPromptsStore, pruneOrphanedTaskPrompts } = await import(
      './task-prompts'
    );

    useTaskPromptsStore.getState().setFiles('dead', [fileA], '/proj');
    useTaskPromptsStore.getState().setFiles('alive', [fileB], '/proj');

    pruneOrphanedTaskPrompts(new Set(['alive']));

    await vi.waitFor(() =>
      expect(deleteAttachmentFile).toHaveBeenCalledTimes(1),
    );
    expect(deleteAttachmentFile).toHaveBeenCalledWith('/proj', fileA.filePath);
    expect(useTaskPromptsStore.getState().drafts['alive']).toBeDefined();
    expect(useTaskPromptsStore.getState().drafts['dead']).toBeUndefined();
  });

  it('does not delete files on plain clearDraft (submit path)', async () => {
    const { useTaskPromptsStore, clearTaskPromptDraft } = await import(
      './task-prompts'
    );

    useTaskPromptsStore.getState().setFiles('task-1', [fileA], '/proj');
    clearTaskPromptDraft('task-1');

    expect(deleteAttachmentFile).not.toHaveBeenCalled();
  });

  it('does not attempt deletion when the draft has no project path', async () => {
    const { useTaskPromptsStore, pruneOrphanedTaskPrompts } = await import(
      './task-prompts'
    );

    useTaskPromptsStore.getState().setFiles('task-1', [fileA], null);
    pruneOrphanedTaskPrompts(new Set());

    expect(deleteAttachmentFile).not.toHaveBeenCalled();
  });

  it('applies functional file updates against fresh state', async () => {
    const { useTaskPromptsStore } = await import('./task-prompts');
    const { setFiles } = useTaskPromptsStore.getState();

    // Simulates a multi-file drop: each file resolves independently and both
    // updates run before any re-render, so both must build on fresh state.
    setFiles('task-1', (prev) => [...prev, fileA], '/proj');
    setFiles('task-1', (prev) => [...prev, fileB], '/proj');

    expect(useTaskPromptsStore.getState().drafts['task-1'].files).toEqual([
      fileA,
      fileB,
    ]);
  });

  it('silently drops persisted files whose target no longer exists', async () => {
    const { useTaskPromptsStore, reconcileTaskPromptFiles } = await import(
      './task-prompts'
    );

    useTaskPromptsStore
      .getState()
      .setFiles('task-1', [fileA, fileB], '/proj');

    getFileSize.mockImplementation(async (filePath: string) =>
      filePath === fileA.filePath ? null : 42,
    );

    await reconcileTaskPromptFiles('task-1');

    expect(useTaskPromptsStore.getState().drafts['task-1'].files).toEqual([
      fileB,
    ]);
    // Nothing to reclaim — the file is already gone from disk.
    expect(deleteAttachmentFile).not.toHaveBeenCalled();
  });

  it('keeps files attached while reconciliation is in flight', async () => {
    const { useTaskPromptsStore, reconcileTaskPromptFiles } = await import(
      './task-prompts'
    );

    const fileC = {
      type: 'file' as const,
      filePath: '/proj/.jean-claude/tmp/ccc-late.md',
      filename: 'late.md',
    };

    useTaskPromptsStore.getState().setFiles('task-1', [fileA, fileB], '/proj');

    // fileA is gone; while that check is pending the user attaches fileC.
    let releaseCheck!: () => void;
    const checkStarted = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    getFileSize.mockImplementation(async (filePath: string) => {
      await checkStarted;
      return filePath === fileA.filePath ? null : 42;
    });

    const pending = reconcileTaskPromptFiles('task-1');
    useTaskPromptsStore
      .getState()
      .setFiles('task-1', (prev) => [...prev, fileC], '/proj');
    releaseCheck();
    await pending;

    // Dead file dropped, concurrently attached file preserved.
    expect(useTaskPromptsStore.getState().drafts['task-1'].files).toEqual([
      fileB,
      fileC,
    ]);
  });

  it('does not leave an empty entry behind after a send clears the draft', async () => {
    const { useTaskPromptsStore, clearTaskPromptDraft } = await import(
      './task-prompts'
    );
    const { setDraft, setFiles } = useTaskPromptsStore.getState();

    setDraft('task-1', 'hello');
    setFiles('task-1', [fileA], '/proj');

    // The submit path: panel clears the draft, then the input resets its
    // controlled value and file list.
    clearTaskPromptDraft('task-1');
    setDraft('task-1', '');
    setFiles('task-1', [], '/proj');

    // An empty placeholder would consume an LRU slot and, once the cap is hit,
    // evict a real draft and delete its files.
    expect(useTaskPromptsStore.getState().drafts['task-1']).toBeUndefined();
  });

  it('keeps a draft that has files but no text', async () => {
    const { useTaskPromptsStore } = await import('./task-prompts');
    const { setDraft, setFiles } = useTaskPromptsStore.getState();

    setFiles('task-1', [fileA], '/proj');
    setDraft('task-1', '');

    expect(useTaskPromptsStore.getState().drafts['task-1'].files).toEqual([
      fileA,
    ]);
  });

  it('tolerates malformed persisted files without throwing', async () => {
    localStorage.setItem(
      'task-prompts',
      JSON.stringify({
        state: {
          drafts: {
            'task-1': {
              text: 'x',
              updatedAt: 1,
              files: 'oops',
              projectPath: '/proj',
            },
          },
        },
        version: 0,
      }),
    );

    const { reconcileTaskPromptFiles, pruneOrphanedTaskPrompts } = await import(
      './task-prompts'
    );

    await expect(reconcileTaskPromptFiles('task-1')).resolves.toBeUndefined();
    expect(() => pruneOrphanedTaskPrompts(new Set())).not.toThrow();
  });

  it('reclaims files of drafts evicted by the LRU cap', async () => {
    const { useTaskPromptsStore } = await import('./task-prompts');
    const { setDraft, setFiles } = useTaskPromptsStore.getState();

    // Drafts created in the same millisecond would tie on updatedAt, making
    // which one gets evicted arbitrary. Advance the clock per write.
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1));

    setFiles('oldest', [fileA], '/proj');

    // Fill past MAX_TASKS (100) with more recently touched drafts.
    for (let i = 0; i < 100; i += 1) {
      setDraft(`filler-${i}`, 'x');
    }

    expect(useTaskPromptsStore.getState().drafts['oldest']).toBeUndefined();
    await vi.waitFor(() =>
      expect(deleteAttachmentFile).toHaveBeenCalledWith(
        '/proj',
        fileA.filePath,
      ),
    );
  });
});
