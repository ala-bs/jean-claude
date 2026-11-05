import { describe, expect, it } from 'vitest';

import { formatElicitationResult } from './format-elicitation-result';

describe('formatElicitationResult', () => {
  it('makes intentionally blank text and multi-choice answers explicit', () => {
    expect(formatElicitationResult({
      target: '',
      features: [],
      notes: 'Keep it small',
    })).toBe('target: [left empty]\nfeatures: [left empty]\nnotes: Keep it small');
  });
});
