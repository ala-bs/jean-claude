// Rate-limit fallback (design §4 / §8).
//
// The old chain model stored a per-entry `(backend, model, thinkingEffort)`
// triple and returned it directly. It now walks `modelFallbackOrder` — an
// ordered list of *profile* ids — and the next profile's `agent` role supplies
// the triple. Because a profile binds every role, the swap moves the
// AI-generation features along with the main agent.
//
// Two rules from the design are load-bearing here:
//
// - §4: running steps keep their model. `resolveBackend` never touches a live
//   session; only sessions created after the switch pick the new profile up.
// - §8: a project in `enforce` mode whose permitted backend is rate-limited
//   gets a blocking error and *no* fallback. Silently running on a banned
//   backend is worse than not running. Projects in `inherit` / `prefer` fall
//   back normally, so a global rate limit never blocks unrestricted projects.

import { BrowserWindow } from 'electron';

import type { ModelProfile, ModelTriple } from '../../shared/model-profiles';
import type { AgentBackendType } from '../../shared/agent-backend-types';
import { SettingsRepository } from '../database/repositories/settings';
import type { ThinkingEffort } from '../../shared/types';
import { tripleForBinding } from '../../shared/model-profiles';
import type { UsageProviderType } from '../../shared/usage-types';

import {
  getModelProfileService,
  type ModelProfileService,
} from './model-profile-service';
import { agentUsageService } from './agent-usage-service';

export interface SwapResult {
  backend: AgentBackendType;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  swapped: boolean;
  skippedDueToRateLimit?: boolean;
  /** Profile that was (or would be) activated by this swap. */
  profileId?: string;
  /**
   * Set when a project policy forbids the fallback (design §8). The caller must
   * surface this as a visible error instead of running.
   */
  blocked?: {
    reason: 'backend-not-allowed' | 'profile-not-allowed';
    message: string;
    allowedBackends?: AgentBackendType[];
    allowedProfileIds?: string[];
  };
}

/**
 * Utilization at (or above) which a backend counts as rate-limited. The old
 * per-entry thresholds disappeared with the chain; the fallback order is a
 * plain list of profiles.
 */
export const RATE_LIMIT_UTILIZATION_THRESHOLD = 0.9;

const BACKEND_TO_USAGE_PROVIDER: Partial<
  Record<AgentBackendType, UsageProviderType>
> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  copilot: 'copilot',
};

/**
 * The triple a profile's `agent` role holds.
 *
 * Revision 1: a role stores its selection inline, so there is no preset list to
 * look through and no way for the binding to dangle.
 */
/** Human-readable profile name for a policy message, falling back to the id. */
function profileName(profiles: ModelProfile[], id: string): string {
  return profiles.find((profile) => profile.id === id)?.name || id;
}

function agentTripleOfProfile(profile: ModelProfile): ModelTriple | null {
  // A role may bind to one of the profile's presets by reference, so the
  // binding is not necessarily a triple itself.
  return tripleForBinding({
    binding: profile.roles.agent,
    presets: profile.presets,
  });
}

export class RateLimitSwapService {
  private notifiedBackends = new Set<string>();

  constructor(
    private readonly deps: {
      modelProfileService: () => ModelProfileService;
    } = { modelProfileService: getModelProfileService },
  ) {}

  /**
   * Resolves the backend to use when `requestedBackend` may be rate-limited.
   *
   * `activate` defaults to **false**: several callers (the status probe, the
   * AI-generation helper) only want to know what the fallback *would* be, and
   * flipping the globally active profile as a side effect of a probe would be a
   * bug. Pass `activate: true` from the code path that actually reacts to the
   * rate limit.
   */
  async resolveBackend(
    requestedBackend: AgentBackendType,
    options: {
      notify?: boolean;
      activate?: boolean;
      /** Project whose policy must not be violated (design §8). */
      projectId?: string | null;
      threshold?: number;
    } = {},
  ): Promise<SwapResult> {
    const service = this.deps.modelProfileService();
    const order = await service.getFallbackOrder();
    const noSwap: SwapResult = { backend: requestedBackend, swapped: false };
    if (!order.length) return noSwap;

    const threshold = options.threshold ?? RATE_LIMIT_UTILIZATION_THRESHOLD;
    const utilization = await this.getUtilization(requestedBackend);
    // No data = optimistic: assume there is quota left.
    if (utilization === null || utilization < threshold) return noSwap;

    const profiles = await service.listProfiles();
    const active = await service.getActiveProfile();

    const candidate = order
      .map((id) => profiles.find((profile) => profile.id === id))
      .find((profile): profile is ModelProfile => {
        if (!profile || profile.id === active?.id) return false;
        const triple = agentTripleOfProfile(profile);
        return triple != null && triple.backend !== requestedBackend;
      });

    if (!candidate) return { ...noSwap, skippedDueToRateLimit: true };

    const triple = agentTripleOfProfile(candidate);
    const targetBackend = triple?.backend ?? requestedBackend;

    // §8: never fall back onto something an `enforce` project forbids.
    //
    // This used to check `allowedBackends` only. The policy editor treats
    // profiles and backends as separate constraints, and the natural way to
    // say "this repo runs on Anthropic" is to pin a profile and leave
    // Backends on "All enabled" — which stores no `allowedBackends` at all.
    // The guard was therefore inert for exactly the policies people write:
    // the swap proceeded and flipped the active profile to a forbidden one.
    if (options.projectId) {
      const { policy } = await service.getEffectivePolicy({
        projectId: options.projectId,
      });
      if (policy.mode === 'enforce') {
        // Empty means unrestricted, consistent with the resolver and pickers.
        const allowedBackends =
          policy.allowedBackends && policy.allowedBackends.length > 0
            ? policy.allowedBackends
            : null;
        const allowedProfileIds =
          policy.allowedProfileIds && policy.allowedProfileIds.length > 0
            ? policy.allowedProfileIds
            : null;

        if (allowedBackends && !allowedBackends.includes(targetBackend)) {
          return {
            backend: requestedBackend,
            swapped: false,
            skippedDueToRateLimit: true,
            blocked: {
              reason: 'backend-not-allowed',
              message: `${requestedBackend} is rate limited, but this project only permits ${allowedBackends.join(', ')}.`,
              allowedBackends: [...allowedBackends],
            },
          };
        }

        // A pin admits exactly one profile, so any fallback away from it is a
        // violation. The project is then unusable until the quota resets —
        // which is what design §8 chose: refuse rather than run something the
        // project forbids.
        if (policy.pinnedProfileId && candidate.id !== policy.pinnedProfileId) {
          return {
            backend: requestedBackend,
            swapped: false,
            skippedDueToRateLimit: true,
            blocked: {
              reason: 'profile-not-allowed',
              message: `${requestedBackend} is rate limited, but this project always runs the "${profileName(profiles, policy.pinnedProfileId)}" profile.`,
              allowedProfileIds: [policy.pinnedProfileId],
            },
          };
        }

        if (allowedProfileIds && !allowedProfileIds.includes(candidate.id)) {
          return {
            backend: requestedBackend,
            swapped: false,
            skippedDueToRateLimit: true,
            blocked: {
              reason: 'profile-not-allowed',
              message: `${requestedBackend} is rate limited, but this project only permits the profiles: ${allowedProfileIds
                .map((id) => profileName(profiles, id))
                .join(', ')}.`,
              allowedProfileIds: [...allowedProfileIds],
            },
          };
        }
      }
    }

    if (options.activate) {
      // Activate the profile THIS call already chose. `activateFallbackProfile`
      // re-derived its own pick with a weaker predicate (it accepted a profile
      // whose agent role resolves to nothing), so the caller and the banner
      // could be told one profile while a different one was activated — and
      // the §8 enforce check validated the profile that was not used.
      await service.activateProfile({ profileId: candidate.id });
    }

    const model =
      triple && triple.model !== 'default' ? triple.model : undefined;
    const thinkingEffort =
      triple?.thinkingEffort && triple.thinkingEffort !== 'default'
        ? triple.thinkingEffort
        : undefined;

    if (
      options.notify !== false &&
      !this.notifiedBackends.has(requestedBackend)
    ) {
      this.notifiedBackends.add(requestedBackend);
      this.emitSwapNotification(requestedBackend, targetBackend, model);
    }

    return {
      backend: targetBackend,
      model,
      thinkingEffort,
      swapped: true,
      skippedDueToRateLimit: true,
      profileId: candidate.id,
    };
  }

  private emitSwapNotification(
    from: AgentBackendType,
    to: AgentBackendType,
    model?: string,
  ): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('rate-limit-swap:triggered', { from, to, model });
    }
  }

  private async getUtilization(
    backend: AgentBackendType,
  ): Promise<number | null> {
    const providerType = BACKEND_TO_USAGE_PROVIDER[backend];
    if (!providerType) return null;

    if (process.env.JC_DISABLE_NATIVE_USAGE_TRACKING) {
      const usageSettings = await SettingsRepository.get('usageDisplay');
      if (!usageSettings.useCodexBar) return null;
    }

    const usage = await agentUsageService.getUsage([providerType]);
    const result = usage[providerType];

    if (!result?.data?.limits?.length) return null;

    const primary =
      result.data.limits.find((l) => l.isPrimary) ?? result.data.limits[0];
    return primary.range.utilization / 100;
  }

  reset(): void {
    this.notifiedBackends.clear();
  }
}

export const rateLimitSwapService = new RateLimitSwapService();
