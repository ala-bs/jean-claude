import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AzureDevOpsPolicyEvaluation } from '@/lib/api';

import { PrChecks } from '.';

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

function renderChecks(evaluations: AzureDevOpsPolicyEvaluation[]) {
  return renderToStaticMarkup(
    createElement(PrChecks, {
      evaluations: evaluations.map((evaluation) => ({
        ...evaluation,
        _optimisticQueued: false,
      })),
      onRequeue: vi.fn(),
    }),
  );
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
