import clsx from 'clsx';
import { useMemo } from 'react';

/**
 * Lightweight SVG sparkline for inline usage charts.
 * No external dependencies — renders a polyline + optional area fill.
 */
export function Sparkline({
  data,
  referenceData,
  xData,
  xDomain,
  width = 180,
  height = 40,
  strokeWidth = 1.5,
  className,
  color = 'currentColor',
  fillOpacity = 0.1,
  max: maxOverride,
}: {
  data: number[];
  referenceData?: number[];
  xData?: number[];
  xDomain?: readonly [number, number];
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
  color?: string;
  fillOpacity?: number;
  max?: number;
}) {
  const { points, referencePoints, areaPath } = useMemo(() => {
    if (data.length === 0) {
      return { points: '', referencePoints: '', areaPath: '' };
    }

    const max =
      maxOverride ?? Math.max(...data, ...(referenceData ?? []), 0.01);
    const padding = strokeWidth;
    const drawHeight = height - padding * 2;
    const drawWidth = width - padding * 2;
    const defaultXData = data.map((_, index) => index);
    const chartXData = xData?.length === data.length ? xData : defaultXData;
    const minX = xDomain?.[0] ?? Math.min(...chartXData);
    const maxX = xDomain?.[1] ?? Math.max(...chartXData);
    const xRange = Math.max(maxX - minX, 1);

    const toPoint = (v: number, i: number) => {
      const x = padding + ((chartXData[i] - minX) / xRange) * drawWidth;
      const y = padding + drawHeight - (v / max) * drawHeight;
      return `${x},${y}`;
    };

    const linePoints = data.map(toPoint);
    const computedReferencePoints =
      referenceData && referenceData.length === data.length
        ? referenceData.map(toPoint).join(' ')
        : '';

    const firstX = padding + ((chartXData[0] - minX) / xRange) * drawWidth;
    const lastX =
      padding +
      ((chartXData[chartXData.length - 1] - minX) / xRange) * drawWidth;
    const bottomY = padding + drawHeight;

    return {
      points: linePoints.join(' '),
      referencePoints: computedReferencePoints,
      areaPath: `M ${firstX},${bottomY} L ${linePoints.join(' L ')} L ${lastX},${bottomY} Z`,
    };
  }, [
    data,
    referenceData,
    xData,
    xDomain,
    width,
    height,
    strokeWidth,
    maxOverride,
  ]);

  if (data.length < 2) {
    return null;
  }

  return (
    <svg
      width={width}
      height={height}
      className={clsx('shrink-0', className)}
      viewBox={`0 0 ${width} ${height}`}
    >
      {fillOpacity > 0 && (
        <path d={areaPath} fill={color} opacity={fillOpacity} />
      )}
      {referencePoints && (
        <polyline
          points={referencePoints}
          fill="none"
          stroke="var(--color-ink-3)"
          strokeWidth={1}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="3 3"
          opacity={0.7}
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
