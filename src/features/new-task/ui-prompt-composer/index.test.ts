// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { PromptImagePart } from '@shared/agent-backend-types';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';

import { PromptComposer } from './index';

const { processImageFileMock } = vi.hoisted(() => ({
  processImageFileMock: vi.fn(),
}));

vi.mock('@/lib/image-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/image-utils')>();
  return { ...actual, processImageFile: processImageFileMock };
});

let editorPasteHandler: ((event: ClipboardEvent) => void) | undefined;
/** Text the composer asked the editor to insert at the caret, in order. */
let editorInserts: string[] = [];

vi.mock('@/common/ui/handlebars-editor', () => ({
  HandlebarsEditor: (props: {
    onPaste?: (event: ClipboardEvent) => void;
    apiRef?: {
      current: { insertAtCursor: (text: string) => string | null } | null;
    };
  }) => {
    editorPasteHandler = props.onPaste;
    if (props.apiRef) {
      props.apiRef.current = {
        insertAtCursor: (text: string) => {
          editorInserts.push(text);
          return editorInserts.join('\n');
        },
      };
    }
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
        createElement(
          RootKeyboardBindings,
          null,
          createElement(PromptComposer, {
          template: '',
          workItems: [],
          images,
          onTemplateChange: vi.fn(),
          onBack: vi.fn(),
          onImageAttach: vi.fn(),
          onImageRemove: vi.fn(),
        }),
        ),
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
      'paste-1.md',
      pasted,
    );
    expect(onFileAttach).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file', filename: 'paste-1.md' }),
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

describe('PromptComposer image placeholders', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderComposer = async (onImageAttach: (i: PromptImagePart) => void) => {
    await act(async () => {
      root.render(
        createElement(PromptComposer, {
          template: '',
          workItems: [],
          onTemplateChange: vi.fn(),
          onBack: vi.fn(),
          projectRoot: '/repo',
          images: [],
          onImageAttach,
        }),
      );
    });
  };

  const pasteImages = (names: string[]) => {
    const event = {
      clipboardData: {
        items: names.map((name) => ({
          type: 'image/png',
          getAsFile: () =>
            new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' }),
        })),
        files: [],
        getData: () => '',
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
    editorInserts = [];
    // Stand in for canvas decode + AVIF encode, which happy-dom cannot run.
    processImageFileMock.mockReset();
    processImageFileMock.mockImplementation(
      async (
        file: File,
        onAttach: (image: PromptImagePart) => void,
      ) => {
        onAttach({
          type: 'image',
          data: 'AAAA',
          mimeType: 'image/png',
          filename: file.name,
        });
      },
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
    vi.restoreAllMocks();
  });

  it('anchors each pasted image with its own marker at the caret', async () => {
    const onImageAttach = vi.fn();
    await renderComposer(onImageAttach);
    expect(editorPasteHandler).toBeTypeOf('function');

    const event = pasteImages(['first.png', 'second.png']);
    await act(async () => {});

    expect(event.preventDefault).toHaveBeenCalled();

    // One marker per image, inserted in paste order, naming the right file.
    expect(editorInserts).toHaveLength(2);
    expect(editorInserts[0]).toMatch(
      /^!\[first\.png\]\(jc-image:\/\/[A-Za-z0-9_-]+\)$/,
    );
    expect(editorInserts[1]).toMatch(
      /^!\[second\.png\]\(jc-image:\/\/[A-Za-z0-9_-]+\)$/,
    );

    // Distinct tokens, or two images would resolve to one slot.
    const tokens = editorInserts.map(
      (marker) => /jc-image:\/\/([A-Za-z0-9_-]+)/.exec(marker)?.[1],
    );
    expect(tokens[0]).not.toBe(tokens[1]);

    // Each attached image carries the token of its own marker.
    expect(onImageAttach).toHaveBeenCalledTimes(2);
    const attached = onImageAttach.mock.calls.map(([image]) => image);
    expect(attached[0].placeholderToken).toBe(tokens[0]);
    expect(attached[1].placeholderToken).toBe(tokens[1]);
  });

  it('rolls the marker back when the image fails to decode', async () => {
    const onImageAttach = vi.fn();
    const onTemplateChange = vi.fn();
    // Report a failure instead of attaching, as an oversized/corrupt file does.
    processImageFileMock.mockImplementation(
      async (
        _file: File,
        _onAttach: (image: PromptImagePart) => void,
        onError: (message: string) => void,
      ) => {
        onError('Image is too large');
      },
    );

    await act(async () => {
      root.render(
        createElement(PromptComposer, {
          template: '',
          workItems: [],
          onTemplateChange,
          onBack: vi.fn(),
          projectRoot: '/repo',
          images: [],
          onImageAttach,
        }),
      );
    });

    pasteImages(['broken.png']);
    await act(async () => {});

    expect(onImageAttach).not.toHaveBeenCalled();
    // The marker went in, so it must come back out rather than point at an
    // image that was never attached.
    expect(editorInserts).toHaveLength(1);
    const rolledBack = onTemplateChange.mock.calls.at(-1)?.[0];
    expect(rolledBack).not.toContain('jc-image://');
  });
});
