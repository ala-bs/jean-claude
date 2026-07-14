import type { WebContents } from 'electron';

import { agentResourceMonitorService } from './agent-resource-monitor-service';

type SamplingLeaseOwner = Pick<WebContents, 'id' | 'on' | 'once'>;

export class AgentResourceSamplingLeaseService {
  private activeOwnerIds = new Set<number>();

  private trackedOwnerIds = new Set<number>();

  private highFrequencySampling = false;

  constructor(
    private readonly deps: {
      setHighFrequencySampling: (enabled: boolean) => void;
    },
  ) {}

  setSampling(owner: SamplingLeaseOwner, enabled: boolean): void {
    if (enabled) {
      this.activeOwnerIds.add(owner.id);
      this.trackOwner(owner);
    } else {
      this.activeOwnerIds.delete(owner.id);
    }
    this.updateSamplingMode();
  }

  private trackOwner(owner: SamplingLeaseOwner): void {
    if (this.trackedOwnerIds.has(owner.id)) return;

    this.trackedOwnerIds.add(owner.id);
    owner.on('render-process-gone', () => this.releaseSampling(owner.id));
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.releaseSampling(owner.id);
      }
    });
    owner.once('destroyed', () => {
      this.trackedOwnerIds.delete(owner.id);
      this.releaseSampling(owner.id);
    });
  }

  private releaseSampling(ownerId: number): void {
    this.activeOwnerIds.delete(ownerId);
    this.updateSamplingMode();
  }

  private updateSamplingMode(): void {
    const highFrequencySampling = this.activeOwnerIds.size > 0;
    if (highFrequencySampling === this.highFrequencySampling) return;

    this.highFrequencySampling = highFrequencySampling;
    this.deps.setHighFrequencySampling(highFrequencySampling);
  }
}

export const agentResourceSamplingLeaseService =
  new AgentResourceSamplingLeaseService({
    setHighFrequencySampling: (enabled) =>
      agentResourceMonitorService.setHighFrequencySampling(enabled),
  });
