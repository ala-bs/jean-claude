import { describe, expect, it } from 'vitest';

import type { ProjectFeatureMap } from '@shared/types';

import {
  expandFeatureReferencesInPrompt,
  flattenProjectFeatures,
  getFeatureReferenceText,
  getReferencedFeatures,
  prepareProjectFeatureReferences,
} from './prompt-feature-context';

const featureMap: ProjectFeatureMap = {
  generatedAt: '2026-06-07T00:00:00.000Z',
  features: [
    {
      id: 'shell',
      name: 'Shell',
      summary: 'App shell summary',
      key_files: ['src/shell.tsx'],
      children: [
        {
          id: 'shell-settings',
          name: 'Settings',
          summary: 'Shell settings summary',
          key_files: ['src/shell-settings.tsx'],
          children: [],
        },
      ],
    },
    {
      id: 'project',
      name: 'Project',
      summary: 'Project summary',
      key_files: ['src/project.tsx'],
      children: [
        {
          id: 'project-settings',
          name: 'Settings',
          summary: 'Project settings summary',
          key_files: ['src/project-settings.tsx'],
          children: [],
        },
      ],
    },
  ],
};

describe('prompt feature context', () => {
  it('expands refs after accepted punctuation prefixes', () => {
    const expanded = expandFeatureReferencesInPrompt({
      text: 'Update (#Shell) and "#Project".',
      featureMap,
    });

    expect(expanded).toContain('Update (Shell) and "Project".');
    expect(expanded).toContain('<feature name="Shell">');
    expect(expanded).toContain('<feature name="Project">');
  });

  it('uses breadcrumb refs for duplicate feature names', () => {
    const flat = flattenProjectFeatures(featureMap.features);
    const projectSettings = flat.find(
      (feature) => feature.id === 'project-settings',
    );
    expect(projectSettings).toBeDefined();

    const reference = getFeatureReferenceText(projectSettings!, flat);
    expect(reference).toBe('Project > Settings');

    const referenced = getReferencedFeatures({
      text: `Update #${reference}`,
      featureMap,
    });
    expect(referenced.map((feature) => feature.id)).toEqual([
      'project-settings',
    ]);
  });

  it('prepares sorted reference text and reusable matchers once', () => {
    const preparedFeatures = prepareProjectFeatureReferences(featureMap);

    expect(
      preparedFeatures.features.map((feature) => [
        feature.id,
        feature.referenceText,
      ]),
    ).toEqual([
      ['shell', 'Shell'],
      ['shell-settings', 'Shell > Settings'],
      ['project', 'Project'],
      ['project-settings', 'Project > Settings'],
    ]);
    expect(
      preparedFeatures.matchOrder.map((feature) => [
        feature.id,
        feature.referenceText,
      ]),
    ).toEqual([
      ['project-settings', 'Project > Settings'],
      ['shell-settings', 'Shell > Settings'],
      ['project', 'Project'],
      ['shell', 'Shell'],
    ]);

    const input = {
      text: 'Update #Project > Settings',
      preparedFeatures,
    };
    expect(getReferencedFeatures(input).map((feature) => feature.id)).toEqual([
      'project-settings',
    ]);
    expect(getReferencedFeatures(input).map((feature) => feature.id)).toEqual([
      'project-settings',
    ]);
  });

  it('expands refs using prepared features without rebuilding the map', () => {
    const preparedFeatures = prepareProjectFeatureReferences(featureMap);
    const expanded = expandFeatureReferencesInPrompt({
      text: 'Update #Shell and #Project > Settings.',
      preparedFeatures,
    });

    expect(expanded).toContain('Update Shell and #Project > Settings.');
    expect(expanded).toContain('<feature name="Shell">');
    expect(expanded).toContain('<feature name="Settings">');
  });

  it('preserves referenced-subset ordering for duplicate names', () => {
    const mapWithLongFeature: ProjectFeatureMap = {
      ...featureMap,
      features: [
        ...featureMap.features,
        {
          id: 'long-feature',
          name: 'LongFeatureName',
          summary: 'Long feature summary',
          key_files: [],
          children: [],
        },
      ],
    };
    const expanded = expandFeatureReferencesInPrompt({
      text: 'Update #Project > Settings and #LongFeatureName.',
      preparedFeatures: prepareProjectFeatureReferences(mapWithLongFeature),
    });

    expect(expanded.indexOf('<feature name="LongFeatureName">')).toBeLessThan(
      expanded.indexOf('<feature name="Settings">'),
    );
  });
});
