import { describe, expect, it } from 'vitest';

import type {
  AzureDevOpsWorkItem,
  WorkItemComment,
} from './azure-devops-service';
import {
  prepareWorkItemSummarySource,
  UNTRUSTED_WORK_ITEM_SOURCE_NOTICE,
} from './work-item-summary-source';

const workItem: AzureDevOpsWorkItem = {
  id: 42,
  url: 'https://example.test/42',
  fields: {
    title: 'Checkout fails',
    workItemType: 'Bug',
    state: 'Active',
    description: '<p>Payment <strong>fails</strong>.</p>',
    acceptanceCriteria: '<ul><li>Order completes</li></ul>',
    reproSteps: '<ol><li>Submit payment</li></ol>',
    changedDate: '2026-07-14T09:00:00.000Z',
  },
};

const comments: WorkItemComment[] = [
  {
    id: 2,
    workItemId: 42,
    text: '<p>Decision: retry once.</p>',
    format: 'html',
    createdBy: 'Grace',
    createdDate: '2026-07-14T11:00:00.000Z',
  },
  {
    id: 1,
    workItemId: 42,
    text: 'Initial report',
    format: 'markdown',
    createdBy: 'Ada',
    createdDate: '2026-07-14T10:00:00.000Z',
  },
];

describe('prepareWorkItemSummarySource', () => {
  it('renders readable core Markdown and omits missing optional sections', () => {
    const result = prepareWorkItemSummarySource({ workItem, comments: [] });

    expect(result.coreMarkdown).toContain('Payment **fails**.');
    expect(result.coreMarkdown).toContain('## Acceptance criteria');
    expect(result.coreMarkdown).toMatch(/1\.\s+Submit payment/);
    expect(result.coreMarkdown).toContain(UNTRUSTED_WORK_ITEM_SOURCE_NOTICE);

    const sparse = prepareWorkItemSummarySource({
      workItem: {
        ...workItem,
        fields: {
          title: 'Sparse',
          workItemType: 'Task',
          state: 'New',
        },
      },
      comments: [],
    });
    expect(sparse.coreMarkdown).not.toContain('## Description');
    expect(sparse.coreMarkdown).toContain('- **Title:** Sparse');
  });

  it('deduplicates and renders comments from oldest to newest', () => {
    const result = prepareWorkItemSummarySource({
      workItem,
      comments: [comments[0], comments[1], { ...comments[0], text: 'duplicate' }],
    });

    expect(result.commentsMarkdown.indexOf('Comment #1')).toBeLessThan(
      result.commentsMarkdown.indexOf('Comment #2'),
    );
    expect(result.commentsMarkdown).toContain('Decision: retry once.');
    expect(result.commentsMarkdown).not.toContain('duplicate');
    expect(result.commentsMarkdown).toContain(UNTRUSTED_WORK_ITEM_SOURCE_NOTICE);
    expect(result.sourceLatestCommentId).toBe(2);
    expect(result.sourceCommentCount).toBe(2);
  });

  it('returns explicit empty comments content and null marker', () => {
    const result = prepareWorkItemSummarySource({ workItem, comments: [] });

    expect(result.commentsMarkdown).toContain('_No comments._');
    expect(result.sourceLatestCommentId).toBeNull();
    expect(result.sourceCommentCount).toBe(0);
    expect(result.sourceChangedDate).toBe(workItem.fields.changedDate);
  });

  it('produces a stable hash independent of comment input order', () => {
    const forward = prepareWorkItemSummarySource({ workItem, comments });
    const reverse = prepareWorkItemSummarySource({
      workItem,
      comments: [...comments].reverse(),
    });

    expect(forward.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reverse.sourceHash).toBe(forward.sourceHash);
  });

  it.each([
    ['title', { workItem: { ...workItem, fields: { ...workItem.fields, title: 'Changed' } }, comments }],
    ['description', { workItem: { ...workItem, fields: { ...workItem.fields, description: '<p>Changed</p>' } }, comments }],
    ['comment text', { workItem, comments: [{ ...comments[0], text: 'Changed' }, comments[1]] }],
    ['comment id', { workItem, comments: [{ ...comments[0], id: 3 }, comments[1]] }],
    ['comment date', { workItem, comments: [{ ...comments[0], createdDate: '2026-07-14T12:00:00.000Z' }, comments[1]] }],
    ['comment author', { workItem, comments: [{ ...comments[0], createdBy: 'Linus' }, comments[1]] }],
    ['comment count', { workItem, comments: [comments[0]] }],
  ])('changes hash when %s changes', (_, changed) => {
    const baseline = prepareWorkItemSummarySource({ workItem, comments });
    expect(prepareWorkItemSummarySource(changed).sourceHash).not.toBe(
      baseline.sourceHash,
    );
  });
});
