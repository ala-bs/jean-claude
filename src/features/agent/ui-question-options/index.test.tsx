import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';

import { QuestionContextReminder, QuestionOptions } from '.';

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
  it('renders Decide for me after provided options and before custom answer', () => {
    const markup = renderToStaticMarkup(
      <RootKeyboardBindings>
        <QuestionOptions
          request={{
            taskId: 'task-1',
            requestId: 'request-1',
            questions: [
              {
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
