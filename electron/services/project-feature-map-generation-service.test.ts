import { describe, expect, it } from 'vitest';

import { buildProjectFeatureMapPrompt } from './project-feature-map-generation-service';

describe('buildProjectFeatureMapPrompt', () => {
  it('includes an existing feature map path when provided', () => {
    const prompt = buildProjectFeatureMapPrompt({
      project: { name: 'Jean Claude', path: '/workspace/jean-claude' },
      tempFilePath:
        '/workspace/jean-claude/.jean-claude/tmp/feature-map/1/feature-map.yaml',
      existingFeatureMapPath:
        '/workspace/jean-claude/.jean-claude/feature-map.yaml',
    });

    expect(prompt).toContain(
      'Existing feature map: /workspace/jean-claude/.jean-claude/feature-map.yaml',
    );
  });
});
