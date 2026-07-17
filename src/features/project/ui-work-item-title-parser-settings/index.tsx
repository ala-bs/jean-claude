import {
  ArrowDown,
  ArrowUp,
  Braces,
  Plus,
  Tags,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
  WORK_ITEM_TITLE_PARSER_MAX_RULES,
  type WorkItemTitleParserRule,
  type WorkItemTitleParserSetting,
} from '@shared/work-item-title-parser-types';
import { Button } from '@/common/ui/button';
import { Checkbox } from '@/common/ui/checkbox';
import { Input } from '@/common/ui/input';
import { parseWorkItemTitle } from '@/lib/work-item-title-parser';
import { Switch } from '@/common/ui/switch';
import { validateWorkItemTitleParserDraft } from './utils-work-item-title-parser-settings';

const SAMPLE_TITLE = '[Backend] [Checkout] Improve payment retry handling';

function cloneSetting(
  setting: WorkItemTitleParserSetting,
): WorkItemTitleParserSetting {
  return {
    ...setting,
    rules: setting.rules.map((rule) => ({ ...rule })),
  };
}

function createRule(existingRules: WorkItemTitleParserRule[]) {
  let id = `rule-${crypto.randomUUID()}`;
  while (existingRules.some((rule) => rule.id === id)) {
    id = `rule-${crypto.randomUUID()}`;
  }
  return {
    id,
    enabled: false,
    pattern: '',
    caseInsensitive: false,
  } satisfies WorkItemTitleParserRule;
}

export function WorkItemTitleParserSettings({
  setting,
  onChange,
}: {
  setting: WorkItemTitleParserSetting | null;
  onChange: (setting: WorkItemTitleParserSetting) => void;
}) {
  const [draft, setDraft] = useState(() =>
    cloneSetting(setting ?? STARTER_WORK_ITEM_TITLE_PARSER_SETTING),
  );
  const [sampleTitle, setSampleTitle] = useState(SAMPLE_TITLE);
  const lastExternalSettingRef = useRef(JSON.stringify(setting));

  useEffect(() => {
    const externalSetting = JSON.stringify(setting);
    if (externalSetting === lastExternalSettingRef.current) return;
    lastExternalSettingRef.current = externalSetting;
    setDraft(cloneSetting(setting ?? STARTER_WORK_ITEM_TITLE_PARSER_SETTING));
  }, [setting]);

  const validation = useMemo(
    () => validateWorkItemTitleParserDraft(draft),
    [draft],
  );
  const preview = useMemo(
    () =>
      validation.isValid
        ? parseWorkItemTitle({ title: sampleTitle, setting: draft })
        : null,
    [draft, sampleTitle, validation.isValid],
  );
  const hasEnabledRule = draft.rules.some((rule) => rule.enabled);
  const previewDisabled = !draft.enabled || !hasEnabledRule;

  function updateDraft(next: WorkItemTitleParserSetting) {
    setDraft(next);
    if (validateWorkItemTitleParserDraft(next).isValid) {
      onChange(cloneSetting(next));
    }
  }

  function updateRule(
    ruleId: string,
    update: Partial<WorkItemTitleParserRule>,
  ) {
    updateDraft({
      ...draft,
      rules: draft.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, ...update } : rule,
      ),
    });
  }

  function moveRule(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= draft.rules.length) return;
    const rules = [...draft.rules];
    [rules[index], rules[targetIndex]] = [rules[targetIndex], rules[index]];
    updateDraft({ ...draft, rules });
  }

  return (
    <section className="border-line-soft mt-4 border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Braces className="text-acc-ink h-4 w-4" aria-hidden />
            <h3 className="text-ink-1 text-sm font-semibold">
              Work item title parser
            </h3>
          </div>
          <p className="text-ink-3 mt-1 max-w-xl text-xs leading-relaxed">
            Remove matched text from Azure titles and show named captures as
            labels. Each regex needs a <code>(?&lt;label&gt;...)</code> group.
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          onChange={(enabled) => updateDraft({ ...draft, enabled })}
          label="Enable title parser"
        />
      </div>

      <div className="mt-4 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-ink-1 text-xs font-semibold tracking-wide uppercase">
              Ordered rules
            </p>
            <p className="text-ink-3 mt-0.5 text-[11px]">
              Rules run top to bottom. Up to {WORK_ITEM_TITLE_PARSER_MAX_RULES}.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<Plus />}
            disabled={draft.rules.length >= WORK_ITEM_TITLE_PARSER_MAX_RULES}
            onClick={() =>
              updateDraft({
                ...draft,
                rules: [...draft.rules, createRule(draft.rules)],
              })
            }
          >
            Add rule
          </Button>
        </div>

        {draft.rules.length === 0 ? (
          <div className="border-glass-border bg-bg-1/40 text-ink-3 rounded-lg border border-dashed px-3 py-5 text-center text-xs">
            No rules. Add one to extract title labels.
          </div>
        ) : (
          draft.rules.map((rule, index) => {
            const error = validation.ruleErrors.get(index);
            const patternId = `work-item-title-rule-${rule.id}`;
            const errorId = `${patternId}-error`;
            return (
              <div
                key={rule.id}
                className="border-glass-border bg-bg-1/55 rounded-lg border p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="bg-bg-3 text-ink-3 flex h-5 min-w-5 items-center justify-center rounded font-mono text-[10px] font-semibold">
                    {index + 1}
                  </span>
                  <Switch
                    checked={rule.enabled}
                    onChange={(enabled) => updateRule(rule.id, { enabled })}
                    label={`Enable rule ${index + 1}`}
                    className="mr-auto"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon={<ArrowUp />}
                    aria-label={`Move rule ${index + 1} up`}
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => moveRule(index, -1)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon={<ArrowDown />}
                    aria-label={`Move rule ${index + 1} down`}
                    title="Move down"
                    disabled={index === draft.rules.length - 1}
                    onClick={() => moveRule(index, 1)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon={<Trash2 />}
                    aria-label={`Remove rule ${index + 1}`}
                    title="Remove rule"
                    onClick={() =>
                      updateDraft({
                        ...draft,
                        rules: draft.rules.filter(
                          (candidate) => candidate.id !== rule.id,
                        ),
                      })
                    }
                  />
                </div>

                <div className="mt-3">
                  <label
                    htmlFor={patternId}
                    className="text-ink-2 mb-1 block text-xs font-medium"
                  >
                    Regular expression
                  </label>
                  <Input
                    id={patternId}
                    size="sm"
                    value={rule.pattern}
                    onChange={(event) =>
                      updateRule(rule.id, { pattern: event.target.value })
                    }
                    placeholder={String.raw`\[(?<label>[^\]]+)\]\s*`}
                    spellCheck={false}
                    error={!!error}
                    aria-invalid={!!error}
                    aria-describedby={error ? errorId : undefined}
                    className="font-mono"
                  />
                  {error && (
                    <p
                      id={errorId}
                      role="alert"
                      className="text-status-fail mt-1.5 text-xs"
                    >
                      {error}
                    </p>
                  )}
                </div>

                <Checkbox
                  size="sm"
                  checked={rule.caseInsensitive}
                  onChange={(caseInsensitive) =>
                    updateRule(rule.id, { caseInsensitive })
                  }
                  label="Ignore case"
                  className="mt-2.5"
                />
              </div>
            );
          })
        )}

        {validation.settingError && (
          <p role="alert" className="text-status-fail text-xs">
            {validation.settingError}
          </p>
        )}
      </div>

      <div className="border-glass-border bg-bg-0/70 mt-4 rounded-lg border p-3">
        <div className="mb-2 flex items-center gap-2">
          <Tags className="text-ink-3 h-3.5 w-3.5" aria-hidden />
          <p className="text-ink-1 text-xs font-semibold tracking-wide uppercase">
            Live sample
          </p>
        </div>
        <label
          htmlFor="work-item-title-parser-sample"
          className="text-ink-2 mb-1 block text-xs font-medium"
        >
          Raw Azure title
        </label>
        <Input
          id="work-item-title-parser-sample"
          size="sm"
          value={sampleTitle}
          onChange={(event) => setSampleTitle(event.target.value)}
        />

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="border-line-soft mt-3 border-t pt-3"
        >
          {!validation.isValid ? (
            <p className="text-status-fail text-xs">
              Fix rule errors to update preview and save changes.
            </p>
          ) : previewDisabled ? (
            <p className="text-ink-3 text-xs">
              Enable parser and at least one rule to see a cleaned title and
              labels.
            </p>
          ) : (
            <>
              <p className="text-ink-3 text-[10px] font-semibold tracking-wide uppercase">
                Clean title
              </p>
              <p className="text-ink-1 mt-1 text-sm font-medium">
                {preview?.displayTitle}
              </p>
              <div className="mt-2 flex min-h-5 flex-wrap gap-1.5">
                {preview?.labels.length ? (
                  preview.labels.map((label) => (
                    <span
                      key={label.toLowerCase()}
                      className="border-acc/25 bg-acc/10 text-acc-ink rounded border px-1.5 py-0.5 text-[11px] font-medium"
                    >
                      {label}
                    </span>
                  ))
                ) : (
                  <span className="text-ink-3 text-xs">
                    No labels matched this sample.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
