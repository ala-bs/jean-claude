// Renderer reaction to a real rate-limit event (design §4 / §5 / §8).
//
// Three rules shape this hook:
//
// - Only a *real* limit event (`api.onRateLimitSwap`) activates the fallback.
//   The status probe (`api.rateLimitSwap.resolve`) stays side-effect free, so
//   activation goes through the dedicated `api.rateLimitSwap.react` channel,
//   which is the only caller passing `activate: true`.
// - §4: running steps keep their model. Activating a profile only changes what
//   *new* steps resolve to — nothing here restarts or interrupts a live run.
// - §8: a project in `enforce` mode whose permitted backend is limited comes
//   back `blocked`. We surface that error and leave the active profile alone.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { AgentBackendType } from '@shared/agent-backend-types';

import {
  useActivateModelProfile,
  useActiveModelProfileId,
  useModelProfilesSetting,
} from '@/hooks/use-model-profiles';
import { api } from '@/lib/api';

const BACKEND_LABELS: Record<AgentBackendType, string> = {
  'claude-code': 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  vibe: 'Mistral Vibe',
};

function backendLabel(backend: string): string {
  return BACKEND_LABELS[backend as AgentBackendType] ?? backend;
}

/** How often we re-probe the limited backend to detect a quota reset. */
const QUOTA_POLL_INTERVAL_MS = 60_000;

export const RATE_LIMIT_QUOTA_QUERY_KEY = [
  'rate-limit-fallback',
  'quota',
] as const;

export type RateLimitFallbackState =
  | { kind: 'idle' }
  | {
      kind: 'swapped';
      fromBackend: AgentBackendType;
      toBackend: AgentBackendType;
      profileId?: string;
      /** Profile to restore on revert, when there was an active one. */
      previousProfileId: string | null;
    }
  | {
      kind: 'blocked';
      fromBackend: AgentBackendType;
      message: string;
      allowedBackends?: AgentBackendType[];
    };

const IDLE: RateLimitFallbackState = { kind: 'idle' };

export function useRateLimitFallback({
  projectId,
}: { projectId?: string | null } = {}) {
  const [state, setState] = useState<RateLimitFallbackState>(IDLE);

  const { profiles } = useModelProfilesSetting();
  const { activeProfileId } = useActiveModelProfileId();
  const activateProfile = useActivateModelProfile();

  // Refs keep the event handler stable: re-subscribing on every render would
  // make "exactly once per limit event" depend on render timing.
  const stateRef = useRef(state);
  const projectIdRef = useRef(projectId ?? null);
  const activeProfileIdRef = useRef(activeProfileId);
  const activateRef = useRef(activateProfile.mutateAsync);
  /** Backends already reacted to, so repeated events do not re-activate. */
  const handledBackends = useRef(new Set<string>());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    projectIdRef.current = projectId ?? null;
  }, [projectId]);
  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);
  useEffect(() => {
    activateRef.current = activateProfile.mutateAsync;
  }, [activateProfile.mutateAsync]);

  const revert = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind === 'idle') return;
    // Allow a later limit event on the same backend to react again.
    handledBackends.current.delete(current.fromBackend);
    stateRef.current = IDLE;
    setState(IDLE);
    if (current.kind !== 'swapped' || !current.previousProfileId) return;
    try {
      await activateRef.current(current.previousProfileId);
    } catch {
      // The mutation rolls back its own optimistic state; the banner is gone
      // either way and the next limit event can react again.
    }
  }, []);

  const dismiss = useCallback(() => {
    const current = stateRef.current;
    if (current.kind === 'idle') return;
    handledBackends.current.delete(current.fromBackend);
    stateRef.current = IDLE;
    setState(IDLE);
  }, []);

  useEffect(() => {
    return api.onRateLimitSwap((event) => {
      const backend = event.from as AgentBackendType;
      if (handledBackends.current.has(backend)) return;
      handledBackends.current.add(backend);
      const previousProfileId = activeProfileIdRef.current;
      void api.rateLimitSwap
        .react({ backend, projectId: projectIdRef.current })
        .then((result) => {
          if (result.blocked) {
            const next: RateLimitFallbackState = {
              kind: 'blocked',
              fromBackend: backend,
              message: result.blocked.message,
              allowedBackends: result.blocked.allowedBackends,
            };
            stateRef.current = next;
            setState(next);
            return;
          }
          if (!result.swapped) {
            handledBackends.current.delete(backend);
            return;
          }
          const next: RateLimitFallbackState = {
            kind: 'swapped',
            fromBackend: backend,
            toBackend: result.backend,
            profileId: result.profileId,
            previousProfileId,
          };
          stateRef.current = next;
          setState(next);
        })
        .catch(() => {
          handledBackends.current.delete(backend);
        });
    });
  }, []);

  // Quota-reset detection: poll the side-effect-free probe for the limited
  // backend only while a fallback is actually in effect.
  const limitedBackend = state.kind === 'swapped' ? state.fromBackend : null;
  const quotaQuery = useQuery({
    queryKey: [...RATE_LIMIT_QUOTA_QUERY_KEY, limitedBackend],
    queryFn: () => api.rateLimitSwap.resolve(limitedBackend as AgentBackendType),
    enabled: limitedBackend !== null,
    refetchInterval: QUOTA_POLL_INTERVAL_MS,
  });

  // `swapped: false` has TWO meanings: the quota recovered, or the backend is
  // still over its limit and no fallback profile is left to switch to. After a
  // swap the second is the normal case — the now-active profile is skipped as
  // a candidate — so treating it as recovery reverted onto the still-limited
  // backend within a tick, and the next limit event swapped again.
  // `skippedDueToRateLimit` is exactly the flag that separates them.
  const quotaReset =
    limitedBackend !== null &&
    quotaQuery.data != null &&
    !quotaQuery.data.swapped &&
    !quotaQuery.data.skippedDueToRateLimit;

  useEffect(() => {
    if (!quotaReset) return;
    void revert();
  }, [quotaReset, revert]);

  const sourceLabel =
    state.kind === 'idle' ? null : backendLabel(state.fromBackend);

  const targetLabel = useMemo(() => {
    if (state.kind !== 'swapped') return null;
    const profile = state.profileId
      ? profiles.find((entry) => entry.id === state.profileId)
      : undefined;
    return profile?.name ?? backendLabel(state.toBackend);
  }, [state, profiles]);

  return { state, sourceLabel, targetLabel, revert, dismiss };
}
