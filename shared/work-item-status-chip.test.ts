import { describe, expect, it } from 'vitest';

import {
  matchWorkItemStatusChipRules,
  mergeWorkItemStatusChipMatches,
} from './work-item-status-chip';
import type { WorkItemStatusChipRule } from './work-item-status-chip-types';

const rule = (patch: Partial<WorkItemStatusChipRule> = {}): WorkItemStatusChipRule => ({
  id: 'state-blocked',
  field: 'System.State',
  values: ['Blocked'],
  label: 'Needs clarification',
  tone: 'warning',
  enabled: true,
  ...patch,
});

describe('work-item status chip matching', () => {
  it('matches string values case-insensitively after trimming', () => {
    expect(
      matchWorkItemStatusChipRules({
        workItem: { id: 123, fields: { 'System.State': ' blocked ' } },
        rules: [rule()],
      }),
    ).toEqual([
      {
        ruleId: 'state-blocked',
        label: 'Needs clarification',
        tone: 'warning',
        workItemIds: ['123'],
      },
    ]);
  });

  it('supports custom fields and ignores disabled or missing rules', () => {
    expect(
      matchWorkItemStatusChipRules({
        workItem: { id: 456, fields: { 'Custom.Stage': 'Clarification' } },
        rules: [
          rule({ id: 'stage', field: 'Custom.Stage', values: ['clarification'] }),
          rule({ id: 'disabled', field: 'Custom.Stage', enabled: false }),
          rule({ id: 'missing', field: 'Custom.Other' }),
        ],
      }),
    ).toHaveLength(1);
  });

  it('merges matching IDs by rule while preserving rule order', () => {
    expect(
      mergeWorkItemStatusChipMatches([
        { ...ruleMatch('a'), workItemIds: ['1'] },
        { ...ruleMatch('b'), workItemIds: ['2'] },
        { ...ruleMatch('a'), workItemIds: ['3', '1'] },
      ]),
    ).toEqual([
      { ...ruleMatch('a'), workItemIds: ['1', '3'] },
      { ...ruleMatch('b'), workItemIds: ['2'] },
    ]);
  });
});

function ruleMatch(ruleId: string) {
  return {
    ruleId,
    label: ruleId,
    tone: 'info' as const,
    workItemIds: [] as string[],
  };
}
