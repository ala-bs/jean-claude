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

  it('asks the agent to update existing maps instead of replacing them', () => {
    const prompt = buildProjectFeatureMapPrompt({
      project: { name: 'Jean Claude', path: '/workspace/jean-claude' },
      tempFilePath:
        '/workspace/jean-claude/.jean-claude/tmp/feature-map/1/feature-map.yaml',
      existingFeatureMapPath:
        '/workspace/jean-claude/.jean-claude/feature-map.yaml',
      skillName: 'project-feature-mapping',
    });

    expect(prompt).toContain(
      'Use the "project-feature-mapping" skill to update the feature map.',
    );
    expect(prompt).toContain('Preserve accurate existing nodes');
    expect(prompt).toContain(
      'Explore code to find missing, newly added, or shallowly documented user-facing features.',
    );
    expect(prompt).toContain('Output the complete updated YAML');
  });
});
