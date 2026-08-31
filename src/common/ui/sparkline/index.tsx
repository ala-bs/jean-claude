import { useId, useMemo } from 'react';
import clsx from 'clsx';

/**
 * Lightweight SVG sparkline for inline usage charts.
 * No external dependencies — renders a polyline + optional area fill.
 */
export function Sparkline({
  data: dataProp,
  referenceData: referenceDataProp,
  xData: xDataProp,
  xDomain,
  width = 180,
  height = 40,
  strokeWidth = 1.5,
  className,
  color = 'currentColor',
  fillOpacity = 0.1,
  referenceColor = 'var(--color-ink-3)',
  positiveDeltaFillColor,
  positiveDeltaFillOpacity = 0.2,
  gapRanges,
  max: maxOverride,
  normalize = 'zero',
  strokeClassName,
  fillClassName,
  gradientFill = false,
  strokePathLength,
  shrink = true,
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
  referenceColor?: string;
  positiveDeltaFillColor?: string;
  positiveDeltaFillOpacity?: number;
  gapRanges?: { startMs: number; endMs: number }[];
  max?: number;
  /**
   * 'zero' scales from 0 to max (absolute magnitude reads correctly).
   * 'minmax' scales from min to max (small variations stay visible).
   */
  normalize?: 'zero' | 'minmax';
  /** Tailwind class applied to the stroke (stroke stays `currentColor`). */
  strokeClassName?: string;
  /**
   * Area fill precedence: `fillClassName` wins, then `gradientFill`,
   * then the flat `color` + `fillOpacity` pair. Only one is ever painted.
   */
  fillClassName?: string;
  /** Fade the area fill from `color` to transparent instead of a flat opacity. */
  gradientFill?: boolean;
  /** Normalizes the path length so CSS stroke-dash animations work. */
  strokePathLength?: number;
  /** Set false to let the svg compress below its `width` in flex/grid rows. */
  shrink?: boolean;
}) {
  const gradientId = useId();
  // A single sample still draws a flat line instead of rendering nothing.
  // Every parallel series is padded too, so index alignment is preserved.
  const isSingleSample = dataProp.length === 1;
  const data = useMemo(
    () => (isSingleSample ? [dataProp[0]!, dataProp[0]!] : dataProp),
    [dataProp, isSingleSample],
  );
  const referenceData = useMemo(
    () =>
      isSingleSample && referenceDataProp?.length === 1
        ? [referenceDataProp[0]!, referenceDataProp[0]!]
        : referenceDataProp,
    [referenceDataProp, isSingleSample],
  );
  const xData = useMemo(
    () =>
      isSingleSample && xDataProp?.length === 1
        ? [xDataProp[0]!, xDataProp[0]!]
        : xDataProp,
    [xDataProp, isSingleSample],
  );
  const { points, referencePoints, areaPath, positiveDeltaPaths, gapRects } =
    useMemo(() => {
      if (data.length === 0) {
        return {
          points: '',
          referencePoints: '',
          areaPath: '',
          positiveDeltaPaths: [] as string[],
          gapRects: [] as { x: number; width: number }[],
        };
      }

      const allValues = [...data, ...(referenceData ?? [])];
      const max = Math.max(maxOverride ?? Math.max(...allValues, 0.01), 1e-9);
      const min = normalize === 'minmax' ? Math.min(...allValues) : 0;
      const valueRange = Math.max(max - min, 1e-9);
      const padding = strokeWidth;
      const drawHeight = height - padding * 2;
      const drawWidth = width - padding * 2;
      const defaultXData = data.map((_, index) => index);
      const chartXData = xData?.length === data.length ? xData : defaultXData;
      const minX = xDomain?.[0] ?? Math.min(...chartXData);
      const maxX = xDomain?.[1] ?? Math.max(...chartXData);
      const xRange = Math.max(maxX - minX, 1);

      // A constant min/max series would otherwise divide by ~0 in minmax mode.
      const isFlatMinMax = normalize === 'minmax' && max - min < 1e-9;

      const toCoordinates = (v: number, i: number) => {
        const x = padding + ((chartXData[i] - minX) / xRange) * drawWidth;
        const normalized = isFlatMinMax ? 0.5 : (v - min) / valueRange;
        const y = padding + drawHeight - normalized * drawHeight;
        return { x, y };
      };

      const lineCoordinates = data.map(toCoordinates);
      const linePoints = lineCoordinates.map(({ x, y }) => `${x},${y}`);
      const referenceCoordinates =
        referenceData && referenceData.length === data.length
          ? referenceData.map(toCoordinates)
          : null;
      const computedReferencePoints = referenceCoordinates
        ? referenceCoordinates.map(({ x, y }) => `${x},${y}`).join(' ')
        : '';

      const firstX = padding + ((chartXData[0] - minX) / xRange) * drawWidth;
      const lastX =
        padding +
        ((chartXData[chartXData.length - 1] - minX) / xRange) * drawWidth;
      const bottomY = padding + drawHeight;

      const positiveDeltaSegments: string[] = [];

      if (referenceCoordinates) {
        let currentSegment: {
          x: number;
          usageY: number;
          referenceY: number;
        }[] = [];

        const flushSegment = () => {
          if (currentSegment.length < 2) {
            currentSegment = [];
            return;
          }

          const upperPath = currentSegment
            .map(({ x, usageY }) => `${x},${usageY}`)
            .join(' L ');
          const lowerPath = [...currentSegment]
            .reverse()
            .map(({ x, referenceY }) => `${x},${referenceY}`)
            .join(' L ');

          positiveDeltaSegments.push(`M ${upperPath} L ${lowerPath} Z`);
          currentSegment = [];
        };

        for (let index = 0; index < data.length - 1; index += 1) {
          const currentUsageValue = data[index]!;
          const nextUsageValue = data[index + 1]!;
          const currentReferenceValue = referenceData![index]!;
          const nextReferenceValue = referenceData![index + 1]!;
          const currentDiff = currentUsageValue - currentReferenceValue;
          const nextDiff = nextUsageValue - nextReferenceValue;
          const currentUsage = lineCoordinates[index]!;
          const nextUsage = lineCoordinates[index + 1]!;
          const currentReference = referenceCoordinates[index]!;
          const nextReference = referenceCoordinates[index + 1]!;

          if (currentDiff > 0 && currentSegment.length === 0) {
            currentSegment.push({
              x: currentUsage.x,
              usageY: currentUsage.y,
              referenceY: currentReference.y,
            });
          }

          if (currentDiff === 0 && nextDiff > 0) {
            currentSegment.push({
              x: currentUsage.x,
              usageY: currentUsage.y,
              referenceY: currentReference.y,
            });
          }

          if (
            (currentDiff > 0 && nextDiff < 0) ||
            (currentDiff < 0 && nextDiff > 0)
          ) {
            const ratio = currentDiff / (currentDiff - nextDiff);
            const crossX =
              currentUsage.x + (nextUsage.x - currentUsage.x) * ratio;
            const crossY =
              currentUsage.y + (nextUsage.y - currentUsage.y) * ratio;

            currentSegment.push({
              x: crossX,
              usageY: crossY,
              referenceY: crossY,
            });

            if (currentDiff > 0) {
              flushSegment();
            } else {
              currentSegment = [
                {
                  x: crossX,
                  usageY: crossY,
                  referenceY: crossY,
                },
              ];
            }
          }

          if (nextDiff > 0) {
            currentSegment.push({
              x: nextUsage.x,
              usageY: nextUsage.y,
              referenceY: nextReference.y,
            });
          }

          if (nextDiff <= 0) {
            flushSegment();
          }
        }
      }

      const gapRects = (gapRanges ?? []).map((gap) => {
        const x1 = padding + ((gap.startMs - minX) / xRange) * drawWidth;
        const x2 = padding + ((gap.endMs - minX) / xRange) * drawWidth;
        return { x: x1, width: Math.max(x2 - x1, 1) };
      });

      return {
        points: linePoints.join(' '),
        referencePoints: computedReferencePoints,
        areaPath: `M ${firstX},${bottomY} L ${linePoints.join(' L ')} L ${lastX},${bottomY} Z`,
        positiveDeltaPaths: positiveDeltaSegments,
        gapRects,
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
      gapRanges,
      normalize,
    ]);

  if (data.length === 0) {
    return null;
  }

  const hasAreaFill = Boolean(fillClassName) || gradientFill || fillOpacity > 0;

  return (
    <svg
      width={width}
      height={height}
      className={clsx(shrink && 'shrink-0', className)}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
    >
      {gradientFill && (
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {hasAreaFill && (
        <path
          d={areaPath}
          className={fillClassName}
          fill={
            fillClassName
              ? undefined
              : gradientFill
                ? `url(#${gradientId})`
                : color
          }
          opacity={fillClassName || gradientFill ? undefined : fillOpacity}
        />
      )}
      {gapRects.map((gap, i) => (
        <rect
          key={i}
          x={gap.x}
          y={strokeWidth}
          width={gap.width}
          height={height - strokeWidth * 2}
          fill="var(--color-ink-3)"
          opacity={0.08}
        />
      ))}
      {positiveDeltaFillColor &&
        positiveDeltaPaths.map((path) => (
          <path
            key={path}
            d={path}
            fill={positiveDeltaFillColor}
            opacity={positiveDeltaFillOpacity}
          />
        ))}
      {referencePoints && (
        <polyline
          points={referencePoints}
          fill="none"
          stroke={referenceColor}
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
        stroke={strokeClassName ? 'currentColor' : color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={strokeClassName}
        pathLength={strokePathLength}
      />
    </svg>
  );
}
