import {
  type AzureFieldRefName,
  CORE_FIELD_REFNAMES,
} from './work-item-field-types';

export const WORK_ITEM_STATUS_CHIP_TONES = [
  'warning',
  'danger',
  'info',
  'success',
  'neutral',
] as const;

export type WorkItemStatusChipTone =
  (typeof WORK_ITEM_STATUS_CHIP_TONES)[number];

export interface WorkItemStatusChipRule {
  id: string;
  field: AzureFieldRefName;
  values: string[];
  label: string;
  tone: WorkItemStatusChipTone;
  enabled: boolean;
}

export interface WorkItemStatusChipMatch {
  ruleId: string;
  label: string;
  tone: WorkItemStatusChipTone;
  workItemIds: string[];
}

export function getStatusChipRuleFieldRefNames(
  rules: WorkItemStatusChipRule[] | undefined,
): AzureFieldRefName[] {
  if (!rules?.length) return [];

  const core = new Set(CORE_FIELD_REFNAMES);
  const seen = new Set<string>();
  const refNames: string[] = [];
  for (const rule of rules) {
    if (!rule.enabled || core.has(rule.field) || seen.has(rule.field)) continue;
    seen.add(rule.field);
    refNames.push(rule.field);
  }
  return refNames;
}
