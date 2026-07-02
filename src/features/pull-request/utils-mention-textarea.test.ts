import { describe, expect, it } from 'vitest';

import {
  decodeMentionDisplayNames,
  encodeMentionDisplayNames,
} from '@/common/ui/mention-textarea';

const mentionOptions = [
  {
    id: '09c05d5e-5817-4b65-b3f2-07f1c8047f52',
    displayName: 'Patrick Lin',
    uniqueName: 'patrick@example.com',
  },
];

describe('mention textarea helpers', () => {
  it('encodes selected display names as Azure DevOps mention tokens', () => {
    expect(encodeMentionDisplayNames('@Patrick Lin please review', mentionOptions))
      .toBe('@<09c05d5e-5817-4b65-b3f2-07f1c8047f52> please review');
  });

  it('decodes Azure DevOps mention tokens to display names', () => {
    expect(
      decodeMentionDisplayNames(
        '@<09c05d5e-5817-4b65-b3f2-07f1c8047f52> please review',
        mentionOptions,
      ),
    ).toBe('@Patrick Lin please review');
  });
});
