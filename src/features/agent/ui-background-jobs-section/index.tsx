import { useTaskMessagesStore } from '@/stores/task-messages';

/**
 * Live section for background jobs the agent is still waiting on
 * (background subagents, `run_in_background` shells, Monitor).
 *
 * The Claude CLI ends a turn with a `result` while background work keeps
 * streaming, so without this the step reads as "done" while the agent is
 * really parked waiting on its own jobs.
 *
 * Rendered inside the prompt group's agent section, same shape as the
 * subagents / tools sections.
 */
export function BackgroundJobsSection({ stepId }: { stepId: string | null }) {
  const tasks = useTaskMessagesStore((state) =>
    stepId ? state.backgroundTasksByStepId[stepId] : undefined,
  );

  if (!tasks || tasks.length === 0) return null;

  return (
    <div className="text-ink-1 font-mono text-xs">
      <div className="text-ink-4 mb-1.5 flex items-center gap-1.5 font-mono text-[10px] tracking-wider uppercase">
        <span className="text-acc-ink">◆</span>
        <span>background jobs</span>
        <span
          className="text-acc-ink inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-semibold tracking-normal"
          style={{
            background: 'color-mix(in oklch, var(--color-acc) 18%, transparent)',
          }}
        >
          <span
            className="rg-pulse-glow bg-acc h-1 w-1 rounded-full"
            style={{ animation: 'rg-pulse-glow 1.4s ease-in-out infinite' }}
          />
          {tasks.length} running
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {tasks.map((task) => (
          <div
            key={task.taskId}
            className="text-ink-2 flex items-baseline gap-2"
          >
            <span className="text-ink-4 w-3 shrink-0 text-center">⏳</span>
            <span className="flex-1 truncate">
              {task.description?.trim() || task.taskId}
            </span>
          </div>
        ))}
      </div>
      <div className="text-ink-4 mt-1 text-[10px]">
        Waiting for these to finish before the step ends.
      </div>
    </div>
  );
}
