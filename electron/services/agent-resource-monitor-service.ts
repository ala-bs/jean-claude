import {
  AGENT_RESOURCE_HIGH_FREQUENCY_SAMPLING_INTERVAL_MS,
  AGENT_RESOURCE_SAMPLING_INTERVAL_MS,
  type AgentResourceSnapshot,
  type AgentResourceSummary,
} from '@shared/agent-resource-types';
import type { AgentBackendType } from '@shared/agent-backend-types';


import {
  type ProcessTreeSample,
  sampleProcessTree,
} from './process-resource-sampler';

type TrackedSession = {
  taskId: string;
  stepId: string;
  backend: AgentBackendType;
  rootPid: number | null;
  startedAt: number;
  timer: ReturnType<typeof setInterval> | null;
  sampleCount: number;
  cpuTotal: number;
  rssTotal: number;
  peakCpuPercent: number;
  peakRssBytes: number;
  latest: AgentResourceSnapshot | null;
  sampling: Promise<void> | null;
  pendingImmediateSample: boolean;
};

const DEFAULT_RESOURCE_HISTORY_WINDOW_MS = 60 * 60 * 1_000;

type AgentResourceMonitorDeps = {
  intervalMs?: number;
  highFrequencyIntervalMs?: number;
  historyWindowMs?: number;
  sampler?: (rootPid: number) => Promise<ProcessTreeSample>;
  onSnapshot?: (snapshot: AgentResourceSnapshot) => void;
  now?: () => number;
};

export class AgentResourceMonitorService {
  private sessions = new Map<string, TrackedSession>();

  private historyByStepId = new Map<string, AgentResourceSnapshot[]>();

  private onSnapshot?: (snapshot: AgentResourceSnapshot) => void;

  private highFrequencySampling = false;

  constructor(private readonly deps: AgentResourceMonitorDeps = {}) {
    this.onSnapshot = deps.onSnapshot;
  }

  setSnapshotListener(
    listener?: (snapshot: AgentResourceSnapshot) => void,
  ): void {
    this.onSnapshot = listener;
  }

  start(params: {
    taskId: string;
    stepId: string;
    backend: AgentBackendType;
    rootPid: number | null;
  }): void {
    void this.stop(params.stepId);

    const session: TrackedSession = {
      ...params,
      startedAt: this.now(),
      timer: null,
      sampleCount: 0,
      cpuTotal: 0,
      rssTotal: 0,
      peakCpuPercent: 0,
      peakRssBytes: 0,
      latest: null,
      sampling: null,
      pendingImmediateSample: false,
    };
    this.sessions.set(params.stepId, session);

    this.queueSample(session);
    this.scheduleTimer(session);
  }

  setHighFrequencySampling(enabled: boolean): void {
    if (this.highFrequencySampling === enabled) return;

    this.highFrequencySampling = enabled;
    for (const session of this.sessions.values()) {
      this.scheduleTimer(session);
      if (enabled) {
        this.queueSample(session, { resampleIfBusy: true });
      } else {
        session.pendingImmediateSample = false;
      }
    }
  }

  getSnapshots(): AgentResourceSnapshot[] {
    return Array.from(this.sessions.values())
      .map((session) => session.latest)
      .filter(
        (snapshot): snapshot is AgentResourceSnapshot => snapshot !== null,
      );
  }

  getHistory(): Record<string, AgentResourceSnapshot[]> {
    this.pruneHistory();
    return Object.fromEntries(this.historyByStepId.entries());
  }

  async stop(stepId: string): Promise<AgentResourceSummary | null> {
    const session = this.sessions.get(stepId);
    if (!session) return null;

    if (session.timer) clearInterval(session.timer);
    session.pendingImmediateSample = false;
    await session.sampling;
    if (this.sessions.get(stepId) === session) {
      this.sessions.delete(stepId);
    }

    const endedAt = this.now();
    const summary: AgentResourceSummary = {
      id: `${session.stepId}:${session.startedAt}`,
      taskId: session.taskId,
      stepId: session.stepId,
      backend: session.backend,
      rootPid: session.rootPid,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - session.startedAt,
      sampleCount: session.sampleCount,
      avgCpuPercent: session.sampleCount
        ? session.cpuTotal / session.sampleCount
        : 0,
      peakCpuPercent: session.peakCpuPercent,
      avgRssBytes: session.sampleCount
        ? session.rssTotal / session.sampleCount
        : 0,
      peakRssBytes: session.peakRssBytes,
    };

    return summary;
  }

  private queueSample(
    session: TrackedSession,
    { resampleIfBusy = false }: { resampleIfBusy?: boolean } = {},
  ): void {
    if (session.sampling) {
      if (resampleIfBusy) session.pendingImmediateSample = true;
      return;
    }

    const sampling = this.sample(session).finally(() => {
      if (session.sampling !== sampling) return;

      session.sampling = null;
      if (
        session.pendingImmediateSample &&
        this.sessions.get(session.stepId) === session
      ) {
        session.pendingImmediateSample = false;
        this.queueSample(session);
      }
    });
    session.sampling = sampling;
  }

  private scheduleTimer(session: TrackedSession): void {
    if (session.timer) clearInterval(session.timer);
    session.timer = setInterval(
      () => this.queueSample(session),
      this.getSamplingIntervalMs(),
    );
  }

  private getSamplingIntervalMs(): number {
    if (this.highFrequencySampling) {
      return (
        this.deps.highFrequencyIntervalMs ??
        AGENT_RESOURCE_HIGH_FREQUENCY_SAMPLING_INTERVAL_MS
      );
    }
    return this.deps.intervalMs ?? AGENT_RESOURCE_SAMPLING_INTERVAL_MS;
  }

  private async sample(session: TrackedSession): Promise<void> {
    const sample =
      session.rootPid === null
        ? {
            pids: [],
            cpuPercent: 0,
            rssBytes: 0,
            unsupportedReason: 'backend did not expose a root PID',
          }
        : await (
            this.deps.sampler ?? ((rootPid) => sampleProcessTree({ rootPid }))
          )(session.rootPid);

    if (this.sessions.get(session.stepId) !== session) {
      return;
    }

    session.sampleCount += 1;
    session.cpuTotal += sample.cpuPercent;
    session.rssTotal += sample.rssBytes;
    session.peakCpuPercent = Math.max(
      session.peakCpuPercent,
      sample.cpuPercent,
    );
    session.peakRssBytes = Math.max(session.peakRssBytes, sample.rssBytes);

    const snapshot: AgentResourceSnapshot = {
      stepId: session.stepId,
      taskId: session.taskId,
      backend: session.backend,
      rootPid: session.rootPid,
      pids: sample.pids,
      sampledAt: new Date(this.now()).toISOString(),
      cpuPercent: sample.cpuPercent,
      rssBytes: sample.rssBytes,
      peakCpuPercent: session.peakCpuPercent,
      peakRssBytes: session.peakRssBytes,
      sampleCount: session.sampleCount,
      ...(sample.unsupportedReason
        ? { unsupportedReason: sample.unsupportedReason }
        : {}),
    };

    session.latest = snapshot;
    this.recordHistory(snapshot);
    this.onSnapshot?.(snapshot);
  }

  private recordHistory(snapshot: AgentResourceSnapshot): void {
    const existing = this.historyByStepId.get(snapshot.stepId);
    if (existing) {
      existing.push(snapshot);
    } else {
      this.historyByStepId.set(snapshot.stepId, [snapshot]);
    }
    this.pruneHistory();
  }

  private pruneHistory(): void {
    const cutoff =
    this.now() -
      (this.deps.historyWindowMs ?? DEFAULT_RESOURCE_HISTORY_WINDOW_MS);
    for (const [stepId, history] of this.historyByStepId.entries()) {
      const firstValidIndex = history.findIndex(
        (snapshot) => Date.parse(snapshot.sampledAt) >= cutoff,
      );
      if (firstValidIndex === -1) {
        this.historyByStepId.delete(stepId);
      } else if (firstValidIndex > 0) {
        history.splice(0, firstValidIndex);
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

export const agentResourceMonitorService = new AgentResourceMonitorService();
