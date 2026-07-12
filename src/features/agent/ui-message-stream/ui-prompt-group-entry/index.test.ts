import { describe, expect, it } from 'vitest';

import { getResultDisplayTokenCount } from './index';

describe('getResultDisplayTokenCount', () => {
  it('prefers latest context usage over cumulative usage', () => {
    expect(
      getResultDisplayTokenCount({
        usage: { inputTokens: 576_063, outputTokens: 15_548 },
        contextUsage: { inputTokens: 196_919, outputTokens: 2_944 },
      }),
    ).toBe(199_863);
  });

  it('falls back to cumulative usage when context usage is unavailable', () => {
    expect(
      getResultDisplayTokenCount({
        usage: { inputTokens: 12_000, outputTokens: 500 },
      }),
    ).toBe(12_500);
  });
});
