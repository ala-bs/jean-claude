import type { AgentBackendType } from '@shared/agent-backend-types';
import type { ResolvedModel } from '@shared/model-profiles';
import type { ThinkingEffort } from '@shared/types';

import {
  getModelProfileService,
  type ModelProfileService,
} from './model-profile-service';

/**
 * Step patch written when a backend reports its session id.
 *
 * It used to reset `modelPreference` / `thinkingEffort` to `'default'` whenever
 * the run landed on a different backend than the step requested. That is the
 * behaviour the model-profiles design removes (§4): a profile already names the
 * right model for each backend, so a cross-backend swap must keep the resolved
 * model instead of blanking it. Only an explicit swap override is persisted.
 */
export function buildSessionIdStepUpdate({
  sessionId,
  backendType,
  swapModel,
  swapThinkingEffort,
}: {
  sessionId: string;
  backendType: AgentBackendType;
  /** Present only when the run was started on a different backend. */
  requestedBackendType?: AgentBackendType;
  swapModel?: string;
  swapThinkingEffort?: ThinkingEffort;
}): {
  sessionId: string;
  agentBackend: AgentBackendType;
  modelPreference?: string;
  thinkingEffort?: ThinkingEffort;
} {
  return {
    sessionId,
    agentBackend: backendType,
    ...(swapModel ? { modelPreference: swapModel } : {}),
    ...(swapThinkingEffort ? { thinkingEffort: swapThinkingEffort } : {}),
  };
}

/**
 * Error thrown when a project's model policy forbids the selection a session
 * was about to spawn with.
 *
 * Design §2: the runtime check in `agent-service.createSession` is the real
 * policy boundary — the picker filter is only ergonomics — so a blocked
 * resolution must fail loudly rather than silently spawn.
 */
export class ModelPolicyViolationError extends Error {
  readonly reason: NonNullable<ResolvedModel['blocked']>['reason'];
  readonly allowed: NonNullable<ResolvedModel['blocked']>['allowed'];

  constructor(blocked: NonNullable<ResolvedModel['blocked']>) {
    super(blocked.message);
    this.name = 'ModelPolicyViolationError';
    this.reason = blocked.reason;
    this.allowed = blocked.allowed;
  }
}

/** Throws when `resolved` was blocked by the project policy. */
export function assertModelPolicyAllowed(resolved: ResolvedModel): void {
  if (resolved.blocked) {
    throw new ModelPolicyViolationError(resolved.blocked);
  }
}

/**
 * Model and thinking effort a run should use.
 *
 * Lives here (rather than in `agent-service`) so it stays importable without
 * the Electron/native-SQLite chain, and so `runBackend` and
 * `tryContinueRunWithPrompt` share one implementation: if the comparison
 * recomputed this differently, a false mismatch would silently refuse every
 * prompt injection.
 *
 * The step's stored triple is an *override* on the `agent` role — it wins when
 * the project policy allows it, and the active profile supplies whatever the
 * step left unset. It deliberately no longer blanks model/effort when the run
 * lands on another backend (design §4): the profile already names the right
 * model for that backend.
 */
export async function resolveRunModelSettings({
  session,
  step,
  modelProfileService = getModelProfileService(),
}: {
  session: {
    projectId: string;
    backendType: AgentBackendType;
    swapModel?: string;
    swapThinkingEffort?: ThinkingEffort;
  };
  step: {
    modelPreference?: string | null;
    thinkingEffort?: ThinkingEffort | null;
  };
  modelProfileService?: ModelProfileService;
}): Promise<{
  modelPreference: string | undefined;
  thinkingEffort: ThinkingEffort | undefined;
}> {
  const resolved = await modelProfileService.resolveForRole({
    role: 'agent',
    projectId: session.projectId,
    override: {
      backend: session.backendType,
      model: session.swapModel ?? step.modelPreference ?? null,
      thinkingEffort: session.swapThinkingEffort ?? step.thinkingEffort ?? null,
    },
  });
  return {
    modelPreference: resolved.model ?? undefined,
    thinkingEffort: resolved.thinkingEffort ?? undefined,
  };
}
