import { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import clsx from 'clsx';

import type { AutoReviewRule } from '@shared/types';
import { useSetting, useUpdateSetting } from '@/hooks/use-settings';
import { PROJECT_COLORS } from '@/lib/colors';

/**
 * Preset palette, expanded inline underneath its rule rather than floating over
 * it. A popover would be the obvious choice, but the settings pane restyles
 * every descendant `.bg-bg-0` to `bg-black/20` and scrolls with
 * `overflow-y-auto`, so a floating panel renders see-through and gets clipped
 * near the bottom of the list. Expanding in flow sidesteps both.
 */
function RuleColorPalette({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (color: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`Color for ${label}`}
      className="flex flex-wrap gap-1.5 px-3 pb-3 pl-11"
    >
      {PROJECT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === color.toLowerCase()}
          aria-label={color}
          onClick={() => onChange(color)}
          className={clsx(
            'h-5 w-5 shrink-0 cursor-pointer rounded border border-white/10 transition-transform',
            value.toLowerCase() === color.toLowerCase()
              ? 'ring-offset-bg-0 scale-110 ring-2 ring-white ring-offset-1'
              : 'hover:scale-110 hover:border-white/30',
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

const SUGGESTIONS = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/__snapshots__/**',
  '**/*.snap',
  'pnpm-lock.yaml',
  '**/*.generated.ts',
];

export function AutoReviewSettings() {
  const { data: setting } = useSetting('autoReview');
  const updateSetting = useUpdateSetting<'autoReview'>();
  const serverRules = setting?.rules;

  /**
   * The rule list is edited locally and pushed to settings, rather than being
   * driven straight off the query cache. Binding the text inputs to the cache
   * would snap them back to the pre-write value on every keystroke (the write
   * is async), eating characters and jumping the caret. `rulesRef` keeps the
   * committed value readable from callbacks without stale-closure risk, so two
   * quick edits can't be computed from the same pre-write snapshot.
   */
  const [rules, setRules] = useState<AutoReviewRule[]>(serverRules ?? []);
  const rulesRef = useRef<AutoReviewRule[]>(rules);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [colorEditingId, setColorEditingId] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  // Adopt settings loaded (or changed in another window) unless the user has
  // uncommitted typing in flight, which we must not clobber mid-edit.
  useEffect(() => {
    if (!serverRules || dirtyRef.current) return;
    rulesRef.current = serverRules;
    setRules(serverRules);
  }, [serverRules]);

  /** Update local state only — used while typing. */
  const stage = useCallback((next: AutoReviewRule[]) => {
    dirtyRef.current = true;
    rulesRef.current = next;
    setRules(next);
  }, []);

  /** Update local state and persist. */
  const save = useCallback(
    (next: AutoReviewRule[]) => {
      dirtyRef.current = false;
      rulesRef.current = next;
      setRules(next);
      updateSetting.mutate({ key: 'autoReview', value: { rules: next } });
    },
    [updateSetting],
  );

  const stagePatch = useCallback(
    (id: string, changes: Partial<AutoReviewRule>) =>
      stage(
        rulesRef.current.map((rule) =>
          rule.id === id ? { ...rule, ...changes } : rule,
        ),
      ),
    [stage],
  );

  const savePatch = useCallback(
    (id: string, changes: Partial<AutoReviewRule>) =>
      save(
        rulesRef.current.map((rule) =>
          rule.id === id ? { ...rule, ...changes } : rule,
        ),
      ),
    [save],
  );

  const commit = useCallback(() => {
    if (!dirtyRef.current) return;
    save(rulesRef.current);
  }, [save]);

  const addRule = useCallback(
    (pattern = '') => {
      const current = rulesRef.current;
      save([
        ...current,
        {
          // Random ids, so two fast clicks can never mint the same one.
          id: nanoid(),
          pattern,
          color: PROJECT_COLORS[current.length % PROJECT_COLORS.length],
          enabled: true,
        },
      ]);
    },
    [save],
  );

  const move = useCallback(
    (from: number, to: number) => {
      const current = rulesRef.current;
      if (from === to || to < 0 || to >= current.length) return;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      save(next);
    },
    [save],
  );

  const unusedSuggestions = SUGGESTIONS.filter(
    (pattern) => !rules.some((rule) => rule.pattern === pattern),
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-ink-1 text-lg font-semibold">Auto file review</h2>
        <p className="text-ink-3 mt-1 text-sm">
          Files matching these patterns count as reviewed automatically, so they
          stay out of your way in task and pull request diffs. Each rule gets a
          color so you can still spot them in the file tree. Un-check a file by
          hand and that choice sticks, even while the rule matches it — as long
          as reviewed files are set to dim rather than hide.
        </p>
      </div>

      <div className="border-line-soft bg-bg-0 divide-line-soft divide-y rounded-lg border">
        {rules.length === 0 && (
          <p className="text-ink-3 px-4 py-6 text-center text-sm">
            No patterns yet. Add one below to start skipping files.
          </p>
        )}

        {rules.map((rule, index) => {
          return (
            <div key={rule.id}>
            <div
              // Only the grip starts a drag; making the whole row draggable
              // would hijack text selection inside the inputs below.
              draggable={dragIndex === index}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null) move(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              className={clsx(
                'flex items-center gap-2 px-3 py-2',
                dragIndex === index && 'opacity-50',
              )}
            >
              <span
                onPointerDown={() => setDragIndex(index)}
                className="cursor-grab"
              >
                <GripVertical
                  className="text-ink-4 h-4 w-4 shrink-0"
                  aria-hidden
                />
              </span>

              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(event) =>
                  savePatch(rule.id, { enabled: event.target.checked })
                }
                aria-label={`Enable ${rule.pattern || 'rule'}`}
                className="shrink-0"
              />

              <button
                type="button"
                onClick={() =>
                  setColorEditingId((current) =>
                    current === rule.id ? null : rule.id,
                  )
                }
                aria-label={`Color for ${rule.pattern || 'rule'}`}
                aria-expanded={colorEditingId === rule.id}
                className="border-line-soft h-6 w-6 shrink-0 cursor-pointer rounded border"
                style={{ backgroundColor: rule.color }}
              />

              <input
                value={rule.pattern}
                onChange={(event) =>
                  stagePatch(rule.id, { pattern: event.target.value })
                }
                onBlur={commit}
                placeholder="**/*.test.ts"
                spellCheck={false}
                aria-label="Glob pattern"
                className="bg-bg-1 text-ink-1 border-line-soft min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[13px]"
              />

              <input
                value={rule.label ?? ''}
                onChange={(event) =>
                  stagePatch(rule.id, { label: event.target.value })
                }
                onBlur={commit}
                placeholder="Label (optional)"
                aria-label="Rule label"
                className="border-line-soft bg-bg-1 text-ink-2 w-36 shrink-0 rounded border px-2 py-1 text-[13px]"
              />

              <button
                onClick={() =>
                  save(rulesRef.current.filter((r) => r.id !== rule.id))
                }
                aria-label={`Remove ${rule.pattern || 'rule'}`}
                className="text-ink-4 hover:text-status-error shrink-0 p-1"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            {colorEditingId === rule.id && (
              <RuleColorPalette
                value={rule.color}
                label={rule.pattern || 'rule'}
                onChange={(color) => {
                  savePatch(rule.id, { color });
                  setColorEditingId(null);
                }}
              />
            )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => addRule()}
          className="border-line-soft bg-bg-0 text-ink-1 hover:bg-glass-medium inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm"
        >
          <Plus className="h-3.5 w-3.5" />
          Add pattern
        </button>
        {unusedSuggestions.map((pattern) => (
          <button
            key={pattern}
            onClick={() => addRule(pattern)}
            className="border-line-soft text-ink-3 hover:text-ink-1 hover:bg-glass-medium rounded-md border border-dashed px-2 py-1 font-mono text-[11px]"
          >
            + {pattern}
          </button>
        ))}
      </div>

      <p className="text-ink-4 text-xs">
        Patterns are globs matched against the file&apos;s path in the diff, and
        dotfiles are included. When two rules match the same file, the one
        higher in the list wins — drag to reorder.
      </p>
    </div>
  );
}
