import type { ProjectFeatureMap, ProjectFeatureMapItem } from '@shared/types';

export type FlatProjectFeature = ProjectFeatureMapItem & {
  depth: number;
  path: string[];
};

export type PreparedProjectFeature = FlatProjectFeature & {
  referenceText: string;
  matchRegex: RegExp;
  replaceRegex: RegExp;
  nameReplaceRegex: RegExp;
};

export type PreparedProjectFeatures = {
  features: PreparedProjectFeature[];
  matchOrder: PreparedProjectFeature[];
};

const FEATURE_REFERENCE_PREFIX = String.raw`(^|[\s([{\'"\`])`;
const FEATURE_REFERENCE_SUFFIX = String.raw`(?!\s*>)(?=$|\s|[.,;:!?\)\]' "])`;

export function flattenProjectFeatures(
  features: ProjectFeatureMapItem[] | undefined,
  path: string[] = [],
  depth = 0,
): FlatProjectFeature[] {
  if (!features) return [];

  return features.flatMap((feature) => {
    const featurePath = [...path, feature.name];
    return [
      { ...feature, depth, path: featurePath },
      ...flattenProjectFeatures(feature.children, featurePath, depth + 1),
    ];
  });
}

export function escapeFeatureXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildFeatureContextXml(
  features: ProjectFeatureMapItem[] | FlatProjectFeature[],
): string {
  if (features.length === 0) return '';

  const lines = ['<feature_context>'];
  for (const feature of features) {
    lines.push(`  <feature name="${escapeFeatureXml(feature.name)}">`);
    lines.push(`    <summary>${escapeFeatureXml(feature.summary)}</summary>`);
    if (feature.key_files.length > 0) {
      lines.push('    <key_files>');
      for (const file of feature.key_files) {
        lines.push(`      <file>${escapeFeatureXml(file)}</file>`);
      }
      lines.push('    </key_files>');
    }
    lines.push('  </feature>');
  }
  lines.push('</feature_context>');

  return `\n\n${lines.join('\n')}`;
}

export function getReferencedFeatures({
  text,
  featureMap,
  preparedFeatures,
}: {
  text: string;
  featureMap?: ProjectFeatureMap | null;
  preparedFeatures?: PreparedProjectFeatures;
}): PreparedProjectFeature[] {
  const prepared =
    preparedFeatures ?? prepareProjectFeatureReferences(featureMap);
  if (!text || prepared.matchOrder.length === 0) return [];

  return prepared.matchOrder.filter((feature) => feature.matchRegex.test(text));
}

export function expandFeatureReferencesInPrompt({
  text,
  featureMap,
  preparedFeatures,
}: {
  text: string;
  featureMap?: ProjectFeatureMap | null;
  preparedFeatures?: PreparedProjectFeatures;
}): string {
  const features = getReferencedFeatures({
    text,
    featureMap,
    preparedFeatures,
  });
  if (features.length === 0) return text;

  let prompt = text;
  const referencedNameCounts = new Map<string, number>();
  for (const feature of features) {
    referencedNameCounts.set(
      feature.name,
      (referencedNameCounts.get(feature.name) ?? 0) + 1,
    );
  }
  const orderedFeatures = [...features].sort((a, b) => {
    const aLength =
      referencedNameCounts.get(a.name)! > 1
        ? a.referenceText.length
        : a.name.length;
    const bLength =
      referencedNameCounts.get(b.name)! > 1
        ? b.referenceText.length
        : b.name.length;
    return bLength - aLength;
  });
  for (const feature of orderedFeatures) {
    const replaceRegex =
      referencedNameCounts.get(feature.name)! > 1
        ? feature.replaceRegex
        : feature.nameReplaceRegex;
    prompt = prompt.replace(replaceRegex, `$1${feature.name}`);
  }

  return `${prompt.trimEnd()}${buildFeatureContextXml(orderedFeatures)}`;
}

export function prepareProjectFeatureReferences(
  featureMap: ProjectFeatureMap | null | undefined,
): PreparedProjectFeatures {
  const features = flattenProjectFeatures(featureMap?.features);
  const nameCounts = new Map<string, number>();
  for (const feature of features) {
    nameCounts.set(feature.name, (nameCounts.get(feature.name) ?? 0) + 1);
  }

  const preparedFeatures = features.map((feature) => {
    const referenceText =
      nameCounts.get(feature.name)! > 1
        ? feature.path.join(' > ')
        : feature.name;
    const pattern = getFeatureReferencePattern(referenceText);
    return {
      ...feature,
      referenceText,
      matchRegex: new RegExp(pattern),
      replaceRegex: new RegExp(pattern, 'g'),
      nameReplaceRegex: new RegExp(
        getFeatureReferencePattern(feature.name),
        'g',
      ),
    };
  });

  return {
    features: preparedFeatures,
    matchOrder: [...preparedFeatures].sort(
      (a, b) => b.referenceText.length - a.referenceText.length,
    ),
  };
}

export function getFeatureReferenceText(
  feature: FlatProjectFeature,
  features: FlatProjectFeature[],
): string {
  const duplicateName = features.some(
    (item) => item.id !== feature.id && item.name === feature.name,
  );
  return duplicateName ? feature.path.join(' > ') : feature.name;
}

function getFeatureReferencePattern(name: string): string {
  return `${FEATURE_REFERENCE_PREFIX}#${escapeRegExp(name)}${FEATURE_REFERENCE_SUFFIX}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
