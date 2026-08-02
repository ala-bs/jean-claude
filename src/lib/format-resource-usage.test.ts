import { describe, expect, it } from 'vitest';

import {
  formatCpuPercent,
  formatCpuPercentValue,
  formatResourceBytes,
  splitResourceBytes,
} from './format-resource-usage';

describe('splitResourceBytes', () => {
  it('uses KB below one megabyte', () => {
    expect(splitResourceBytes(512 * 1024)).toEqual({ value: '512', unit: 'KB' });
  });

  it('uses MB up to a thousand megabytes', () => {
    expect(splitResourceBytes(305 * 1_048_576)).toEqual({
      value: '305',
      unit: 'MB',
    });
  });

  it('uses GB above a thousand megabytes', () => {
    expect(splitResourceBytes(1500 * 1_048_576)).toEqual({
      value: '1.5',
      unit: 'GB',
    });
  });
});

describe('formatResourceBytes', () => {
  it('spaces the unit by default', () => {
    expect(formatResourceBytes(305 * 1_048_576)).toBe('305 MB');
  });

  it('drops the space when compact', () => {
    expect(formatResourceBytes(305 * 1_048_576, { compact: true })).toBe(
      '305MB',
    );
  });
});

describe('formatCpuPercent', () => {
  it('renders one decimal with a unit', () => {
    expect(formatCpuPercent(0.83)).toBe('0.8%');
  });

  it('clamps negative readings to zero', () => {
    expect(formatCpuPercent(-4)).toBe('0.0%');
    expect(formatCpuPercentValue(-4)).toBe('0.0');
  });
});
