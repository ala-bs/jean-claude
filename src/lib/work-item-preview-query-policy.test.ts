import { describe, expect, it } from 'vitest';

import {
  addOpenedCommentsWorkItemId,
  beginMetadataEdit,
  beginMetadataSave,
  cancelMetadataEdit,
  finishMetadataSave,
  getWorkItemPreviewQueryPolicy,
} from '@/features/work-item/ui-work-item-preview/query-policy';

const noOpenedComments = new Set<number>();

describe('work item preview query policy', () => {
  it('loads comments eagerly when they are shown aside', () => {
    expect(
      getWorkItemPreviewQueryPolicy({
        variant: 'default',
        showCommentsAside: true,
        commentsTabActive: false,
        workItemId: 1,
        openedCommentsWorkItemIds: noOpenedComments,
      }).comments,
    ).toBe(true);
  });

  it('keeps comments disabled until the comments tab has opened', () => {
    expect(
      getWorkItemPreviewQueryPolicy({
        variant: 'default',
        showCommentsAside: false,
        commentsTabActive: false,
        workItemId: 1,
        openedCommentsWorkItemIds: noOpenedComments,
      }).comments,
    ).toBe(false);
    expect(
      getWorkItemPreviewQueryPolicy({
        variant: 'default',
        showCommentsAside: false,
        commentsTabActive: false,
        workItemId: 1,
        openedCommentsWorkItemIds: new Set([1]),
      }).comments,
    ).toBe(true);
  });

  it('loads the next item immediately while comments remain active', () => {
    const openedCommentsWorkItemIds = new Set([1]);

    expect(
      getWorkItemPreviewQueryPolicy({
        variant: 'default',
        showCommentsAside: false,
        commentsTabActive: true,
        workItemId: 2,
        openedCommentsWorkItemIds,
      }).comments,
    ).toBe(true);
  });

  it('retains intent when opening A, switching to B, then revisiting A', () => {
    let openedCommentsWorkItemIds = noOpenedComments;
    openedCommentsWorkItemIds = addOpenedCommentsWorkItemId(
      openedCommentsWorkItemIds,
      1,
    );
    openedCommentsWorkItemIds = addOpenedCommentsWorkItemId(
      openedCommentsWorkItemIds,
      2,
    );

    expect(
      getWorkItemPreviewQueryPolicy({
        variant: 'default',
        showCommentsAside: false,
        commentsTabActive: false,
        workItemId: 1,
        openedCommentsWorkItemIds,
      }).comments,
    ).toBe(true);
  });

  it('never loads related test cases for editorial previews', () => {
    expect(
      getWorkItemPreviewQueryPolicy({
        variant: 'editorial',
        showCommentsAside: false,
        commentsTabActive: true,
        workItemId: 1,
        openedCommentsWorkItemIds: new Set([1]),
      }).relatedTestCases,
    ).toBe(false);
  });

  it('keeps related test cases eager for default previews', () => {
    expect(
      getWorkItemPreviewQueryPolicy({
        variant: 'default',
        showCommentsAside: false,
        commentsTabActive: false,
        workItemId: 1,
        openedCommentsWorkItemIds: noOpenedComments,
      }).relatedTestCases,
    ).toBe(true);
  });
});

describe('metadata edit cancellation', () => {
  it('cancels Escape blur but permits one save in the next edit', () => {
    const lifecycle = { generation: 0, cancelled: false, inFlight: false };

    beginMetadataEdit(lifecycle);
    cancelMetadataEdit(lifecycle);
    expect(beginMetadataSave(lifecycle)).toBeNull();

    beginMetadataEdit(lifecycle);
    const generation = beginMetadataSave(lifecycle);
    expect(generation).toBe(3);
    expect(beginMetadataSave(lifecycle)).toBeNull();
    expect(finishMetadataSave(lifecycle, generation!)).toBe(true);
  });

  it('ignores async completion after edit identity changes', () => {
    const lifecycle = { generation: 0, cancelled: false, inFlight: false };
    beginMetadataEdit(lifecycle);
    const oldGeneration = beginMetadataSave(lifecycle)!;

    beginMetadataEdit(lifecycle);

    expect(finishMetadataSave(lifecycle, oldGeneration)).toBe(false);
  });

  it('invalidates dropdown rollback when an incoming prop starts a new generation', () => {
    const lifecycle = { generation: 0, cancelled: false, inFlight: false };
    beginMetadataEdit(lifecycle);
    const staleSave = beginMetadataSave(lifecycle)!;

    beginMetadataEdit(lifecycle);

    expect(finishMetadataSave(lifecycle, staleSave)).toBe(false);
    expect(beginMetadataSave(lifecycle)).toBe(lifecycle.generation);
  });
});
