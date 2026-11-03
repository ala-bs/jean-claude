// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { processAttachmentFile } from '@/lib/file-attachment-utils';
import { getQuestionDraftKey, useTaskMessagesStore } from '@/stores/task-messages';
import { QuestionContextReminder, QuestionOptions } from '.';

vi.mock('@/lib/file-attachment-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-attachment-utils')>()),
  processAttachmentFile: vi.fn(),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

describe('QuestionContextReminder', () => {
  it('renders Markdown as assistant context', () => {
    const markup = renderToStaticMarkup(
      <RootKeyboardBindings>
        <QuestionContextReminder content="**Current constraint:** keep scope small." />
      </RootKeyboardBindings>,
    );

    expect(markup).toContain('<aside');
    expect(markup).toContain('Context');
    expect(markup).toMatch(/<strong[^>]*>Current constraint:<\/strong>/);
    expect(markup).toContain('keep scope small.');
  });

  it('renders nothing when omitted', () => {
    expect(
      renderToStaticMarkup(<QuestionContextReminder />),
    ).toBe('');
  });
});

describe('QuestionOptions', () => {
  it('keeps submission blocked after remount until a slow file copy finishes', async () => {
    const key = getQuestionDraftKey('task-1', 'request-slow-copy');
    useTaskMessagesStore.setState({
      questionDrafts: {
        [key]: {
          answers: { 'First?': 'My answer' },
          otherAnswers: {},
          notes: {},
        },
      },
      questionFileUploads: {},
    });
    const file = {
      type: 'file' as const,
      filename: 'spec.txt',
      filePath: '/repo/.jean-claude/tmp/spec.txt',
    };
    let finishCopy: (() => void) | undefined;
    vi.mocked(processAttachmentFile).mockImplementation(
      (_source, _root, onAttach) =>
        new Promise<void>((resolve) => {
          finishCopy = () => {
            onAttach(file);
            resolve();
          };
        }),
    );
    const onRespond = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    const form = (
      <RootKeyboardBindings>
        <QuestionOptions
          request={{
            taskId: 'task-1',
            requestId: 'request-slow-copy',
            questions: [{
              key: 'First?',
              type: 'text',
              question: 'First?',
              header: 'First',
              multiSelect: false,
              options: [],
            }],
          }}
          projectRoot="/repo"
          onRespond={onRespond}
        />
      </RootKeyboardBindings>
    );

    try {
      await act(async () => root.render(form));
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['spec'], 'spec.txt')],
      });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      expect(useTaskMessagesStore.getState().questionFileUploads[key]).toBe(1);

      await act(async () => root.render(null));
      await act(async () => root.render(form));
      const submit = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Submit answers'),
      ) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      await act(async () => submit.click());
      expect(onRespond).not.toHaveBeenCalled();

      await act(async () => finishCopy?.());
      expect(useTaskMessagesStore.getState().questionFileUploads[key]).toBeUndefined();
      expect(useTaskMessagesStore.getState().questionDrafts[key]?.files).toEqual({
        'First?': [file],
      });
    } finally {
      await act(async () => root.unmount());
      vi.mocked(processAttachmentFile).mockReset();
    }
  });

  it('offers a separate file picker for each answer', () => {
    const markup = renderToStaticMarkup(
      <RootKeyboardBindings>
        <QuestionOptions
          request={{
            taskId: 'task-1',
            requestId: 'request-files',
            questions: ['First?', 'Second?'].map((question) => ({
              key: question,
              type: 'text' as const,
              question,
              header: question,
              multiSelect: false,
              options: [],
            })),
          }}
          projectRoot="/repo"
          onRespond={() => {}}
        />
      </RootKeyboardBindings>,
    );

    expect(markup.match(/type="file"/g)).toHaveLength(2);
    expect(markup.match(/Attach files/g)).toHaveLength(2);
  });

  it('hides the picker when a typed backend schema cannot carry files', () => {
    const markup = renderToStaticMarkup(
      <RootKeyboardBindings>
        <QuestionOptions
          request={{
            taskId: 'task-1',
            requestId: 'request-typed',
            questions: [{
              key: 'Choice',
              type: 'single_choice',
              question: 'Choice',
              header: 'Choice',
              multiSelect: false,
              options: [{ label: 'A', description: '' }],
              allowFileAttachments: false,
            }],
          }}
          projectRoot="/repo"
          onRespond={() => {}}
        />
      </RootKeyboardBindings>,
    );

    expect(markup).not.toContain('type="file"');
  });

  it('renders Decide for me after provided options and before custom answer', () => {
    const markup = renderToStaticMarkup(
      <RootKeyboardBindings>
        <QuestionOptions
          request={{
            taskId: 'task-1',
            requestId: 'request-1',
            questions: [
              {
                key: 'Choose one',
                type: 'single_choice',
                question: 'Choose one',
                header: 'Choice',
                multiSelect: false,
                options: [{ label: 'First option', description: '' }],
              },
            ],
          }}
          onRespond={() => {}}
        />
      </RootKeyboardBindings>,
    );

    expect(markup.indexOf('First option')).toBeLessThan(
      markup.indexOf('Decide for me'),
    );
    expect(markup.indexOf('Decide for me')).toBeLessThan(
      markup.indexOf('Add another answer'),
    );
  });

  it('renders cmd+enter submit shortcut hint', () => {
    const markup = renderToStaticMarkup(
      <RootKeyboardBindings>
        <QuestionOptions
          request={{
            taskId: 'task-1',
            requestId: 'request-shortcut',
            questions: [],
          }}
          onRespond={() => {}}
        />
      </RootKeyboardBindings>,
    );

    expect(markup).toContain('⌘↵');
  });

  it.each(['text', 'multi_choice'] as const)(
    'renders Decide for me among %s responses',
    (type) => {
      const markup = renderToStaticMarkup(
        <RootKeyboardBindings>
          <QuestionOptions
            request={{
              taskId: 'task-1',
              requestId: `request-${type}`,
              questions: [
                {
                  key: 'Choose one',
                  type,
                  question: 'Choose one',
                  header: 'Choice',
                  multiSelect: type === 'multi_choice',
                  options:
                    type === 'multi_choice'
                      ? [{ label: 'First option', description: '' }]
                      : [],
                },
              ],
            }}
            onRespond={() => {}}
          />
        </RootKeyboardBindings>,
      );

      expect(markup).toContain('Decide for me');
      if (type === 'text') {
        expect(markup.indexOf('Decide for me')).toBeLessThan(
          markup.indexOf('Add another answer'),
        );
      }
    },
  );

  it.each([
    ['single_choice', false],
    ['multi_choice', true],
  ] as const)('marks recommended %s options', (type, multiSelect) => {
    const markup = renderToStaticMarkup(
      <RootKeyboardBindings>
        <QuestionOptions
          request={{
            taskId: 'task-1',
            requestId: `request-recommended-${type}`,
            questions: [
              {
                key: 'Choose one',
                type,
                question: 'Choose one',
                header: 'Choice',
                multiSelect,
                options: [
                  {
                    label: 'Preferred option',
                    description: '',
                    recommended: true,
                  },
                  {
                    label: 'Other option',
                    description: '',
                    recommended: false,
                  },
                ],
              },
            ],
          }}
          onRespond={() => {}}
        />
      </RootKeyboardBindings>,
    );

    expect(markup.match(/Recommended/g)).toHaveLength(1);
    expect(markup.indexOf('Preferred option')).toBeLessThan(
      markup.indexOf('Recommended'),
    );
  });
});
