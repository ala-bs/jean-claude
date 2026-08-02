/**
 * Formatting helpers for process resource metrics (RSS, heap, CPU).
 * Shared by the header resource chip and the resources overlay so both
 * render identical numbers for the same sample.
 */

/** Splits a byte count into a rounded value and its unit. */
export function splitResourceBytes(bytes: number): {
  value: string;
  unit: 'GB' | 'MB' | 'KB';
} {
  const megabytes = bytes / 1_048_576;
  if (megabytes > 1000) {
    return { value: (megabytes / 1000).toFixed(1), unit: 'GB' };
  }
  if (megabytes >= 1) return { value: megabytes.toFixed(0), unit: 'MB' };
  return { value: (bytes / 1_024).toFixed(0), unit: 'KB' };
}

/** e.g. `735 MB`, or `735MB` when `compact`. */
export function formatResourceBytes(
  bytes: number,
  { compact = false }: { compact?: boolean } = {},
): string {
  const { value, unit } = splitResourceBytes(bytes);
  return compact ? `${value}${unit}` : `${value} ${unit}`;
}

/** e.g. `0.8%`. Negative readings are clamped to zero. */
export function formatCpuPercent(percent: number): string {
  return `${formatCpuPercentValue(percent)}%`;
}

/** Same as {@link formatCpuPercent} without the unit suffix. */
export function formatCpuPercentValue(percent: number): string {
  return Math.max(0, percent).toFixed(1);
}
