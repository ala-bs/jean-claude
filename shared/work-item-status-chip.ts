import type { WorkItemFieldsHolder } from './work-item-field-types';
import type {
  WorkItemStatusChipMatch,
  WorkItemStatusChipRule,
} from './work-item-status-chip-types';

function normalizeValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().toLocaleLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).toLocaleLowerCase();
  }
  return null;
}

export function matchWorkItemStatusChipRules({
  workItem,
  rules,
}: {
  workItem: WorkItemFieldsHolder & { id: number };
  rules: WorkItemStatusChipRule[];
}): WorkItemStatusChipMatch[] {
  return rules.flatMap((rule) => {
    if (!rule.enabled) return [];
    const actualValue = normalizeValue(workItem.fields[rule.field]);
    if (!actualValue) return [];
    const matches = rule.values.some(
      (value) => normalizeValue(value) === actualValue,
    );
    return matches
      ? [
          {
            ruleId: rule.id,
            label: rule.label,
            tone: rule.tone,
            workItemIds: [String(workItem.id)],
          },
        ]
      : [];
  });
}

export function mergeWorkItemStatusChipMatches(
  matches: WorkItemStatusChipMatch[],
): WorkItemStatusChipMatch[] {
  const merged = new Map<string, WorkItemStatusChipMatch>();
  for (const match of matches) {
    const existing = merged.get(match.ruleId);
    if (!existing) {
      merged.set(match.ruleId, {
        ...match,
        workItemIds: [...match.workItemIds],
      });
      continue;
    }
    for (const workItemId of match.workItemIds) {
      if (!existing.workItemIds.includes(workItemId)) {
        existing.workItemIds.push(workItemId);
      }
    }
  }
  return [...merged.values()];
}
