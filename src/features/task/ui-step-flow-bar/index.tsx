import {
  AlertTriangle,
  Archive,
  Check,
  ChevronsLeftRight,
  Circle,
  Loader2,
  Pencil,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';


import { isPrReviewChatStepMeta, type TaskStep, type TaskStepStatus } from '@shared/types';
import { useArchiveStep, useSteps, useUpdateStep } from '@/hooks/use-steps';
import { Button } from '@/common/ui/button';
import { Input } from '@/common/ui/input';
import { Kbd } from '@/common/ui/kbd';
import { Modal } from '@/common/ui/modal';
import { useCommands } from '@/common/hooks/use-commands';
import { useMessageContextMenu } from '@/features/agent/ui-message-stream/ui-message-context-menu';
import { useTaskState } from '@/stores/navigation';
import { useToastStore } from '@/stores/toasts';



const NODE_HEIGHT = 22;
const MIN_NODE_WIDTH = 64;
const MAX_NODE_WIDTH = 220;
const INTER_NODE_GAP = 20;
const ROW_GAP = 4;
const GRAPH_PADDING = 6;

const STEP_X_RANGE_FALLBACK = 88;

function getStepNodeWidth({ step, index }: { step: TaskStep; index: number }) {
  const estimatedCharWidth = 5.3;
  // Group chips render a range label ("10–14") instead of a single index.
  const indexLength = isArchivedGroupId(step.id)
    ? String(index + 1).length * 2 + 1
    : String(index + 1).length;
  const baseWidth =
    30 +
    indexLength * estimatedCharWidth +
    (step.archivedAt ? 0 : step.name.length) * estimatedCharWidth;
  return Math.max(
    MIN_NODE_WIDTH,
    Math.min(MAX_NODE_WIDTH, Math.ceil(baseWidth)),
  );
}

function compareStepOrder(a: TaskStep, b: TaskStep) {
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

export function buildStepGraphLayout(steps: TaskStep[]) {
  const sortedSteps = [...steps].sort(compareStepOrder);
  const byId = new Map(sortedSteps.map((step) => [step.id, step]));
  const nodeWidthById = new Map<string, number>();
  sortedSteps.forEach((step, index) => {
    nodeWidthById.set(step.id, getStepNodeWidth({ step, index }));
  });

  const depsById = new Map<string, string[]>();
  const childrenById = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const step of sortedSteps) {
    const validDeps = step.dependsOn.filter((depId) => byId.has(depId));
    depsById.set(step.id, validDeps);
    indegree.set(step.id, validDeps.length);
    childrenById.set(step.id, []);
  }

  for (const step of sortedSteps) {
    const deps = depsById.get(step.id) ?? [];
    for (const depId of deps) {
      const childList = childrenById.get(depId);
      if (!childList) continue;
      childList.push(step.id);
    }
  }

  const queue = sortedSteps
    .filter((step) => (indegree.get(step.id) ?? 0) === 0)
    .map((step) => step.id);

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const stepId = queue.shift();
    if (!stepId) continue;
    topoOrder.push(stepId);

    const children = childrenById.get(stepId) ?? [];
    for (const childId of children) {
      const nextIndegree = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(childId);
      }
    }
  }

  const hasCycle = topoOrder.length !== sortedSteps.length;

  const laneById = new Map<string, number>();

  const createdSteps = [...sortedSteps].sort((a, b) => {
    const createdCmp = a.createdAt.localeCompare(b.createdAt);
    if (createdCmp !== 0) return createdCmp;
    return compareStepOrder(a, b);
  });

  const timestamps = createdSteps.map((step) => Date.parse(step.createdAt));
  const minTimestamp = Math.min(...timestamps);
  const maxTimestamp = Math.max(...timestamps);
  const timeSpan = Math.max(1, maxTimestamp - minTimestamp);

  const xDomain = Math.max(
    STEP_X_RANGE_FALLBACK,
    (createdSteps.length - 1) * INTER_NODE_GAP,
  );

  const xById = new Map<string, number>();
  let previousRight = GRAPH_PADDING - INTER_NODE_GAP;
  for (const step of createdSteps) {
    const nodeWidth = nodeWidthById.get(step.id) ?? MIN_NODE_WIDTH;
    const timestamp = Date.parse(step.createdAt);
    const normalized = (timestamp - minTimestamp) / timeSpan;
    const timeBasedX = GRAPH_PADDING + normalized * xDomain;
    const x = Math.max(timeBasedX, previousRight + INTER_NODE_GAP);
    xById.set(step.id, x);
    previousRight = x + nodeWidth;
  }

  const previousCreatedIdById = new Map<string, string>();
  for (let i = 1; i < createdSteps.length; i += 1) {
    previousCreatedIdById.set(createdSteps[i].id, createdSteps[i - 1].id);
  }
  const createdIndexById = new Map(
    createdSteps.map((step, index) => [step.id, index]),
  );

  const stepsBySortOrder = new Map(
    sortedSteps.map((step) => [step.sortOrder, step]),
  );
  let maxPreviousSortOrder = Number.NEGATIVE_INFINITY;
  for (const step of createdSteps) {
    if (
      (depsById.get(step.id)?.length ?? 0) === 0 &&
      step.sortOrder < maxPreviousSortOrder
    ) {
      const previousSortStep = stepsBySortOrder.get(step.sortOrder - 1);
      if (previousSortStep) {
        depsById.set(step.id, [previousSortStep.id]);
      }
    }
    maxPreviousSortOrder = Math.max(maxPreviousSortOrder, step.sortOrder);
  }

  let nextBranchLane = 1;
  const laneReasonById = new Map<string, string>();

  for (const step of createdSteps) {
    const depIds = depsById.get(step.id) ?? [];
    const previousCreatedId = previousCreatedIdById.get(step.id);

    if (previousCreatedId && depIds.includes(previousCreatedId)) {
      laneById.set(step.id, laneById.get(previousCreatedId) ?? 0);
      laneReasonById.set(step.id, `continues previous ${previousCreatedId}`);
      continue;
    }

    if (depIds.length > 0) {
      const latestDepId = [...depIds].sort(
        (a, b) =>
          (createdIndexById.get(b) ?? 0) - (createdIndexById.get(a) ?? 0),
      )[0];
      const latestDepLane = latestDepId ? (laneById.get(latestDepId) ?? 0) : 0;
      const latestDepIndex = latestDepId
        ? (createdIndexById.get(latestDepId) ?? -1)
        : -1;
      const stepIndex = createdIndexById.get(step.id) ?? createdSteps.length;
      const laneIsClear = createdSteps
        .slice(latestDepIndex + 1, stepIndex)
        .every((step) => laneById.get(step.id) !== latestDepLane);

      if (laneIsClear) {
        laneById.set(step.id, latestDepLane);
        laneReasonById.set(step.id, `reuses clear dep lane ${latestDepId}`);
        continue;
      }

      laneById.set(step.id, nextBranchLane);
      laneReasonById.set(
        step.id,
        `branches from ${latestDepId}; lane ${latestDepLane} occupied`,
      );
      nextBranchLane += 1;
      continue;
    }

    laneById.set(step.id, 0);
    laneReasonById.set(step.id, 'root');
  }

  const maxLane = Math.max(0, ...Array.from(laneById.values()));
  const laneCount = maxLane + 1;

  const positions = new Map<string, { x: number; y: number }>();
  for (const step of sortedSteps) {
    const lane = laneById.get(step.id) ?? 0;
    const x = xById.get(step.id) ?? GRAPH_PADDING;
    positions.set(step.id, {
      x,
      y: GRAPH_PADDING + lane * (NODE_HEIGHT + ROW_GAP),
    });
  }

  const latestCreatedStep = createdSteps[createdSteps.length - 1];
  const latestCreatedPosition = latestCreatedStep
    ? positions.get(latestCreatedStep.id)
    : undefined;

  if (
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('jc:debug-step-layout') === '1'
  ) {
    console.table(
      createdSteps.map((step) => ({
        id: step.id,
        label: step.name,
        dependsOn: step.dependsOn.join(','),
        sortOrder: step.sortOrder,
        createdAt: step.createdAt,
        lane: laneById.get(step.id) ?? 0,
        x: positions.get(step.id)?.x,
        y: positions.get(step.id)?.y,
        reason: laneReasonById.get(step.id),
      })),
    );
  }

  const edges: Array<{
    id: string;
    fromId: string;
    toId: string;
    fromStatus: TaskStepStatus;
    toStatus: TaskStepStatus;
    isDependency: boolean;
  }> = [];
  const edgeKeySet = new Set<string>();

  for (const step of sortedSteps) {
    const deps = depsById.get(step.id) ?? [];
    for (const depId of deps) {
      const depStep = byId.get(depId);
      if (!depStep) continue;
      const edgeKey = `${depId}->${step.id}`;
      edgeKeySet.add(edgeKey);
      edges.push({
        id: edgeKey,
        fromId: depId,
        toId: step.id,
        fromStatus: depStep.status,
        toStatus: step.status,
        isDependency: true,
      });
    }
  }

  for (let i = 1; i < createdSteps.length; i += 1) {
    const from = createdSteps[i - 1];
    const to = createdSteps[i];
    const edgeKey = `${from.id}->${to.id}`;
    if (edgeKeySet.has(edgeKey)) {
      continue;
    }

    edges.push({
      id: `timeline:${edgeKey}`,
      fromId: from.id,
      toId: to.id,
      fromStatus: from.status,
      toStatus: to.status,
      isDependency: false,
    });
  }

  return {
    sortedSteps,
    positions,
    nodeWidthById,
    edges,
    width: Math.max(
      GRAPH_PADDING * 2 + MIN_NODE_WIDTH,
      ...Array.from(
        positions.entries(),
        ([stepId, pos]) =>
          pos.x + (nodeWidthById.get(stepId) ?? MIN_NODE_WIDTH) + GRAPH_PADDING,
      ),
    ),
    height:
      GRAPH_PADDING * 2 +
      laneCount * NODE_HEIGHT +
      Math.max(0, laneCount - 1) * ROW_GAP,
    addButtonY: latestCreatedPosition?.y ?? GRAPH_PADDING,
    hasCycle,
  };
}

/* ------------------------------------------------------------------ */
/*  Archived run collapsing                                            */
/* ------------------------------------------------------------------ */

export const ARCHIVED_GROUP_PREFIX = 'archived-group:';

export function isArchivedGroupId(id: string) {
  return id.startsWith(ARCHIVED_GROUP_PREFIX);
}

export function buildCollapsedSteps({
  steps,
  expandedGroupIds,
  activeStepId,
}: {
  steps: TaskStep[];
  expandedGroupIds: Set<string>;
  activeStepId?: string | null;
}) {
  const sorted = [...steps].sort(compareStepOrder);
  const displayIndexById = new Map(sorted.map((step, i) => [step.id, i]));
  // Layout places nodes on a createdAt axis; only collapse runs that are also
  // contiguous there, otherwise the group node would overlap steps that sit
  // chronologically between its members.
  const createdIndexById = new Map(
    [...sorted]
      .sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt);
        return cmp !== 0 ? cmp : compareStepOrder(a, b);
      })
      .map((step, i) => [step.id, i]),
  );
  const groups = new Map<
    string,
    { stepIds: string[]; startIndex: number; endIndex: number }
  >();
  const expandedRunFirstIds = new Set<string>();
  const result: TaskStep[] = [];

  let i = 0;
  while (i < sorted.length) {
    if (!sorted[i].archivedAt) {
      result.push(sorted[i]);
      i += 1;
      continue;
    }

    let j = i;
    while (j < sorted.length && sorted[j].archivedAt) j += 1;
    const run = sorted.slice(i, j);

    const createdIndexes = run
      .map((step) => createdIndexById.get(step.id) ?? 0)
      .sort((a, b) => a - b);
    const isCreatedContiguous = createdIndexes.every(
      (value, k) => k === 0 || value === createdIndexes[k - 1] + 1,
    );

    if (run.length < 2 || !isCreatedContiguous) {
      result.push(...run);
      i = j;
      continue;
    }

    const groupId = `${ARCHIVED_GROUP_PREFIX}${run[0].id}`;
    groups.set(groupId, {
      stepIds: run.map((step) => step.id),
      startIndex: i,
      endIndex: j - 1,
    });

    const holdsActiveStep = run.some((step) => step.id === activeStepId);

    if (expandedGroupIds.has(groupId) || holdsActiveStep) {
      expandedRunFirstIds.add(run[0].id);
      result.push(...run);
    } else {
      const last = run[run.length - 1];
      result.push({
        ...last,
        id: groupId,
        name: `${run.length} archived`,
        archivedAt: null,
        dependsOn: run[0].dependsOn,
      });
    }
    i = j;
  }

  const idMap = new Map<string, string>();
  for (const [groupId, group] of groups) {
    if (expandedRunFirstIds.has(group.stepIds[0])) continue;
    for (const stepId of group.stepIds) idMap.set(stepId, groupId);
  }

  const collapsedSteps = result.map((step) => {
    if (step.dependsOn.length === 0) return step;
    const deps = Array.from(
      new Set(step.dependsOn.map((dep) => idMap.get(dep) ?? dep)),
    ).filter((dep) => dep !== step.id);
    const unchanged =
      deps.length === step.dependsOn.length &&
      deps.every((dep, k) => dep === step.dependsOn[k]);
    return unchanged ? step : { ...step, dependsOn: deps };
  });

  return { steps: collapsedSteps, groups, displayIndexById, expandedRunFirstIds };
}

function getEdgeClass({
  fromStatus,
  toStatus,
}: {
  fromStatus: TaskStepStatus;
  toStatus: TaskStepStatus;
}) {
  if (toStatus === 'running') return 'stroke-acc';
  if (toStatus === 'completed') return 'stroke-status-done';
  if (toStatus === 'errored') return 'stroke-status-fail';
  if (toStatus === 'interrupted') return 'stroke-status-run';
  if (fromStatus === 'completed') return 'stroke-status-done/40';
  return 'stroke-line';
}

function getEdgeStrokeClass(isDependency: boolean) {
  return isDependency ? '' : '[stroke-dasharray:4_3] opacity-80';
}

/* ------------------------------------------------------------------ */
/*  Status icon (tiny, sits inside the chip)                           */
/* ------------------------------------------------------------------ */

function StatusIcon({ status }: { status: TaskStepStatus }) {
  const cls = 'h-2.5 w-2.5 shrink-0';

  switch (status) {
    case 'pending':
      return <Circle className={clsx(cls, 'text-ink-4')} strokeWidth={2} />;
    case 'ready':
      return (
        <Circle
          className={clsx(cls, 'text-ink-2')}
          fill="currentColor"
          strokeWidth={0}
        />
      );
    case 'running':
      return <Loader2 className={clsx(cls, 'text-acc-ink animate-spin')} />;
    case 'completed':
      return (
        <Check className={clsx(cls, 'text-status-done')} strokeWidth={3} />
      );
    case 'errored':
      return <X className={clsx(cls, 'text-status-fail')} strokeWidth={3} />;
    case 'interrupted':
      return (
        <AlertTriangle
          className={clsx(cls, 'text-status-run')}
          strokeWidth={2.5}
        />
      );
  }
}

/* ------------------------------------------------------------------ */
/*  Step type icon (overrides status icon for special step types)       */
/* ------------------------------------------------------------------ */

function StepTypeIcon({ step }: { step: TaskStep }) {
  if (step.type === 'review') {
    const cls = 'h-2.5 w-2.5 shrink-0';
    if (step.status === 'running') {
      return <Search className={clsx(cls, 'text-acc-ink animate-pulse')} />;
    }
    if (step.status === 'completed') {
      return <Search className={clsx(cls, 'text-status-done')} />;
    }
    if (step.status === 'errored') {
      return <Search className={clsx(cls, 'text-status-fail')} />;
    }
    return <Search className={clsx(cls, 'text-ink-2')} />;
  }
  return <StatusIcon status={step.status} />;
}

/* ------------------------------------------------------------------ */
/*  Chip styles per status                                             */
/* ------------------------------------------------------------------ */

const CHIP_STYLES: Record<TaskStepStatus, string> = {
  pending:
    'border border-line-soft bg-bg-0 text-ink-3 cursor-pointer hover:border-glass-border hover:text-ink-2',
  ready:
    'border border-glass-border bg-glass-light text-ink-1 cursor-pointer hover:bg-glass-medium hover:border-glass-border-strong',
  running: 'step-chip-running text-acc-ink cursor-pointer',
  completed:
    'border border-status-done/30 bg-status-done-soft text-status-done hover:bg-status-done/15 cursor-pointer shadow-[inset_0_1px_0_0_color-mix(in_srgb,var(--color-status-done)_6%,transparent)]',
  errored:
    'border border-status-fail/30 bg-status-fail-soft text-status-fail cursor-pointer hover:bg-status-fail/15',
  interrupted:
    'border border-status-run/30 bg-status-run-soft text-status-run cursor-pointer hover:bg-status-run/15',
};

/* ------------------------------------------------------------------ */
/*  Step chip                                                          */
/* ------------------------------------------------------------------ */

function StepChip({
  step,
  index,
  indexLabel,
  isArchivedGroup,
  isActive,
  onClick,
  onAddAfter,
  onCollapse,
  onContextMenu,
}: {
  step: TaskStep;
  index: number;
  indexLabel?: string;
  isArchivedGroup?: boolean;
  isActive: boolean;
  onClick: () => void;
  onAddAfter?: (stepId: string) => void;
  onCollapse?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isActive && ref.current) {
      ref.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [isActive]);

  return (
    <div className="group/step relative flex h-full w-full items-center">
      <Button
        ref={ref}
        variant="unstyled"
        onClick={onClick}
        onContextMenu={onContextMenu}
        aria-expanded={isArchivedGroup ? false : undefined}
        className={clsx(
          'h-full w-full gap-1 rounded-md px-1.5 py-0.5 text-[10px] leading-none transition-all duration-300 ease-out',
          CHIP_STYLES[step.status],
          isActive &&
            'ring-acc/70 ring-offset-bg-0 shadow-[0_0_10px_0_color-mix(in_srgb,var(--color-acc)_30%,transparent),0_0_3px_0_color-mix(in_srgb,var(--color-acc)_20%,transparent)] ring-[1.5px] ring-offset-[1.5px] brightness-125',
          (step.archivedAt || isArchivedGroup) && 'opacity-45 grayscale',
        )}
        title={
          isArchivedGroup
            ? `${step.name} — click to expand`
            : step.archivedAt
              ? `${step.name} (archived)`
              : step.name
        }
      >
        {isArchivedGroup ? (
          <Archive className="h-2.5 w-2.5 shrink-0" />
        ) : (
          <StepTypeIcon step={step} />
        )}
        <span className="flex min-w-0 items-center gap-0.5">
          <span className="text-[9px] opacity-40">
            {indexLabel ?? index + 1}
          </span>
          {(!step.archivedAt || isArchivedGroup) && (
            <span className="min-w-0 truncate">{step.name}</span>
          )}
        </span>
      </Button>
      {onCollapse && (
        <Button
          variant="unstyled"
          onClick={(event) => {
            event.stopPropagation();
            onCollapse();
          }}
          className="border-line bg-bg-1 text-ink-2 hover:border-glass-border-strong hover:text-ink-1 absolute top-1/2 -left-1.5 z-10 h-3.5 w-3.5 -translate-y-1/2 rounded-full border p-0 opacity-0 transition-all group-hover/step:opacity-100 focus-visible:opacity-100"
          title="Collapse archived steps"
        >
          <ChevronsLeftRight className="h-2 w-2" />
        </Button>
      )}
      {onAddAfter && (
        <Button
          variant="unstyled"
          onClick={(event) => {
            event.stopPropagation();
            onAddAfter(step.id);
          }}
          className="border-line bg-bg-1 text-ink-2 hover:border-glass-border-strong hover:text-ink-1 absolute top-1/2 -right-1.5 z-10 h-3.5 w-3.5 -translate-y-1/2 rounded-full border p-0 opacity-0 transition-all group-hover/step:opacity-100 focus-visible:opacity-100"
          title="Add step after this step"
        >
          <Plus className="h-2 w-2" />
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Bar                                                                */
/* ------------------------------------------------------------------ */

export function StepFlowBar({
  taskId,
  onAddStepAtEnd,
  onAddStepAfter,
}: {
  taskId: string;
  onAddStepAtEnd?: () => void;
  onAddStepAfter?: (afterStepId: string) => void;
}) {
  const { data: steps } = useSteps(taskId);
  const { activeStepId, setActiveStepId } = useTaskState(taskId);
  const archiveStep = useArchiveStep();
  const updateStep = useUpdateStep();
  const addToast = useToastStore((state) => state.addToast);
  const [renameStep, setRenameStep] = useState<TaskStep | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const { openMenu, portal } = useMessageContextMenu({
    overlayId: 'step-context-menu',
  });
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const collapsed = useMemo(
    () =>
      buildCollapsedSteps({
        steps: steps ?? [],
        expandedGroupIds,
        activeStepId,
      }),
    [steps, expandedGroupIds, activeStepId],
  );
  const layout = useMemo(
    () => buildStepGraphLayout(collapsed.steps),
    [collapsed.steps],
  );

  const knownGroupIds = collapsed.groups;
  const toggleGroup = useCallback(
    (groupId: string) => {
      setExpandedGroupIds((previous) => {
        // Group ids derive from step ids, so archiving/unarchiving can leave
        // entries pointing at groups that no longer exist — drop them here.
        const next = new Set(
          Array.from(previous).filter((id) => knownGroupIds.has(id)),
        );
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        return next;
      });
    },
    [knownGroupIds],
  );

  const handleStepClick = useCallback(
    (stepId: string) => {
      if (isArchivedGroupId(stepId)) {
        toggleGroup(stepId);
        return;
      }
      setActiveStepId(stepId);
    },
    [setActiveStepId, toggleGroup],
  );

  const handleStepContextMenu = useCallback(
    (event: React.MouseEvent, step: TaskStep) => {
      if (
        step.archivedAt ||
        isArchivedGroupId(step.id) ||
        isPrReviewChatStepMeta(step.meta)
      )
        return;
      openMenu(event, [
        {
          label: 'Rename step',
          icon: <Pencil />,
          onClick: () => {
            setRenameDraft(step.name);
            setRenameStep(step);
          },
        },
        {
          label: 'Archive step',
          icon: <Archive />,
          onClick: () => {
            archiveStep.mutate(step.id, {
              onSuccess: () =>
                addToast({ type: 'success', message: 'Step archived.' }),
              onError: (error) =>
                addToast({
                  type: 'error',
                  message:
                    error instanceof Error
                      ? error.message
                      : 'Failed to archive step.',
                }),
            });
          },
        },
      ]);
    },
    [addToast, archiveStep, openMenu],
  );

  useCommands('step-flow-bar', [
    !!onAddStepAtEnd && {
      label: 'Add Step',
      shortcut: 'cmd+shift+n',
      section: 'Task',
      handler: () => {
        onAddStepAtEnd();
      },
    },
  ]);

  if (!steps || steps.length === 0) return null;

  return (
    <div className="relative px-4 py-px backdrop-blur-sm">
      <div className="no-scrollbar flex items-center overflow-x-auto px-1 py-0.5">
        <div
          className="relative"
          style={{
            width: layout.width + (onAddStepAtEnd ? 44 : 0),
            height: layout.height,
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            fill="none"
          >
            {layout.edges.map((edge) => {
              const fromPos = layout.positions.get(edge.fromId);
              const toPos = layout.positions.get(edge.toId);
              if (!fromPos || !toPos) return null;
              const fromWidth =
                layout.nodeWidthById.get(edge.fromId) ?? MIN_NODE_WIDTH;
              const startX = fromPos.x + fromWidth;
              const startY = fromPos.y + NODE_HEIGHT / 2;
              const endX = toPos.x;
              const endY = toPos.y + NODE_HEIGHT / 2;
              const horizontalGap = Math.max(4, endX - startX);
              const jogX = startX + Math.min(6, horizontalGap * 0.5);

              const d =
                Math.abs(endY - startY) < 1
                  ? `M ${startX} ${startY} L ${endX} ${endY}`
                  : `M ${startX} ${startY} L ${jogX} ${startY} L ${jogX} ${endY} L ${endX} ${endY}`;

              return (
                <path
                  key={edge.id}
                  d={d}
                  className={clsx(
                    'fill-none stroke-[1.5] transition-colors',
                    getEdgeClass(edge),
                    getEdgeStrokeClass(edge.isDependency),
                  )}
                />
              );
            })}
          </svg>

          {layout.sortedSteps.map((step, index) => {
            const pos = layout.positions.get(step.id);
            if (!pos) return null;

            const group = collapsed.groups.get(step.id);
            const isGroup = !!group;
            const indexLabel = isGroup
              ? `${group.startIndex + 1}–${group.endIndex + 1}`
              : `${(collapsed.displayIndexById.get(step.id) ?? index) + 1}`;
            const expandedRunGroupId = collapsed.expandedRunFirstIds.has(
              step.id,
            )
              ? `${ARCHIVED_GROUP_PREFIX}${step.id}`
              : undefined;
            // Never offer collapse when it would hide the active step.
            const canCollapseRun =
              !!expandedRunGroupId &&
              !collapsed.groups
                .get(expandedRunGroupId)
                ?.stepIds.includes(activeStepId ?? '');

            return (
              <div
                key={step.id}
                className="absolute"
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: layout.nodeWidthById.get(step.id) ?? MIN_NODE_WIDTH,
                  height: NODE_HEIGHT,
                }}
              >
                <StepChip
                  step={step}
                  index={index}
                  indexLabel={indexLabel}
                  isArchivedGroup={isGroup}
                  isActive={activeStepId === step.id}
                  onClick={() => handleStepClick(step.id)}
                  onAddAfter={isGroup ? undefined : onAddStepAfter}
                  onCollapse={
                    expandedRunGroupId && canCollapseRun
                      ? () => toggleGroup(expandedRunGroupId)
                      : undefined
                  }
                  onContextMenu={(event) => handleStepContextMenu(event, step)}
                />
              </div>
            );
          })}

          {onAddStepAtEnd && (
            <div
              className="absolute flex items-center"
              style={{
                left: layout.width,
                top: layout.addButtonY,
                height: NODE_HEIGHT,
              }}
            >
              <Button
                variant="unstyled"
                onClick={onAddStepAtEnd}
                title="Add step at end (⌘⇧N)"
                className="border-line/60 text-ink-4 hover:border-glass-border-strong hover:text-ink-2 h-4 shrink-0 gap-1 rounded-md border border-dashed px-1 transition-colors"
              >
                <Plus className="h-2.5 w-2.5" />
              </Button>
            </div>
          )}

          {layout.hasCycle && (
            <div className="border-status-run/30 bg-status-run-soft text-status-run absolute top-0 right-0 rounded border px-2 py-1 text-[10px]">
              Dependency cycle detected
            </div>
          )}
        </div>
      </div>
      {portal}
      <Modal
        isOpen={!!renameStep}
        onClose={() => setRenameStep(null)}
        title="Rename step"
        closeOnClickOutside={!updateStep.isPending}
        closeOnEscape={!updateStep.isPending}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const nextName = renameDraft.trim();
            if (!renameStep || !nextName || nextName === renameStep.name) {
              setRenameStep(null);
              return;
            }

            updateStep.mutate(
              { stepId: renameStep.id, data: { name: nextName } },
              {
                onSuccess: () => setRenameStep(null),
                onError: (error) =>
                  addToast({
                    type: 'error',
                    message:
                      error instanceof Error
                        ? error.message
                        : 'Failed to rename step.',
                  }),
              },
            );
          }}
        >
          <Input
            autoFocus
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setRenameStep(null);
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            disabled={updateStep.isPending}
            aria-label="Step name"
          />
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRenameStep(null)}
              disabled={updateStep.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={updateStep.isPending}
              disabled={updateStep.isPending || !renameDraft.trim()}
            >
              Rename
              <Kbd shortcut="cmd+enter" />
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
