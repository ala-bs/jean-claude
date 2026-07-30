// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { PromptImagePart } from '@shared/agent-backend-types';

import { PromptComposer } from './index';

let editorPasteHandler: ((event: ClipboardEvent) => void) | undefined;

vi.mock('@/common/ui/handlebars-editor', () => ({
  HandlebarsEditor: (props: { onPaste?: (event: ClipboardEvent) => void }) => {
    editorPasteHandler = props.onPaste;
    return null;
  },
}));

const GIF_CONTENT = `NEW_TASK_GIF_CONTENT_${'A'.repeat(100_000)}`;
const BASE64_SENTINEL = btoa(GIF_CONTENT);
const images: PromptImagePart[] = [
  {
    type: 'image',
    data: BASE64_SENTINEL,
    mimeType: 'image/gif',
    filename: 'demo.gif',
  },
];

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe('PromptComposer image previews', () => {
  let container: HTMLDivElement;
  let root: Root;
  const createObjectUrl = vi.fn(
    (_blob: Blob) => 'blob:new-task-gif-preview',
  );
  const revokeObjectUrl = vi.fn();

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
    vi.stubGlobal('URL', {
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('wires GIF attachments through Blob thumbnails and lightbox previews', async () => {
    vi.useFakeTimers();

    await act(async () => {
      root.render(
        createElement(PromptComposer, {
          template: '',
          workItems: [],
          images,
          onTemplateChange: vi.fn(),
          onBack: vi.fn(),
          onImageAttach: vi.fn(),
          onImageRemove: vi.fn(),
        }),
      );
    });

    expect(container.textContent).toContain('demo.gif');
    expect(container.querySelector('img[alt="demo.gif"]')).toBeNull();
    expect(
      container.querySelector('button[aria-label="Remove demo.gif"]'),
    ).not.toBeNull();
    expect(document.body.innerHTML).not.toContain(BASE64_SENTINEL);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const gifBlob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(gifBlob.type).toBe('image/gif');
    expect(await gifBlob.text()).toBe(GIF_CONTENT);
    const previewButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview demo.gif"]',
    );
    if (!previewButton) throw new Error('Preview button not found');
    expect(previewButton.querySelector<HTMLImageElement>('img')?.src).toBe(
      'blob:new-task-gif-preview#jc-mime=image%2Fgif',
    );

    await act(async () => previewButton.click());

    expect(
      Array.from(
        document.body.querySelectorAll<HTMLImageElement>('img[alt="demo.gif"]'),
        (element) => element.src,
      ),
    ).toEqual([
      'blob:new-task-gif-preview#jc-mime=image%2Fgif',
      'blob:new-task-gif-preview#jc-mime=image%2Fgif',
    ]);
    expect(document.body.innerHTML).not.toContain(BASE64_SENTINEL);
  });
});

describe('PromptComposer large paste', () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeAttachmentFile = vi.fn(async () => '/repo/.jc/pasted-content.md');

  const renderComposer = async (onFileAttach: () => void) => {
    await act(async () => {
      root.render(
        createElement(PromptComposer, {
          template: '',
          workItems: [],
          onTemplateChange: vi.fn(),
          onBack: vi.fn(),
          projectRoot: '/repo',
          files: [],
          onFileAttach,
        }),
      );
    });
  };

  const paste = (text: string) => {
    const event = {
      clipboardData: {
        items: [],
        files: [],
        getData: () => text,
      },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
    editorPasteHandler?.(event);
    return event;
  };

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    editorPasteHandler = undefined;
    writeAttachmentFile.mockClear();
    vi.stubGlobal('window', window);
    Object.assign(window, { api: { fs: { writeAttachmentFile } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches oversized pasted content as a file instead of inserting it', async () => {
    const onFileAttach = vi.fn();
    await renderComposer(onFileAttach);
    expect(editorPasteHandler).toBeTypeOf('function');

    const pasted = 'x'.repeat(20_000);
    const event = paste(pasted);
    await act(async () => {});

    expect(event.preventDefault).toHaveBeenCalled();
    expect(writeAttachmentFile).toHaveBeenCalledWith(
      '/repo',
      'pasted-content.md',
      pasted,
    );
    expect(onFileAttach).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file', filename: 'pasted-content.md' }),
    );
  });

  it('leaves small pastes to the editor', async () => {
    const onFileAttach = vi.fn();
    await renderComposer(onFileAttach);

    const event = paste('hello');
    await act(async () => {});

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(writeAttachmentFile).not.toHaveBeenCalled();
    expect(onFileAttach).not.toHaveBeenCalled();
  });
});
