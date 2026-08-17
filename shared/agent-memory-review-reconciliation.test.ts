import { describe, expect, it } from 'vitest';

import {
  deriveAgentMemoryPromptCaptureFromSubmittedContent,
  reconcileAgentMemoryPromptCapture,
} from './agent-memory-review-reconciliation';

const rendererReview = {
  commentId: 'review-stable',
  body: 'Renderer body must not win',
  selectedText: '  const value = 1;',
  filePath: 'src/value.ts',
  lineStart: 4,
  lineEnd: 5,
  presets: ['refactor', 'tests'],
};

describe('initial Agent Memory review admission', () => {
  it('derives serialized review body and anchors for a matching stable id', () => {
    const content = `Fix this

<user_review>
<comment index="1" comment_id="review-stable" type="file" file_path="src/value.ts" line_range="L4-L5">
  <tags>refactor, tests</tags>
  <selected_lines>
  const value = 1;
  </selected_lines>
  <instruction>
Use the final parsed body
  </instruction>
</comment>
</user_review>`;

    expect(
      deriveAgentMemoryPromptCaptureFromSubmittedContent(
        { userText: 'renderer text', reviews: [rendererReview] },
        content,
      ).capture,
    ).toEqual({
      userText: content,
      reviews: [
        {
          ...rendererReview,
          body: 'Use the final parsed body',
        },
      ],
    });
  });

  it('rejects matching ids when serialized anchor context differs', () => {
    const content = `<user_review>
<comment index="1" comment_id="review-stable" type="file" file_path="src/other.ts" line_range="L4-L5">
  <tags>refactor, tests</tags>
  <selected_lines>
  const value = 1;
  </selected_lines>
  <instruction>Body</instruction>
</comment>
</user_review>`;
    const result = deriveAgentMemoryPromptCaptureFromSubmittedContent(
      { userText: content, reviews: [rendererReview] },
      content,
    );

    expect(result.capture.reviews).toEqual([]);
    expect(result.diagnostics.metadataMismatchCommentIds).toEqual([
      'review-stable',
    ]);
  });

  it('does not admit renderer-only ranges or presets absent from submitted XML', () => {
    const content = `<user_review>
<comment index="1" comment_id="review-stable" type="file" file_path="src/value.ts">
  <selected_lines>
  const value = 1;
  </selected_lines>
  <instruction>Body</instruction>
</comment>
</user_review>`;

    expect(
      deriveAgentMemoryPromptCaptureFromSubmittedContent(
        { userText: content, reviews: [rendererReview] },
        content,
      ).capture.reviews,
    ).toEqual([
      {
        ...rendererReview,
        body: 'Body',
        lineStart: null,
        lineEnd: null,
        presets: [],
      },
    ]);
  });

  it('removes every optional context field omitted from edited review XML', () => {
    const content = `<user_review>
<comment index="1" comment_id="review-stable" type="file" file_path="src/value.ts">
  <instruction>Edited body</instruction>
</comment>
</user_review>`;

    expect(
      reconcileAgentMemoryPromptCapture(
        { userText: 'renderer text', reviews: [rendererReview] },
        content,
      ).reviews,
    ).toEqual([
      {
        ...rendererReview,
        body: 'Edited body',
        selectedText: null,
        lineStart: null,
        lineEnd: null,
        presets: [],
      },
    ]);
  });

  it('rejects metadata and comments without a shared stable id', () => {
    const content = `<user_review>
<comment index="1" comment_id="unknown-review" type="message">
  <instruction>Unknown</instruction>
</comment>
<comment index="2" type="message">
  <instruction>Missing id</instruction>
</comment>
</user_review>`;
    const result = deriveAgentMemoryPromptCaptureFromSubmittedContent(
      { userText: content, reviews: [rendererReview] },
      content,
    );

    expect(result.capture.reviews).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      rejectedCommentIds: ['unknown-review'],
      rejectedCommentsWithoutId: 1,
      unrepresentedRendererCommentIds: ['review-stable'],
    });
  });
});
