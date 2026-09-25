import { describe, expect, it } from 'vitest';

import {
  getStatusChipRuleFieldRefNames,
  type WorkItemStatusChipRule,
} from './work-item-status-chip-types';
import {
  DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
  isWorkItemDisplayConfig,
} from './work-item-display-config-types';

const rule = (patch: Partial<WorkItemStatusChipRule> = {}): WorkItemStatusChipRule => ({
  id: 'blocked',
  field: 'System.State',
  values: ['Blocked'],
  label: 'Needs clarification',
  tone: 'warning',
  enabled: true,
  ...patch,
});

describe('work-item status chip contracts', () => {
  it('keeps old configs valid when statusChips is absent', () => {
    const config = { ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG };
    delete config.statusChips;
    expect(isWorkItemDisplayConfig(config)).toBe(true);
  });

  it('rejects malformed rules', () => {
    expect(
      isWorkItemDisplayConfig({
        ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
        statusChips: [rule({ label: ' ' })],
      }),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig({
        ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
        statusChips: [rule({ field: 'not a ref name' })],
      }),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig({
        ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
        statusChips: [rule({ tone: 'purple' as never })],
      }),
    ).toBe(false);
  });

  it('extracts enabled custom fields and excludes core fields', () => {
    expect(
      getStatusChipRuleFieldRefNames([
        rule(),
        rule({ id: 'severity', field: 'Custom.Severity' }),
        rule({ id: 'disabled', field: 'Custom.Disabled', enabled: false }),
        rule({ id: 'duplicate', field: 'Custom.Severity' }),
      ]),
    ).toEqual(['Custom.Severity']);
  });
});
