import { Check, ChevronDown, Plus, RotateCcw, Star, Trash2 } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { nanoid } from 'nanoid';

import {
  AVAILABLE_BACKENDS,
  getModelLabel,
  getModelsForBackend,
  getModelThinkingCapabilities,
} from '@/features/agent/ui-backend-selector';
import {
  DetailPlaceholder,
  ListDetailLayout,
  ListItemButton,
  ListPane,
} from '@/common/ui/list-detail-layout';
import { Dropdown, DropdownDivider, DropdownItem } from '@/common/ui/dropdown';
import {
  getThinkingEffortOptions,
  normalizeThinkingEffortForModel,
} from '@shared/thinking-settings';
import {
  INHERIT_BINDING,
  isImageModelBinding,
  isModelTriple,
  isPresetRefBinding,
  type ModelProfile,
  type ModelRole,
  type ModelTriple,
  OFF_BINDING,
  type ProfilePreset,
  ROLE_DEFINITIONS,
  type RoleBinding,
  tripleForBinding,
} from '@shared/model-profiles';
import { isOpenAiImageModel, type ModelPreference } from '@shared/types';
import { Select, type SelectOption } from '@/common/ui/select';
import {
  useActivateModelProfile,
  useActiveModelProfileId,
  useModelProfilesSetting,
  useUpdateModelProfiles,
} from '@/hooks/use-model-profiles';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { Button } from '@/common/ui/button';
import { Switch } from '@/common/ui/switch';
import { useBackendModels } from '@/hooks/use-backend-models';
import { useBackendsSetting } from '@/hooks/use-settings';
import { useSkillsRailWidth } from '@/stores/navigation';

const EMPTY_PRESETS: ProfilePreset[] = [];
const EMPTY_QUICK_PRESET_IDS: string[] = [];
const DEFAULT_ENABLED_BACKENDS: AgentBackendType[] = ['claude-code'];

type RoleDefinition = (typeof ROLE_DEFINITIONS)[number];

/**
 * Label for the `inherit` option.
 *
 * "Inherit from Agent" says neither *which* agent nor *what you get*. Naming
 * the row it copies ("the Agent row above") and spelling out the resolved
 * model makes the binding legible without having to scroll up and cross-check.
 */
function inheritLabel(agentTriple: ModelTriple | null) {
  if (!agentTriple) return 'Same as Agent row above (not set yet)';
  const effort =
    agentTriple.thinkingEffort && agentTriple.thinkingEffort !== 'default'
      ? ` · ${agentTriple.thinkingEffort}`
      : '';
  return `Same as Agent row above (${agentTriple.backend} / ${agentTriple.model}${effort})`;
}

function tripleSummary(triple: ModelTriple) {
  const effort =
    triple.thinkingEffort && triple.thinkingEffort !== 'default'
      ? ` · ${triple.thinkingEffort}`
      : '';
  return `${triple.backend} / ${triple.model}${effort}`;
}

function presetDescription(preset: ProfilePreset) {
  return tripleSummary(preset);
}

/**
 * The preset a role follows, if it follows one. Matching is by **id**: an
 * ad-hoc `Custom…` triple that happens to equal a preset is still a one-off
 * and must not be shown as bound to it.
 */
function referencedPreset(
  binding: RoleBinding | undefined,
  presets: readonly ProfilePreset[],
) {
  if (!isPresetRefBinding(binding)) return null;
  return presets.find((preset) => preset.id === binding.presetId) ?? null;
}

/** One-line description of what a row resolves to, shown on the summary button. */
function bindingSummary({
  role,
  binding,
  presets,
}: {
  role: RoleDefinition;
  binding: RoleBinding | undefined;
  presets: readonly ProfilePreset[];
}) {
  if (binding === OFF_BINDING) return 'Off';
  if (role.modelKind === 'image') {
    return isImageModelBinding(binding) ? binding.imageModel : 'Default';
  }
  // Naming the preset is what tells a bound row from an ad-hoc one at a
  // glance — and the triple still says what it currently resolves to.
  const preset = referencedPreset(binding, presets);
  if (preset) {
    return `${preset.name || 'Untitled preset'} · ${tripleSummary(preset)}`;
  }
  if (isModelTriple(binding)) return tripleSummary(binding);
  if (role.id === 'agent') return 'Not set';
  return 'Same as Agent';
}

/**
 * Backend + model + thinking, the three halves of a `ModelTriple`.
 *
 * Uses `Select` rather than `ModelSelector` / `ThinkingSelector` only because
 * those wrappers hardcode the accessible names "Model" and "Think": a screen
 * with twelve role rows plus a preset list needs the name to say *which* row.
 * The option lists are the same shared helpers those wrappers use.
 */
function TripleSelectors({
  triple,
  labelPrefix,
  backendOptions,
  stacked = false,
  onChange,
}: {
  triple: ModelTriple;
  /** Prefixes each control's accessible name, e.g. "Summaries" → "Summaries model". */
  labelPrefix: string;
  backendOptions: SelectOption<AgentBackendType>[];
  /** Inside a popover the three controls stack and fill the width. */
  stacked?: boolean;
  onChange: (next: ModelTriple) => void;
}) {
  const { data: dynamicModels, isFetched } = useBackendModels(triple.backend);

  const thinkingCapabilities = getModelThinkingCapabilities(
    triple.model,
    dynamicModels,
  );
  const thinkingOptions = getThinkingEffortOptions({
    backend: triple.backend,
    model: triple.model,
    capabilities: thinkingCapabilities,
  });
  const thinkingEffort = normalizeThinkingEffortForModel({
    backend: triple.backend,
    model: triple.model,
    effort: triple.thinkingEffort,
    capabilities: thinkingCapabilities,
  });

  const modelOptions = useMemo(() => {
    const available = getModelsForBackend(triple.backend, dynamicModels).map(
      (model): SelectOption<ModelPreference> => ({
        value: model.value,
        label: model.label,
        description: model.description,
        group: model.group,
      }),
    );
    if (available.some((model) => model.value === triple.model)) {
      return available;
    }
    return [
      {
        value: triple.model,
        label: getModelLabel(triple.model, triple.backend, dynamicModels),
        description: isFetched ? 'Previously selected model' : 'Loading model',
      },
      ...available,
    ];
  }, [dynamicModels, isFetched, triple.backend, triple.model]);

  const selectClassName = stacked ? 'w-full justify-between' : undefined;

  return (
    <>
      <Select
        size="sm"
        className={selectClassName}
        label={`${labelPrefix} backend`}
        value={triple.backend}
        options={backendOptions}
        onChange={(backend) =>
          onChange({ backend, model: 'default', thinkingEffort: 'default' })
        }
      />
      <Select
        size="sm"
        className={selectClassName}
        label={`${labelPrefix} model`}
        value={triple.model}
        options={modelOptions}
        onChange={(model) =>
          onChange({
            ...triple,
            model,
            thinkingEffort: normalizeThinkingEffortForModel({
              backend: triple.backend,
              model,
              effort: triple.thinkingEffort,
              capabilities: getModelThinkingCapabilities(model, dynamicModels),
            }),
          })
        }
      />
      <Select
        size="sm"
        className={selectClassName}
        label={`${labelPrefix} thinking`}
        value={thinkingEffort}
        options={thinkingOptions}
        disabled={thinkingOptions.length <= 1}
        onChange={(nextEffort) =>
          onChange({ ...triple, thinkingEffort: nextEffort })
        }
      />
    </>
  );
}

/**
 * Label + description on the left.
 *
 * The marker is deliberately quiet: it answers "what does this profile
 * actually change?" at a glance without competing with the role name.
 */
function RoleHeader({
  role,
}: {
  role: RoleDefinition;
}) {
  return (
    <div className="min-w-0">
      <span className="text-ink-1 block truncate text-sm font-medium">
        {role.label}
      </span>
      <div className="text-ink-3 text-xs">{role.description}</div>
    </div>
  );
}

/**
 * The single control on the right of a role row: a summary of what the row
 * resolves to, which opens the editor in a popover.
 *
 * Inline expansion was the alternative. With thirteen always-visible rows and
 * no grouping, expanding in place shoves every row below it around on each
 * click; a popover keeps the list stable and reuses the gesture the composer's
 * model picker already teaches.
 */
function RoleEditorPopover({
  role,
  summary,
  onOpen,
  children,
}: {
  role: RoleDefinition;
  summary: string;
  /** Fired each time the popover opens, so the row can reset its reveal state. */
  onOpen?: () => void;
  /** Receives a `close` so a one-click item can apply *and* dismiss. */
  children: (close: () => void) => ReactNode;
}) {
  // State rather than a ref: `Dropdown` assigns object refs in a microtask,
  // which is a tick too late for a click handler in the same task, and reading
  // a ref while rendering the children is exactly what the compiler forbids.
  const [handle, setHandle] = useState<{
    toggle: (restoreFocusTo?: HTMLElement | null) => void;
  } | null>(null);
  const close = useCallback(() => handle?.toggle(), [handle]);

  return (
    <Dropdown
      align="right"
      initialFocusIndex={-1}
      className="w-[300px] py-1"
      dropdownRef={setHandle}
      onOpen={onOpen}
      trigger={
        <button
          type="button"
          aria-label={`${role.label} binding summary`}
          className="bg-glass-light hover:bg-glass-medium text-ink-1 flex max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors"
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
        </button>
      }
    >
      {children(close)}
    </Dropdown>
  );
}

/** Quiet section heading inside the popover — not a focusable menu item. */
function PopoverSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-ink-4 px-3 pt-1 pb-0.5 text-[10px] font-semibold tracking-[0.14em] uppercase">
      {children}
    </div>
  );
}

/** Name over the triple it applies, so the item says what it will do. */
function ItemWithDetail({
  label,
  detail,
}: {
  label: string;
  detail: string;
}) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{label}</span>
      <span className="text-ink-3 truncate text-xs">{detail}</span>
    </span>
  );
}

function ResetToInheritItem({
  role,
  disabled,
  toDefault,
  onReset,
}: {
  role: RoleDefinition;
  disabled: boolean;
  /** Image roles have no Agent row to follow: their neutral state is "default". */
  toDefault?: boolean;
  onReset: () => void;
}) {
  const label = toDefault ? 'Reset to default' : 'Reset to inherit';
  return (
    <>
      <DropdownDivider />
      <DropdownItem
        icon={<RotateCcw />}
        disabled={disabled}
        onClick={onReset}
      >
        {`${label} (${role.label})`}
      </DropdownItem>
    </>
  );
}

/**
 * An image role (`project-logo`) selects an OpenAI image model and nothing
 * else: generation goes straight to the images API with its own key, so there
 * is no backend, no thinking level, and no preset to apply (presets are chat
 * triples). `isOpenAiImageModel` is a `gpt-image` prefix check rather than an
 * enumerated list, so the control is a validated text input, not a dropdown.
 *
 * There is also no `inherit`: the Agent row holds a chat model. Unset means
 * "use the model from AI Generation settings".
 */
function ImageRoleRow({
  role,
  binding,
  onChange,
}: {
  role: RoleDefinition;
  binding: RoleBinding | undefined;
  onChange: (next: RoleBinding | null) => void;
}) {
  const storedModel = isImageModelBinding(binding) ? binding.imageModel : null;
  // Held on the row (not inside the popover) so closing and reopening the
  // editor does not throw away an in-progress, possibly invalid, value.
  const [draft, setDraft] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);

  const isOff = binding === OFF_BINDING;
  const isCustom = !isOff && (storedModel !== null || draft !== null);

  const value = draft ?? storedModel ?? '';
  const invalid = value.trim().length > 0 && !isOpenAiImageModel(value);

  // A stable `onOpen` (Dropdown fires it from an effect keyed on the callback
  // identity) that still sees the current binding.
  const revealOnOpenRef = useRef(false);
  useEffect(() => {
    revealOnOpenRef.current = isCustom;
  }, [isCustom]);
  const handleOpen = useCallback(
    () => setShowCustom(revealOnOpenRef.current),
    [],
  );

  return (
    <div className="border-line-soft flex items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0">
      <RoleHeader role={role} />
      <RoleEditorPopover
        role={role}
        summary={bindingSummary({ role, binding, presets: EMPTY_PRESETS })}
        onOpen={handleOpen}
      >
        {(close) => (
          <>
            <DropdownItem
              checked={!isOff && !isCustom}
              onClick={() => {
                setDraft(null);
                onChange(null);
                close();
              }}
            >
              Default (from AI Generation settings)
            </DropdownItem>
            {role.canBeOff && (
              <DropdownItem
                checked={isOff}
                onClick={() => {
                  setDraft(null);
                  onChange(OFF_BINDING);
                  close();
                }}
              >
                Off (disabled)
              </DropdownItem>
            )}
            <DropdownDivider />
            <DropdownItem
              checked={isCustom}
              onClick={() => {
                setDraft(storedModel ?? '');
                setShowCustom(true);
              }}
            >
              Custom…
            </DropdownItem>
            {showCustom && (
              <div className="flex flex-col gap-0.5 px-3 py-1.5">
                <input
                  aria-label={`${role.label} image model`}
                  aria-invalid={invalid}
                  value={value}
                  placeholder="gpt-image-2"
                  onChange={(event) => {
                    const next = event.target.value;
                    setDraft(next);
                    const trimmed = next.trim();
                    if (trimmed.length === 0) {
                      // Empty is "no binding yet", not an error: fall back to
                      // the AI Generation default until something valid lands.
                      onChange(null);
                      return;
                    }
                    if (isOpenAiImageModel(trimmed)) {
                      onChange({ imageModel: trimmed });
                    }
                  }}
                  className={clsx(
                    'text-ink-1 placeholder:text-ink-4 focus:bg-bg-2 w-full rounded-md border bg-transparent px-2 py-1 text-[13px] outline-none',
                    invalid
                      ? 'border-status-fail'
                      : 'border-line-soft focus:border-acc',
                  )}
                />
                {invalid && (
                  <div role="alert" className="text-status-fail text-xs">
                    Must be a gpt-image model
                  </div>
                )}
              </div>
            )}
            <ResetToInheritItem
              role={role}
              toDefault
              disabled={binding === undefined && draft === null}
              onReset={() => {
                setDraft(null);
                setShowCustom(false);
                onChange(null);
              }}
            />
          </>
        )}
      </RoleEditorPopover>
    </div>
  );
}

function RoleRow({
  role,
  binding,
  presets,
  agentTriple,
  backendOptions,
  defaultTriple,
  onChange,
}: {
  role: RoleDefinition;
  binding: RoleBinding | undefined;
  /** Presets of the *selected profile*; applying one copies its triple in. */
  presets: ProfilePreset[];
  /** Triple bound to this profile's `agent` role, for the inherit label. */
  agentTriple: ModelTriple | null;
  backendOptions: SelectOption<AgentBackendType>[];
  defaultTriple: ModelTriple;
  onChange: (next: RoleBinding | null) => void;
}) {

  // A toggle-only role has no model to choose — it only decides whether the
  // feature runs under this profile — so a switch says what a dropdown of two
  // options cannot. `off` is the stored binding; anything else means on.
  if (role.toggleOnly) {
    return (
      <div className="border-line-soft flex items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0">
        <RoleHeader role={role} />
        <Switch
          label={role.label}
          checked={binding !== OFF_BINDING}
          onChange={(checked) =>
            onChange(checked ? INHERIT_BINDING : OFF_BINDING)
          }
        />
      </div>
    );
  }

  if (role.modelKind === 'image') {
    return <ImageRoleRow role={role} binding={binding} onChange={onChange} />;
  }

  return (
    <ChatRoleRow
      role={role}
      binding={binding}
      presets={presets}
      agentTriple={agentTriple}
      backendOptions={backendOptions}
      defaultTriple={defaultTriple}
      onChange={onChange}
    />
  );
}

/**
 * A chat role: one flat list of outcomes — every preset of the profile, then
 * inherit/off, then `Custom…` which reveals the three selects in place.
 */
function ChatRoleRow({
  role,
  binding,
  presets,
  agentTriple,
  backendOptions,
  defaultTriple,
  onChange,
}: {
  role: RoleDefinition;
  binding: RoleBinding | undefined;
  presets: ProfilePreset[];
  agentTriple: ModelTriple | null;
  backendOptions: SelectOption<AgentBackendType>[];
  defaultTriple: ModelTriple;
  onChange: (next: RoleBinding | null) => void;
}) {
  const isAgent = role.id === 'agent';

  // `triple` is the *inline* selection only: a preset reference is rendered as
  // the preset it follows, never as a Custom… triple.
  const triple = isModelTriple(binding) ? binding : null;
  const boundPresetId = isPresetRefBinding(binding) ? binding.presetId : null;
  const isInherit =
    !isAgent && (binding === undefined || binding === INHERIT_BINDING);

  // Only an ad-hoc triple needs the three selects on open; everything else is
  // one of the flat items above them.
  const [showCustom, setShowCustom] = useState(false);
  const revealOnOpenRef = useRef(false);
  const shouldReveal = triple !== null;
  useEffect(() => {
    revealOnOpenRef.current = shouldReveal;
  }, [shouldReveal]);
  const handleOpen = useCallback(
    () => setShowCustom(revealOnOpenRef.current),
    [],
  );

  return (
    <div className="border-line-soft flex items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0">
      <RoleHeader role={role} />
      <RoleEditorPopover
        role={role}
        summary={bindingSummary({ role, binding, presets })}
        onOpen={handleOpen}
      >
        {(close) => (
          <>
            <PopoverSectionLabel>Presets</PopoverSectionLabel>
            {presets.length === 0 ? (
              <div className="text-ink-3 px-3 pb-1 text-xs">
                Add a preset above to apply it in one click
              </div>
            ) : (
              presets.map((preset) => (
                <DropdownItem
                  key={preset.id}
                  checked={boundPresetId === preset.id}
                  onClick={() => {
                    // Reference, not copy: a preset is a shared definition, so
                    // editing it must move every role bound to it. Deleting it
                    // inlines the triple here, so nothing can dangle.
                    onChange({ presetId: preset.id });
                    close();
                  }}
                >
                  <ItemWithDetail
                    label={preset.name || 'Untitled preset'}
                    detail={presetDescription(preset)}
                  />
                </DropdownItem>
              ))
            )}
            <DropdownDivider />
            {isAgent ? (
              <DropdownItem
                checked={binding === undefined}
                onClick={() => {
                  onChange(null);
                  close();
                }}
              >
                Not set
              </DropdownItem>
            ) : (
              <DropdownItem
                checked={isInherit}
                onClick={() => {
                  onChange(INHERIT_BINDING);
                  close();
                }}
              >
                {inheritLabel(agentTriple)}
              </DropdownItem>
            )}
            {role.canBeOff && !isAgent && (
              <DropdownItem
                checked={binding === OFF_BINDING}
                onClick={() => {
                  onChange(OFF_BINDING);
                  close();
                }}
              >
                Off (disabled)
              </DropdownItem>
            )}
            <DropdownDivider />
            <DropdownItem
              checked={triple !== null}
              onClick={() => {
                // Start from whatever this row already resolves to, so
                // revealing Custom never silently changes the model — including
                // detaching from a preset at its current values.
                onChange(
                  triple ??
                    tripleForBinding({ binding, presets }) ??
                    agentTriple ??
                    defaultTriple,
                );
                setShowCustom(true);
              }}
            >
              Custom…
            </DropdownItem>
            {showCustom && triple !== null && (
              <div className="flex flex-col gap-2 px-3 py-1.5">
                <TripleSelectors
                  triple={triple}
                  labelPrefix={role.label}
                  backendOptions={backendOptions}
                  stacked
                  onChange={onChange}
                />
              </div>
            )}
            {!isAgent && (
              <ResetToInheritItem
                role={role}
                disabled={isInherit}
                onReset={() => {
                  setShowCustom(false);
                  onChange(INHERIT_BINDING);
                }}
              />
            )}
          </>
        )}
      </RoleEditorPopover>
    </div>
  );
}

function PresetRow({
  preset,
  index,
  inQuickList,
  backendOptions,
  nameDraft,
  onNameDraft,
  onChange,
  onToggleQuick,
  onDelete,
}: {
  preset: ProfilePreset;
  index: number;
  inQuickList: boolean;
  backendOptions: SelectOption<AgentBackendType>[];
  nameDraft: string | null;
  onNameDraft: (value: string | null) => void;
  onChange: (next: Partial<ProfilePreset>) => void;
  onToggleQuick: () => void;
  onDelete: () => void;
}) {
  const name = preset.name || `preset ${index + 1}`;

  return (
    <div className="group border-line-soft flex flex-wrap items-center gap-1.5 border-b px-4 py-2 last:border-b-0">
      <input
        aria-label={`Name for preset ${name}`}
        value={nameDraft ?? preset.name}
        placeholder="Untitled"
        onChange={(event) => onNameDraft(event.target.value)}
        onBlur={() => {
          if (nameDraft !== null && nameDraft !== preset.name) {
            onChange({ name: nameDraft });
          }
          onNameDraft(null);
        }}
        className="text-ink-1 placeholder:text-ink-4 hover:border-line-soft focus:bg-bg-2 focus:border-acc w-32 shrink-0 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] font-medium outline-none"
      />
      <TripleSelectors
        triple={preset}
        labelPrefix={`Preset ${name}`}
        backendOptions={backendOptions}
        onChange={onChange}
      />
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onToggleQuick}
          aria-pressed={inQuickList}
          aria-label={`Toggle quick list for ${name}`}
          title={
            inQuickList
              ? 'Offered in the composer quick list'
              : 'Hidden from the composer quick list'
          }
          className={clsx(
            'hover:bg-bg-3 grid h-7 w-7 place-items-center rounded-md',
            inQuickList ? 'text-acc-ink' : 'text-ink-4 hover:text-ink-1',
          )}
        >
          <Star className={clsx('h-3.5 w-3.5', inQuickList && 'fill-current')} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete preset ${name}`}
          className="text-ink-4 hover:bg-status-fail/15 hover:text-status-fail grid h-7 w-7 place-items-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * The profile rail, on the shared settings list primitives so it resizes and
 * reads like Skills / Agents / Sources rather than a bespoke flex column.
 */
function ProfileRail({
  profiles,
  selectedId,
  activeProfileId,
  onSelect,
  onAdd,
  onDelete,
}: {
  profiles: ModelProfile[];
  selectedId: string | null;
  activeProfileId: string | null;
  onSelect: (profileId: string) => void;
  onAdd: () => void;
  onDelete: (profileId: string) => void;
}) {
  const { width, setWidth, minWidth, maxWidth } = useSkillsRailWidth();
  const onWidthChange = useCallback((next: number) => setWidth(next), [setWidth]);

  return (
    <ListPane
      width={width}
      minWidth={minWidth}
      maxWidth={maxWidth}
      onWidthChange={onWidthChange}
      title="Profiles"
      count={profiles.length}
      headerActions={
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add profile"
          title="Add profile"
          className="shrink-0 rounded p-1 transition-colors"
          style={{ color: 'oklch(0.78 0.18 295)' }}
        >
          <Plus size={13} />
        </button>
      }
    >
      {profiles.length === 0 ? (
        <div className="text-ink-3 px-4 py-6 text-center text-sm">
          No profiles yet.
        </div>
      ) : (
        profiles.map((profile) => (
          <div key={profile.id} className="group relative">
            <ListItemButton
              label={profile.name || 'Untitled'}
              isActive={profile.id === selectedId}
              size="compact"
              onClick={() => onSelect(profile.id)}
              suffix={
                profile.id === activeProfileId ? (
                  <span
                    className="text-acc-ink ml-auto shrink-0 pr-6"
                    title="Active profile"
                    aria-label={`${profile.name} is active`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                ) : undefined
              }
            />
            <button
              type="button"
              onClick={() => onDelete(profile.id)}
              disabled={profiles.length <= 1}
              title={
                profiles.length <= 1
                  ? 'You need at least one model profile'
                  : undefined
              }
              aria-label={`Delete profile ${profile.name}`}
              className="text-ink-4 hover:bg-status-fail/15 hover:text-status-fail absolute top-1/2 right-2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))
      )}
    </ListPane>
  );
}

export function ModelProfilesSettings() {
  const { profiles } = useModelProfilesSetting();
  const { activeProfileId } = useActiveModelProfileId();
  const { data: backendsSetting } = useBackendsSetting();
  const updateSetting = useUpdateModelProfiles();
  const activateProfile = useActivateModelProfile();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keyed by id so switching profile/preset drops the draft without an effect.
  const [nameDraft, setNameDraft] = useState<{
    key: string;
    value: string;
  } | null>(null);

  const selectedProfile = useMemo(() => {
    const byId = selectedId
      ? profiles.find((profile) => profile.id === selectedId)
      : undefined;
    if (byId) return byId;
    return (
      profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]
    );
  }, [activeProfileId, profiles, selectedId]);

  const enabledBackends = useMemo(
    () => backendsSetting?.enabledBackends ?? DEFAULT_ENABLED_BACKENDS,
    [backendsSetting?.enabledBackends],
  );
  const backendOptions = useMemo(
    () =>
      AVAILABLE_BACKENDS.filter((backend) =>
        enabledBackends.includes(backend.value),
      ).map(
        (backend): SelectOption<AgentBackendType> => ({
          value: backend.value,
          label: backend.label,
          description: backend.description,
          badge: backend.badge,
        }),
      ),
    [enabledBackends],
  );
  const defaultTriple = useMemo(
    (): ModelTriple => ({
      backend: enabledBackends[0] ?? 'claude-code',
      model: 'default',
      thinkingEffort: 'default',
    }),
    [enabledBackends],
  );

  // What `inherit` actually resolves to for this profile, so every inheriting
  // row can say so instead of making the reader cross-check the Agent row.
  const agentTriple = useMemo(
    () =>
      tripleForBinding({
        binding: selectedProfile?.roles.agent,
        presets: selectedProfile?.presets ?? EMPTY_PRESETS,
      }),
    [selectedProfile],
  );

  const presets = selectedProfile?.presets ?? EMPTY_PRESETS;
  const quickPresetIds =
    selectedProfile?.quickPresetIds ?? EMPTY_QUICK_PRESET_IDS;

  const draftFor = (key: string) =>
    nameDraft && nameDraft.key === key ? nameDraft.value : null;

  const commit = (next: ModelProfile[]) => {
    updateSetting.mutate({ key: 'modelProfiles', value: next });
  };

  const patchSelected = (patch: Partial<ModelProfile>) => {
    if (!selectedProfile) return;
    commit(
      profiles.map((profile) =>
        profile.id === selectedProfile.id ? { ...profile, ...patch } : profile,
      ),
    );
  };

  const handleAddProfile = () => {
    const id = nanoid();
    commit([
      ...profiles,
      { id, name: 'New profile', presets: [], quickPresetIds: [], roles: {} },
    ]);
    setSelectedId(id);
  };

  const handleDeleteProfile = (profileId: string) => {
    // Refuse to delete the last one. With no profiles left, every role falls
    // through to the app fallback and an `enforce` project cannot start a
    // session at all — and the startup migration would quietly regenerate a
    // "Default" profile on the next launch, silently undoing the deletion.
    if (profiles.length <= 1) return;
    commit(profiles.filter((profile) => profile.id !== profileId));
    if (selectedId === profileId) setSelectedId(null);
  };

  const handleRoleChange = (role: ModelRole, binding: RoleBinding | null) => {
    if (!selectedProfile) return;
    const roles = { ...selectedProfile.roles };
    if (binding === null) {
      delete roles[role];
    } else {
      roles[role] = binding;
    }
    patchSelected({ roles });
  };

  const handleAddPreset = () => {
    const id = nanoid();
    patchSelected({
      presets: [
        ...presets,
        {
          id,
          name: '',
          backend: defaultTriple.backend,
          model: 'default',
          thinkingEffort: 'default',
        },
      ],
      // New presets start in the quick list, matching what the composer used to
      // offer for a freshly created preset.
      quickPresetIds: [...quickPresetIds, id],
    });
  };

  const handlePresetChange = (
    presetId: string,
    patch: Partial<ProfilePreset>,
  ) => {
    patchSelected({
      presets: presets.map((preset) =>
        preset.id === presetId ? { ...preset, ...patch } : preset,
      ),
    });
  };

  /**
   * Deleting a preset must not orphan the roles that follow it: inline its
   * triple into each of them in the same update, so every role keeps resolving
   * to exactly what it resolved to a second earlier.
   */
  const handleDeletePreset = (presetId: string) => {
    if (!selectedProfile) return;
    const deleted = presets.find((preset) => preset.id === presetId);
    const roles = { ...selectedProfile.roles };
    if (deleted) {
      for (const [role, binding] of Object.entries(roles)) {
        if (isPresetRefBinding(binding) && binding.presetId === presetId) {
          roles[role as ModelRole] = {
            backend: deleted.backend,
            model: deleted.model,
            thinkingEffort: deleted.thinkingEffort,
          };
        }
      }
    }
    patchSelected({
      presets: presets.filter((preset) => preset.id !== presetId),
      quickPresetIds: quickPresetIds.filter((id) => id !== presetId),
      roles,
    });
  };

  const handleToggleQuickPreset = (presetId: string) => {
    patchSelected({
      quickPresetIds: quickPresetIds.includes(presetId)
        ? quickPresetIds.filter((id) => id !== presetId)
        : [...quickPresetIds, presetId],
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 className="text-ink-1 text-lg font-semibold">Model profiles</h2>
      <p className="text-ink-3 mt-1 mb-4 max-w-[520px] text-sm">
        A profile binds every model role to a backend, model and thinking level.
        Activating a profile moves the main agent and every AI-generation
        feature in one switch. Roles left on <em>inherit</em> follow the Agent
        role.
      </p>

      <ListDetailLayout
        list={
          <ProfileRail
            profiles={profiles}
            selectedId={selectedProfile?.id ?? null}
            activeProfileId={activeProfileId}
            onSelect={setSelectedId}
            onAdd={handleAddProfile}
            onDelete={handleDeleteProfile}
          />
        }
        detail={
          selectedProfile ? (
            <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
              <div className="border-line-soft flex items-center gap-2 border-b px-4 py-2.5">
                <input
                  aria-label="Profile name"
                  value={draftFor(selectedProfile.id) ?? selectedProfile.name}
                  placeholder="Untitled"
                  onChange={(event) =>
                    setNameDraft({
                      key: selectedProfile.id,
                      value: event.target.value,
                    })
                  }
                  onBlur={() => {
                    const draft = draftFor(selectedProfile.id);
                    if (draft !== null && draft !== selectedProfile.name) {
                      patchSelected({ name: draft });
                    }
                    setNameDraft(null);
                  }}
                  className="text-ink-1 placeholder:text-ink-4 hover:border-line-soft focus:bg-bg-2 focus:border-acc min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none"
                />
                <Button
                  size="sm"
                  variant={
                    selectedProfile.id === activeProfileId ? 'primary' : 'ghost'
                  }
                  disabled={selectedProfile.id === activeProfileId}
                  aria-label={`Activate profile ${selectedProfile.name}`}
                  onClick={() => activateProfile.mutate(selectedProfile.id)}
                >
                  {selectedProfile.id === activeProfileId
                    ? 'Active'
                    : 'Activate'}
                </Button>
              </div>

              <div className="border-line-soft bg-bg-0/40 border-t px-4 py-2.5">
                <div className="text-ink-1 text-sm font-medium">
                  Presets of this profile
                </div>
                <div className="text-ink-3 text-xs">
                  Shortcuts you can apply to any role below. Starred presets
                  appear in the task composer while this profile is active.
                </div>
              </div>

              {presets.length === 0 ? (
                <div className="text-ink-3 border-line-soft border-b px-4 py-4 text-center text-sm">
                  No presets in this profile yet.
                </div>
              ) : (
                presets.map((preset, index) => (
                  <PresetRow
                    key={preset.id}
                    preset={preset}
                    index={index}
                    inQuickList={quickPresetIds.includes(preset.id)}
                    backendOptions={backendOptions}
                    nameDraft={draftFor(preset.id)}
                    onNameDraft={(value) =>
                      setNameDraft(
                        value === null ? null : { key: preset.id, value },
                      )
                    }
                    onChange={(patch) => handlePresetChange(preset.id, patch)}
                    onToggleQuick={() => handleToggleQuickPreset(preset.id)}
                    onDelete={() => handleDeletePreset(preset.id)}
                  />
                ))
              )}

              <div className="px-2 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Plus />}
                  aria-label="Add preset"
                  onClick={handleAddPreset}
                >
                  Add preset
                </Button>
              </div>

              <div className="border-line-soft bg-bg-0/40 border-t px-4 py-2.5">
                <div className="text-ink-1 text-sm font-medium">Roles</div>
                <div className="text-ink-3 text-xs">
                  What each part of the app runs on under this profile.
                </div>
              </div>

              {ROLE_DEFINITIONS.map((role) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  binding={selectedProfile.roles[role.id]}
                  presets={presets}
                  agentTriple={agentTriple}
                  backendOptions={backendOptions}
                  defaultTriple={defaultTriple}
                  onChange={(binding) => handleRoleChange(role.id, binding)}
                />
              ))}
            </div>
          ) : (
            <DetailPlaceholder
              message="No profiles yet. Create one to bind every model role at once."
              actions={
                <Button size="sm" icon={<Plus />} onClick={handleAddProfile}>
                  New profile
                </Button>
              }
            />
          )
        }
      />
    </div>
  );
}
