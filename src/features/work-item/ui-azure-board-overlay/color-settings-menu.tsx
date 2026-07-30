/* eslint-disable sort-imports */
import { Plus, Settings2, Trash2, X } from 'lucide-react';
import { type RefObject, useEffect, useId, useRef } from 'react';
import clsx from 'clsx';

import {
  BOARD_COLOR_PALETTE,
  BOARD_COLOR_TONES,
  BOARD_COLUMN_APPLY_LABELS,
  BOARD_TAG_MATCH_LABELS,
  type BoardColorKey,
  type BoardColorSettings,
  type BoardColumnApplyMode,
  type BoardTagMatchType,
  type BoardTagRule,
  getBoardColumnApplyMode,
  getBoardColumnColorKey,
  normalizeBoardColumnKey,
} from '@/features/work-item/utils-board-colors';

function Swatches({
  value,
  onChange,
  label,
}: {
  value: BoardColorKey;
  onChange: (color: BoardColorKey) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label={label}>
      {BOARD_COLOR_PALETTE.map((entry) => {
        const isSelected = entry.key === value;
        return (
          <button
            key={entry.key}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={entry.label}
            title={entry.label}
            onClick={() => onChange(entry.key)}
            className={clsx(
              'h-4 w-4 shrink-0 rounded-full border transition-shadow',
              isSelected ? 'border-ink-0 border-2' : 'border-line',
            )}
            style={{
              background:
                entry.key === 'grey'
                  ? 'var(--color-bg-3)'
                  : `color-mix(in oklch, ${entry.tone} 70%, transparent)`,
              boxShadow: isSelected
                ? `0 0 0 2px color-mix(in oklch, ${entry.tone} 45%, transparent)`
                : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  labels,
  onChange,
  label,
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="bg-bg-2 flex gap-0.5 rounded-md p-0.5" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={clsx(
            'flex-1 rounded px-2 py-1 text-[11.5px] whitespace-nowrap transition-colors',
            value === option ? 'bg-bg-4 text-ink-0' : 'text-ink-3 hover:text-ink-1',
          )}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

const MATCH_TYPES: BoardTagMatchType[] = ['exact', 'prefix', 'contains'];
const APPLY_MODES: BoardColumnApplyMode[] = ['rule', 'tint', 'both', 'none'];

export function BoardColorSettingsMenu({
  settings,
  onChange,
  onReset,
  onClose,
  tagOptions,
  columnNames,
  activeTab,
  onActiveTabChange,
  triggerRef,
}: {
  settings: BoardColorSettings;
  onChange: (settings: BoardColorSettings) => void;
  onReset: () => void;
  onClose: () => void;
  tagOptions: string[];
  columnNames: string[];
  activeTab: 'tags' | 'columns';
  onActiveTabChange: (tab: 'tags' | 'columns') => void;
  /** The toggle button; clicks inside it must not double-close the menu. */
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const tagListId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose, triggerRef]);

  const setRule = (id: string, patch: Partial<BoardTagRule>) =>
    onChange({
      ...settings,
      rules: settings.rules.map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule,
      ),
    });

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Board colours"
      className="bg-bg-1 border-line absolute top-12 right-3 z-30 flex max-h-[min(560px,calc(100%-4rem))] w-[372px] flex-col overflow-hidden rounded-xl border shadow-2xl"
    >
      <div className="border-line-soft flex items-center gap-2 border-b px-3.5 py-2.5">
        <Settings2 className="text-ink-3 h-3.5 w-3.5" />
        <span className="text-ink-0 text-[12.5px] font-semibold">Board colours</span>
        <button
          type="button"
          onClick={onReset}
          className="text-ink-3 hover:text-ink-1 ml-auto px-1 text-[11.5px]"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close board colours"
          className="text-ink-3 hover:text-ink-1 p-0.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-3.5 pt-2.5">
        <Segmented
          label="Board colour section"
          value={activeTab}
          options={['tags', 'columns'] as const}
          labels={{ tags: 'Tag matching', columns: 'Columns' }}
          onChange={onActiveTabChange}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 pt-3 pb-3.5">
        {activeTab === 'tags' ? (
          <>
            <p className="text-ink-3 text-[11.5px] leading-relaxed">
              Rules run top to bottom; the first match colours the tag. Everything
              unmatched collapses into <span className="font-mono">+n</span>.
            </p>
            <datalist id={tagListId}>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            {settings.rules.map((rule) => (
              <div
                key={rule.id}
                className="bg-bg-0 border-line-soft flex flex-col gap-2 rounded-lg border px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-ink-4 font-mono text-[9.5px] tracking-wider uppercase">
                    Tag
                  </span>
                  <select
                    aria-label="Match type"
                    value={rule.type}
                    onChange={(event) =>
                      setRule(rule.id, {
                        type: event.target.value as BoardTagMatchType,
                      })
                    }
                    className="bg-bg-2 border-line text-ink-1 rounded border px-1 py-0.5 text-[11.5px]"
                  >
                    {MATCH_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {BOARD_TAG_MATCH_LABELS[type]}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Tag to match"
                    list={tagListId}
                    value={rule.match}
                    spellCheck={false}
                    placeholder="any tag…"
                    onChange={(event) => setRule(rule.id, { match: event.target.value })}
                    className="bg-bg-2 border-line text-ink-0 focus:border-acc-line min-w-0 flex-1 rounded border px-1.5 py-1 font-mono text-[11.5px] outline-none"
                  />
                  <button
                    type="button"
                    aria-label={`Remove rule for ${rule.match || 'tag'}`}
                    title="Remove rule"
                    onClick={() =>
                      onChange({
                        ...settings,
                        rules: settings.rules.filter((entry) => entry.id !== rule.id),
                      })
                    }
                    className="text-ink-4 hover:text-status-fail p-0.5"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Swatches
                    label={`Colour for ${rule.match || 'tag'}`}
                    value={rule.color}
                    onChange={(color) => setRule(rule.id, { color })}
                  />
                  <span
                    className="ml-auto inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10.5px] whitespace-nowrap"
                    style={
                      rule.color === 'grey'
                        ? { color: 'var(--color-ink-3)' }
                        : {
                            color: BOARD_COLOR_TONES[rule.color],
                            background: `color-mix(in oklch, ${BOARD_COLOR_TONES[rule.color]} 12%, transparent)`,
                          }
                    }
                  >
                    {rule.color !== 'grey' && (
                      <span className="h-1 w-1 rounded-full bg-current" />
                    )}
                    {rule.label || rule.match || 'tag'}
                  </span>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...settings,
                  rules: [
                    ...settings.rules,
                    {
                      id: `rule-${crypto.randomUUID()}`,
                      type: 'contains',
                      match: '',
                      color: 'violet',
                    },
                  ],
                })
              }
              className="border-line text-ink-2 hover:text-ink-0 flex items-center justify-center gap-1.5 rounded-lg border border-dashed py-1.5 text-[11.5px]"
            >
              <Plus className="h-3 w-3" /> Add rule
            </button>
          </>
        ) : (
          <>
            <p className="text-ink-3 text-[11.5px] leading-relaxed">
              One colour per column, and how far it carries into the lane.
            </p>
            {columnNames.length === 0 && (
              <p className="text-ink-3 text-[11.5px] italic">No board columns.</p>
            )}
            {columnNames.map((columnName) => {
              const key = normalizeBoardColumnKey(columnName);
              const override = settings.columnApply[key];
              const colorKey = getBoardColumnColorKey(columnName, settings);
              return (
                <div
                  key={key}
                  className="bg-bg-0 border-line-soft flex flex-col gap-2 rounded-lg border px-2.5 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-3 w-[3px] shrink-0 rounded-full"
                      style={{ background: BOARD_COLOR_TONES[colorKey] }}
                    />
                    <span className="text-ink-1 min-w-0 flex-1 truncate text-xs">
                      {columnName}
                    </span>
                    <select
                      aria-label={`Apply mode for ${columnName}`}
                      value={override ?? ''}
                      onChange={(event) => {
                        const nextColumnApply = { ...settings.columnApply };
                        if (event.target.value) {
                          nextColumnApply[key] = event.target
                            .value as BoardColumnApplyMode;
                        } else {
                          delete nextColumnApply[key];
                        }
                        onChange({ ...settings, columnApply: nextColumnApply });
                      }}
                      className={clsx(
                        'border-line rounded border px-1 py-0.5 text-[11px]',
                        override ? 'bg-bg-3 text-ink-0' : 'bg-bg-2 text-ink-3',
                      )}
                    >
                      <option value="">
                        Default · {BOARD_COLUMN_APPLY_LABELS[settings.apply]}
                      </option>
                      {APPLY_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {BOARD_COLUMN_APPLY_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Swatches
                    label={`Colour for ${columnName}`}
                    value={colorKey}
                    onChange={(color) =>
                      onChange({
                        ...settings,
                        columnColors: { ...settings.columnColors, [key]: color },
                      })
                    }
                  />
                  <span className="text-ink-4 text-[10px]">
                    Applied: {BOARD_COLUMN_APPLY_LABELS[
                      getBoardColumnApplyMode(columnName, settings)
                    ]}
                  </span>
                </div>
              );
            })}
            <div className="border-line-soft flex flex-col gap-1.5 border-t pt-2.5">
              <span className="text-ink-4 font-mono text-[10px] tracking-wider uppercase">
                Default for all columns
              </span>
              <Segmented
                label="Default apply mode"
                value={settings.apply}
                options={APPLY_MODES}
                labels={BOARD_COLUMN_APPLY_LABELS}
                onChange={(apply) => onChange({ ...settings, apply })}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
