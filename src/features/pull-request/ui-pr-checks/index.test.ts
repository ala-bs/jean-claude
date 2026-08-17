/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AzureDevOpsPolicyEvaluation } from '@/lib/api';

import { PrChecks } from '.';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function buildEvaluation(
  overrides: Partial<AzureDevOpsPolicyEvaluation> = {},
): AzureDevOpsPolicyEvaluation {
  return {
    evaluationId: 'eval-1',
    status: 'queued',
    isBlocking: true,
    configuration: {
      id: 1,
      isEnabled: true,
      isBlocking: true,
      type: {
        id: 'build',
        displayName: 'Build',
      },
      settings: {
        buildDefinitionId: 123,
        displayName: 'CI',
      },
    },
    context: {
      isExpired: true,
    },
    ...overrides,
  };
}

function renderChecks(
  evaluations: AzureDevOpsPolicyEvaluation[],
  props: Partial<ComponentProps<typeof PrChecks>> = {},
) {
  return renderToStaticMarkup(
    createElement(PrChecks, {
      evaluations: evaluations.map((evaluation) => ({
        ...evaluation,
        _optimisticQueued: false,
      })),
      onRequeue: vi.fn(),
      ...props,
    }),
  );
}

function renderInteractiveChecks(
  props: Partial<ComponentProps<typeof PrChecks>> = {},
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const evaluation = buildEvaluation({
    configuration: {
      id: 7,
      isEnabled: true,
      isBlocking: false,
      type: {
        id: 'work-item-linking',
        displayName: 'Work item linking',
      },
      settings: {
        displayName: 'Work item linking',
      },
    },
  });

  flushSync(() => {
    root?.render(
      createElement(
        PrChecks,
        {
          evaluations: [{ ...evaluation, _optimisticQueued: false }],
          ignoredAutoCompletePolicyIds: new Set<number>(),
          onSetPolicyIgnored: vi.fn(),
          ...props,
        },
      ),
    );
  });
}

function getButton(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

describe('PrChecks expired CI', () => {
  it('renders expired build policies with re-queue action', () => {
    const markup = renderChecks([buildEvaluation()]);

    expect(markup).toContain('Expired');
    expect(markup).toContain('Re-queue');
    expect(markup).not.toContain('Pending');
  });

  it('keeps expired approved checks active and out of passed summary', () => {
    const markup = renderChecks([
      buildEvaluation({
        status: 'approved',
        context: { buildId: 456, isExpired: true },
      }),
    ]);

    expect(markup).toContain('Some checks failed');
    expect(markup).toContain('0/1');
    expect(markup).toContain('Expired');
    expect(markup).not.toContain('1 passed check');
  });
});

describe('PrChecks optional policies', () => {
  it('hides stale ignored state when auto-complete controls are inactive', () => {
    const markup = renderChecks(
      [
        buildEvaluation({
          configuration: {
            id: 7,
            isEnabled: true,
            isBlocking: false,
            type: { id: 'policy', displayName: 'Policy' },
            settings: { displayName: 'Optional policy' },
          },
        }),
      ],
      { ignoredAutoCompletePolicyIds: new Set([7]) },
    );

    expect(markup).toContain('Optional');
    expect(markup).not.toContain('Ignored');
  });

  it('allows any Azure-optional policy type to be made optional', () => {
    const onSetPolicyIgnored = vi.fn();
    renderInteractiveChecks({ onSetPolicyIgnored });

    flushSync(() => getButton('Make optional').click());
    expect(onSetPolicyIgnored).toHaveBeenCalledWith(7, true);
  });

  it('allows ignored policies to be made required again', () => {
    const onSetPolicyIgnored = vi.fn();
    renderInteractiveChecks({
      ignoredAutoCompletePolicyIds: new Set([7]),
      onSetPolicyIgnored,
    });

    expect(document.body.textContent).toContain('Ignored');
    flushSync(() => getButton('Make required').click());
    expect(onSetPolicyIgnored).toHaveBeenCalledWith(7, false);
  });
});
