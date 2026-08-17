import {
  MAX_MEMORY_USAGE_SAMPLES,
  type MemoryUsageSample,
  useMemoryUsage,
} from '@/hooks/use-memory-usage';
import { Sparkline } from '@/common/ui/sparkline';
import { Tooltip } from '@/common/ui/tooltip';
import {
  formatCpuPercentValue,
  splitResourceBytes,
} from '@/lib/format-resource-usage';
import { useOverlaysStore } from '@/stores/overlays';
import { useState } from 'react';

const COLOR_MEM = 'var(--color-acc-ink)';
const COLOR_PROC = 'var(--color-status-done)';
const COLOR_CPU = 'var(--color-status-review)';

function Spark({
  values,
  color,
  width,
  height,
  strokeWidth = 1.3,
  fillArea = false,
}: {
  values: number[];
  color: string;
  width: number;
  height: number;
  strokeWidth?: number;
  fillArea?: boolean;
}) {
  return (
    <Sparkline
      data={values}
      width={width}
      height={height}
      strokeWidth={strokeWidth}
      color={color}
      normalize="minmax"
      gradientFill={fillArea}
      fillOpacity={0}
      className="block"
    />
  );
}

function Num({
  value,
  unit,
  className,
}: {
  value: string;
  unit: string;
  className?: string;
}) {
  return (
    <span
      className={`text-ink-0 font-mono font-semibold tabular-nums tracking-tight ${className ?? ''}`}
    >
      {value}
      <span className="text-ink-3 ml-0.5 text-[0.75em] font-medium">
        {unit}
      </span>
    </span>
  );
}

function Cell({
  label,
  value,
  unit,
  values,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  values: number[];
  color: string;
}) {
  return (
    <div className="flex h-[22px] items-center gap-2">
      <span className="text-ink-3 min-w-0 flex-1 truncate text-[10.5px]">
        {label}
      </span>
      <Num value={value} unit={unit} className="text-[11.5px]" />
      <Spark values={values} color={color} width={30} height={11} />
    </div>
  );
}

function ColumnHeading({ children }: { children: string }) {
  return (
    <div className="text-ink-4 mb-1 text-[9.5px] font-semibold tracking-[0.08em] uppercase">
      {children}
    </div>
  );
}

export function RamUsageDisplay() {
  const { data, history } = useMemoryUsage();
  const openOverlay = useOverlaysStore((s) => s.open);
  const isResourcesOpen = useOverlaysStore(
    (s) => s.activeOverlay === 'resources',
  );
  const [nowMs] = useState(() => Date.now());

  if (!data) return null;

  const series = {
    totalRss: history.map((sample) => sample.totalRssBytes),
    mainRss: history.map((sample) => sample.mainProcess.rssBytes),
    mainHeap: history.map((sample) => sample.mainProcess.heapUsedBytes),
    mainCpu: history.map((sample) => sample.mainProcess.cpuPercent),
    rendererRss: history.map((sample) => sample.rendererProcess.rssBytes),
    rendererPrivate: history.map(
      (sample) => sample.rendererProcess.privateBytes,
    ),
    rendererCpu: history.map((sample) => sample.rendererProcess.cpuPercent),
    gpuCpu: history.map((sample) => sample.gpuCpuPercent),
  };

  const oldestSample = history[0] as MemoryUsageSample | undefined;
  const historyMinutes = oldestSample
    ? Math.max(1, Math.round((nowMs - oldestSample.sampledAt) / 60_000))
    : 0;

  const totalCpu =
    data.mainProcess.cpuPercent + data.rendererProcess.cpuPercent;
  const totalRss = splitResourceBytes(data.totalRssBytes);

  const trigger = (
    <div
      className="border-line-soft hover:border-line flex h-[22px] cursor-pointer items-center gap-1.5 rounded-[5px] border bg-black/25 px-1.5 hover:bg-white/[0.07] focus:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
      role="button"
      tabIndex={0}
      title="Open resource metrics"
      aria-label="Open resource metrics"
      onClick={() => openOverlay('resources')}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openOverlay('resources');
        }
      }}
    >
      <Spark
        values={series.totalRss}
        color={COLOR_MEM}
        width={18}
        height={10}
      />
      <span className="text-ink-1 font-mono text-[10.5px] font-semibold tabular-nums">
        {totalRss.value}
        <span className="text-ink-3 ml-px font-medium">
          {totalRss.unit[0]}
        </span>
      </span>
      <span className="text-ink-2 font-mono text-[10.5px] font-semibold tabular-nums">
        {formatCpuPercentValue(totalCpu)}
        <span className="text-ink-3 ml-px font-medium">%</span>
      </span>
    </div>
  );

  if (isResourcesOpen) return trigger;

  return (
    <Tooltip
      className="!w-[296px] !overflow-hidden !p-0"
      content={
        <div>
          <div className="px-3 pt-2.5 pb-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-ink-3 text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                Total RSS
              </span>
              <div className="flex-1" />
              <span className="text-ink-4 font-mono text-[10px]">
                {history.length}/{MAX_MEMORY_USAGE_SAMPLES} samples
              </span>
            </div>
            <div className="flex items-end gap-2.5">
              <Num
                {...splitResourceBytes(data.totalRssBytes)}
                className="text-[22px]"
              />
              <div className="mb-0.5 flex-1">
                <Spark
                  values={series.totalRss}
                  color={COLOR_MEM}
                  width={170}
                  height={30}
                  strokeWidth={1.5}
                  fillArea
                />
              </div>
            </div>
          </div>
          <div className="bg-line-soft h-px" />
          <div className="grid grid-cols-[1fr_1px_1fr]">
            <div className="px-3 pt-2 pb-2.5">
              <ColumnHeading>Main</ColumnHeading>
              <Cell
                label="RSS"
                {...splitResourceBytes(data.mainProcess.rssBytes)}
                values={series.mainRss}
                color={COLOR_PROC}
              />
              <Cell
                label="Heap"
                {...splitResourceBytes(data.mainProcess.heapUsedBytes)}
                values={series.mainHeap}
                color={COLOR_PROC}
              />
              <Cell
                label="CPU"
                value={formatCpuPercentValue(data.mainProcess.cpuPercent)}
                unit="%"
                values={series.mainCpu}
                color={COLOR_CPU}
              />
            </div>
            <div className="bg-line-soft" />
            <div className="px-3 pt-2 pb-2.5">
              <ColumnHeading>Renderer</ColumnHeading>
              <Cell
                label="RSS"
                {...splitResourceBytes(data.rendererProcess.rssBytes)}
                values={series.rendererRss}
                color={COLOR_PROC}
              />
              <Cell
                label="Private"
                {...splitResourceBytes(data.rendererProcess.privateBytes)}
                values={series.rendererPrivate}
                color={COLOR_PROC}
              />
              <Cell
                label="CPU"
                value={formatCpuPercentValue(data.rendererProcess.cpuPercent)}
                unit="%"
                values={series.rendererCpu}
                color={COLOR_CPU}
              />
            </div>
          </div>
          <div className="bg-line-soft h-px" />
          <div className="flex items-center gap-2 bg-black/20 px-3 py-1.5">
            <span className="text-ink-3 text-[10.5px]">GPU CPU</span>
            <Num
              value={formatCpuPercentValue(data.gpuCpuPercent)}
              unit="%"
              className="text-[11.5px]"
            />
            <Spark
              values={series.gpuCpu}
              color={COLOR_CPU}
              width={34}
              height={11}
            />
            <div className="flex-1" />
            <span className="text-ink-4 font-mono text-[9.5px]">
              {historyMinutes}m window
            </span>
          </div>
        </div>
      }
      side="bottom"
    >
      {trigger}
    </Tooltip>
  );
}
