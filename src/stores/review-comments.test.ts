import { describe, expect, it } from 'vitest';

import {
  type ReviewComment,
  reviewCommentToAgentMemoryCapture,
} from './review-comments';

function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'rc-stable-id',
    commentKind: 'diff',
    anchor: {
      filePath: 'src/example.ts',
      lineStart: 7,
      selectedText: 'const value = 1',
    },
    body: 'Rename this value',
    presets: ['rename'],
    status: 'open',
    resolved: false,
    createdAt: 1,
    ...overrides,
  };
}

describe('reviewCommentToAgentMemoryCapture', () => {
  it('preserves stable identity and only selected file context', () => {
    expect(reviewCommentToAgentMemoryCapture(comment())).toEqual({
      commentId: 'rc-stable-id',
      body: 'Rename this value',
      selectedText: 'const value = 1',
      filePath: 'src/example.ts',
      lineStart: 7,
      lineEnd: 7,
      presets: ['rename'],
    });
  });

  it('omits synthetic message paths and ranges', () => {
    expect(
      reviewCommentToAgentMemoryCapture(
        comment({
          commentKind: 'message',
          anchor: {
            filePath: '__message__:entry-1',
            lineStart: 1,
            selectedText: 'quoted response',
          },
        }),
      ),
    ).toMatchObject({
      commentId: 'rc-stable-id',
      selectedText: 'quoted response',
      filePath: null,
      lineStart: null,
      lineEnd: null,
    });
  });
});
