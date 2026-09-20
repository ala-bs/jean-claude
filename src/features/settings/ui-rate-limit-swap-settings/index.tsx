import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useMemo } from 'react';

import {
  useActiveModelProfileId,
  useModelProfilesSetting,
} from '@/hooks/use-model-profiles';
import { useSetting, useUpdateSetting } from '@/hooks/use-settings';
import type { ModelProfile } from '@shared/model-profiles';

const EMPTY_ORDER: string[] = [];

/**
 * Rate-limit fallback. Since the model-profiles rework this is no longer a
 * per-entry model chain: it is an ordered list of *profiles*. When the backend
 * of the active profile's `agent` role hits its limit, the next profile in this
 * order is activated, which moves every role at once.
 *
 * See `docs/plans/2026-09-19-model-profiles-and-project-policy-design.md` §4.
 */
export function ModelFallbackOrderSettings() {
  const { profiles } = useModelProfilesSetting();
  const { activeProfileId } = useActiveModelProfileId();
  const { data: orderSetting } = useSetting('modelFallbackOrder');
  const updateSetting = useUpdateSetting<'modelFallbackOrder'>();

  const order = orderSetting ?? EMPTY_ORDER;

  const orderedProfiles = useMemo(
    () =>
      order
        .map((profileId) => profiles.find((entry) => entry.id === profileId))
        .filter((profile): profile is ModelProfile => profile != null),
    [order, profiles],
  );

  const availableProfiles = useMemo(
    () => profiles.filter((profile) => !order.includes(profile.id)),
    [order, profiles],
  );

  const commit = (next: string[]) => {
    updateSetting.mutate({ key: 'modelFallbackOrder', value: next });
  };

  const move = (profileId: string, delta: number) => {
    const index = order.indexOf(profileId);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= order.length) return;
    const next = [...order];
    next.splice(index, 1);
    next.splice(target, 0, profileId);
    commit(next);
  };

  return (
    <div>
      <h2 className="text-ink-1 text-lg font-semibold">Rate limit fallback</h2>
      <p className="text-ink-3 mt-1 max-w-[520px] text-sm">
        When the active profile&rsquo;s backend hits its rate limit, the next
        profile in this order is activated. Running steps keep their model; only
        new steps pick up the new profile.
      </p>

      <div className="border-glass-border bg-bg-1 mt-4 overflow-hidden rounded-xl border">
        {orderedProfiles.length === 0 ? (
          <div className="text-ink-3 px-4 py-8 text-center text-sm">
            No fallback profiles. Add one below to keep working when a backend
            runs out of quota.
          </div>
        ) : (
          orderedProfiles.map((profile, index) => (
            <div
              key={profile.id}
              className="border-line-soft flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
            >
              <span className="text-ink-4 w-5 shrink-0 text-center font-mono text-xs">
                {index + 1}
              </span>
              <span
                className={clsx(
                  'text-ink-1 min-w-0 flex-1 truncate text-[13px] font-medium',
                )}
              >
                {profile.name || 'Untitled'}
                {profile.id === activeProfileId && (
                  <span className="text-ink-4 ml-2 font-mono text-[10px] tracking-wide uppercase">
                    active
                  </span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Move ${profile.name} up`}
                disabled={index === 0}
                onClick={() => move(profile.id, -1)}
                className="text-ink-4 hover:text-ink-1 hover:bg-bg-3 grid h-7 w-7 place-items-center rounded-md disabled:opacity-30"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${profile.name} down`}
                disabled={index === orderedProfiles.length - 1}
                onClick={() => move(profile.id, 1)}
                className="text-ink-4 hover:text-ink-1 hover:bg-bg-3 grid h-7 w-7 place-items-center rounded-md disabled:opacity-30"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Remove ${profile.name} from fallback order`}
                onClick={() =>
                  commit(order.filter((entry) => entry !== profile.id))
                }
                className="text-ink-4 hover:bg-status-fail/15 hover:text-status-fail grid h-7 w-7 place-items-center rounded-md"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}

        <div className="border-line-soft flex items-center gap-2 border-t px-3 py-2">
          <select
            aria-label="Add profile to fallback order"
            value=""
            disabled={availableProfiles.length === 0}
            onChange={(event) => {
              if (!event.target.value) return;
              commit([...order, event.target.value]);
            }}
            className="border-line-soft bg-bg-0 text-ink-1 focus:border-acc h-8 min-w-[200px] rounded-md border px-2 text-xs outline-none disabled:opacity-40"
          >
            <option value="">
              {availableProfiles.length === 0
                ? 'All profiles added'
                : 'Add a profile…'}
            </option>
            {availableProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name || 'Untitled'}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
