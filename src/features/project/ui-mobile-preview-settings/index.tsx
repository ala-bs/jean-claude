import {
  AlertTriangle,
  ChevronRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  Smartphone,
} from 'lucide-react';
import {
  getDefaultMobileBuildCommand,
  migrateBuildCommand,
  migrateDetectedCommand,
  migrateIosBundleId,
} from '@/lib/mobile-preview-config';
import {
  type MobilePreviewDetectedApp,
  type MobilePreviewProjectConfig,
  type MobilePreviewProjectStack,
} from '@shared/types';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

const ALL_STACKS: MobilePreviewProjectStack[] = [
  'expo',
  'react-native',
  'ios',
  'android',
];

const DEFAULT_METRO_PORT = 8081;

const TAG_CLASS =
  'rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-[0.5px] uppercase';
const SECTION_LABEL_CLASS =
  'text-ink-3 font-mono text-[10.5px] font-semibold tracking-[0.9px] uppercase';

function stackLabel(stack: MobilePreviewProjectStack) {
  return stack === 'react-native' ? 'RN' : stack;
}

function getPackageExec(
  packageManager: MobilePreviewProjectConfig['packageManager'],
) {
  if (packageManager === 'pnpm') return 'pnpm exec';
  if (packageManager === 'yarn') return 'yarn';
  if (packageManager === 'bun') return 'bunx';
  return 'npx';
}

function getDefaultAndroidProjectPath(
  config: MobilePreviewProjectConfig,
  selectedAppPath = config.selectedAppPath,
) {
  if (!selectedAppPath) return null;
  return (
    config.detectedApps.find((app) => app.path === selectedAppPath)
      ?.androidProjectPath ?? null
  );
}

function isPackageOnlyMobileCandidate(app: MobilePreviewDetectedApp) {
  const hasNativeProject =
    app.stacks.includes('ios') || app.stacks.includes('android');
  const hasAppConfig = app.reasons.some((reason) =>
    reason.toLowerCase().includes('app config'),
  );
  const dependencyOnly = app.reasons.every((reason) =>
    reason.toLowerCase().includes('dependency'),
  );

  return dependencyOnly && !hasNativeProject && !hasAppConfig;
}

function formatMobileAppPath(app: MobilePreviewDetectedApp) {
  return app.path === '.' ? 'Root app' : app.path;
}

function getAppWarning(app: MobilePreviewDetectedApp | undefined) {
  if (!app) return null;
  if (isPackageOnlyMobileCandidate(app)) {
    return 'Looks like a shared package, not a runnable app. Commands must be filled in manually.';
  }
  if (!app.stacks.includes('ios') && app.stacks.includes('android')) {
    return 'No iOS project found — iOS runs will be unavailable for this app.';
  }
  if (!app.stacks.includes('android') && app.stacks.includes('ios')) {
    return 'No Android project found — Android runs will be unavailable for this app.';
  }
  return null;
}

function PanelSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-5 w-9 shrink-0 cursor-pointer rounded-[11px] border transition-colors',
        checked ? 'border-acc-line bg-acc-soft' : 'border-line bg-bg-2',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full transition-[transform,background-color] duration-150',
          checked ? 'bg-acc translate-x-4' : 'bg-ink-3 translate-x-0',
        )}
      />
    </button>
  );
}

type CommandField = {
  key: string;
  label: string;
  placeholder: string;
  value: string;
  isCustom: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
};

function RowIconButton({
  title,
  onClick,
  alwaysVisible,
  children,
}: {
  title: string;
  onClick: () => void;
  alwaysVisible?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={clsx(
        'text-ink-4 hover:bg-bg-4 hover:text-ink-0 grid h-6 w-6 cursor-pointer place-items-center rounded-[5px] transition-opacity',
        alwaysVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
      )}
    >
      {children}
    </button>
  );
}

function CommandRow({
  field,
  editingKey,
  onEdit,
  onStopEditing,
}: {
  field: CommandField;
  editingKey: string | null;
  onEdit: (key: string) => void;
  onStopEditing: () => void;
}) {
  const isEditing = editingKey === field.key;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  return (
    <div className="border-line-soft hover:bg-bg-3/50 group grid min-h-[34px] grid-cols-[172px_1fr_auto] items-center gap-2.5 border-b py-1 pr-2.5 pl-3 last:border-b-0">
      <span className="text-ink-2 text-[12.5px]">{field.label}</span>
      {isEditing ? (
        <input
          ref={inputRef}
          value={field.value}
          placeholder={field.placeholder}
          onChange={(event) => field.onChange(event.target.value)}
          onBlur={onStopEditing}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.currentTarget.blur();
            }
          }}
          className="border-acc-line bg-bg-0 text-ink-0 w-full rounded-[5px] border px-[7px] py-[3px] font-mono text-xs shadow-[0_0_0_3px_var(--color-acc-soft)] outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => onEdit(field.key)}
          className={clsx(
            'cursor-text truncate text-left font-mono text-xs',
            field.value ? 'text-ink-1' : 'text-ink-4',
          )}
        >
          {field.value || field.placeholder}
        </button>
      )}
      {!isEditing && (
        <span className="flex items-center justify-self-end gap-0.5">
          <span
            className={clsx(
              TAG_CLASS,
              'border',
              field.isCustom
                ? 'text-acc-ink border-acc-line bg-acc-soft'
                : 'text-ink-4 border-line',
            )}
          >
            {field.isCustom ? 'custom' : 'auto'}
          </span>
          <RowIconButton title="Edit" onClick={() => onEdit(field.key)}>
            <Pencil className="h-3 w-3" />
          </RowIconButton>
          {field.isCustom && (
            <RowIconButton
              title="Reset to detected"
              onClick={field.onReset}
              alwaysVisible
            >
              <RotateCcw className="h-3 w-3" />
            </RowIconButton>
          )}
        </span>
      )}
    </div>
  );
}

export function ProjectMobilePreviewIntegration({
  config,
  isDetecting,
  onChange,
  onDetect,
}: {
  config: MobilePreviewProjectConfig;
  isDetecting: boolean;
  onChange: (config: MobilePreviewProjectConfig) => void;
  onDetect: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const enabled = config.mode !== 'disabled';
  const selectedApp = config.detectedApps.find(
    (app) => app.path === config.selectedAppPath,
  );
  const warning = getAppWarning(selectedApp);
  const detectedStacks = [
    ...new Set(config.detectedApps.flatMap((app) => app.stacks)),
  ];

  const selectApp = (selectedAppPath: string | null) => {
    const previousDefaultAndroidProjectPath =
      getDefaultAndroidProjectPath(config);
    const currentSelectedApp = config.detectedApps.find(
      (app) => app.path === config.selectedAppPath,
    );
    const nextSelectedApp = config.detectedApps.find(
      (app) => app.path === selectedAppPath,
    );
    const nextDefaultAndroidProjectPath = getDefaultAndroidProjectPath(
      config,
      selectedAppPath,
    );
    const getGeneratedBuildCommand = (
      app: MobilePreviewDetectedApp | undefined,
      platform: 'android' | 'ios',
    ) =>
      app?.[
        platform === 'android'
          ? 'detectedAndroidBuildCommand'
          : 'detectedIosBuildCommand'
      ] ??
      getDefaultMobileBuildCommand({
        app,
        packageManager: config.packageManager,
        platform,
      });

    onChange({
      ...config,
      selectedAppPath,
      iosBundleId: migrateIosBundleId({
        currentSelectedAppPath: config.selectedAppPath,
        selectedAppPath,
        iosBundleId: config.iosBundleId,
      }),
      androidPackageName: migrateDetectedCommand({
        currentCommand: config.androidPackageName,
        currentDetectedCommand:
          currentSelectedApp?.detectedAndroidPackageName ?? null,
        selectedDetectedCommand:
          nextSelectedApp?.detectedAndroidPackageName ?? null,
      }),
      androidProjectPath:
        !config.androidProjectPath ||
        config.androidProjectPath === previousDefaultAndroidProjectPath
          ? nextDefaultAndroidProjectPath
          : config.androidProjectPath,
      androidBuildCommand: migrateBuildCommand({
        currentCommand: config.androidBuildCommand,
        currentGeneratedCommands: [
          currentSelectedApp?.detectedAndroidBuildCommand,
          getDefaultMobileBuildCommand({
            app: currentSelectedApp,
            packageManager: config.packageManager,
            platform: 'android',
          }),
        ],
        selectedGeneratedCommand: getGeneratedBuildCommand(
          nextSelectedApp,
          'android',
        ),
        legacyPackageManager: config.packageManager,
        platform: 'android',
      }),
      iosBuildCommand: migrateBuildCommand({
        currentCommand: config.iosBuildCommand,
        currentGeneratedCommands: [
          currentSelectedApp?.detectedIosBuildCommand,
          getDefaultMobileBuildCommand({
            app: currentSelectedApp,
            packageManager: config.packageManager,
            platform: 'ios',
          }),
        ],
        selectedGeneratedCommand: getGeneratedBuildCommand(
          nextSelectedApp,
          'ios',
        ),
        legacyPackageManager: config.packageManager,
        platform: 'ios',
      }),
      dependenciesInstallCommand: migrateDetectedCommand({
        currentCommand: config.dependenciesInstallCommand,
        currentDetectedCommand:
          currentSelectedApp?.detectedDependenciesInstallCommand ?? null,
        selectedDetectedCommand:
          nextSelectedApp?.detectedDependenciesInstallCommand ?? null,
      }),
      metroStartCommand: migrateDetectedCommand({
        currentCommand: config.metroStartCommand,
        currentDetectedCommand:
          currentSelectedApp?.detectedMetroStartCommand ?? null,
        selectedDetectedCommand:
          nextSelectedApp?.detectedMetroStartCommand ?? null,
      }),
      androidPrebuildCommand: migrateDetectedCommand({
        currentCommand: config.androidPrebuildCommand,
        currentDetectedCommand:
          currentSelectedApp?.detectedAndroidPrebuildCommand ?? null,
        selectedDetectedCommand:
          nextSelectedApp?.detectedAndroidPrebuildCommand ?? null,
      }),
      iosPrebuildCommand: migrateDetectedCommand({
        currentCommand: config.iosPrebuildCommand,
        currentDetectedCommand:
          currentSelectedApp?.detectedIosPrebuildCommand ?? null,
        selectedDetectedCommand:
          nextSelectedApp?.detectedIosPrebuildCommand ?? null,
      }),
    });
  };

  const textField = ({
    key,
    label,
    placeholder,
  }: {
    key: keyof MobilePreviewProjectConfig;
    label: string;
    placeholder: string;
  }): CommandField => {
    const value = (config[key] as string | null | undefined) ?? '';

    return {
      key,
      label,
      placeholder,
      value,
      isCustom: Boolean(value),
      onChange: (next) => onChange({ ...config, [key]: next || null }),
      onReset: () => {
        setEditingKey(null);
        onChange({ ...config, [key]: null });
      },
    };
  };

  const isCustomPort = Boolean(
    config.metroPort && config.metroPort !== DEFAULT_METRO_PORT,
  );
  const portField: CommandField = {
    key: 'metroPort',
    label: 'Dev server port',
    placeholder: String(DEFAULT_METRO_PORT),
    value: isCustomPort ? String(config.metroPort) : '',
    isCustom: isCustomPort,
    onChange: (next) => {
      const port = Number(next);
      onChange({
        ...config,
        metroPort:
          next && Number.isFinite(port) && port > 0 && port <= 65535
            ? port
            : DEFAULT_METRO_PORT,
      });
    },
    onReset: () => {
      setEditingKey(null);
      onChange({ ...config, metroPort: DEFAULT_METRO_PORT });
    },
  };

  const primaryFields: CommandField[] = [
    textField({
      key: 'metroStartCommand',
      label: 'Dev server',
      placeholder:
        selectedApp?.detectedMetroStartCommand ?? 'required, e.g. pnpm start',
    }),
    portField,
    textField({
      key: 'androidBuildCommand',
      label: 'Android build',
      placeholder:
        selectedApp?.detectedAndroidBuildCommand ??
        getDefaultMobileBuildCommand({
          app: selectedApp,
          packageManager: config.packageManager,
          platform: 'android',
        }) ??
        'not available',
    }),
    textField({
      key: 'iosBuildCommand',
      label: 'iOS build',
      placeholder:
        selectedApp?.detectedIosBuildCommand ??
        getDefaultMobileBuildCommand({
          app: selectedApp,
          packageManager: config.packageManager,
          platform: 'ios',
        }) ??
        'not available',
    }),
  ];

  const advancedFields: CommandField[] = [
    textField({
      key: 'dependenciesInstallCommand',
      label: 'Dependencies install',
      placeholder:
        selectedApp?.detectedDependenciesInstallCommand ?? 'auto · install',
    }),
    textField({
      key: 'androidPrebuildCommand',
      label: 'Android prebuild',
      placeholder:
        selectedApp?.detectedAndroidPrebuildCommand ??
        `skip · ${getPackageExec(config.packageManager)} expo prebuild --platform android`,
    }),
    textField({
      key: 'iosPrebuildCommand',
      label: 'iOS prebuild',
      placeholder:
        selectedApp?.detectedIosPrebuildCommand ??
        `skip · ${getPackageExec(config.packageManager)} expo prebuild --platform ios`,
    }),
    textField({
      key: 'iosBundleId',
      label: 'iOS bundle ID',
      placeholder: selectedApp?.detectedIosBundleId ?? 'auto · com.example.app',
    }),
    textField({
      key: 'androidPackageName',
      label: 'Android package ID',
      placeholder:
        selectedApp?.detectedAndroidPackageName ?? 'auto · com.example.app',
    }),
    textField({
      key: 'androidProjectPath',
      label: 'Android project folder',
      placeholder:
        getDefaultAndroidProjectPath(config) ?? 'auto · apps/mobile/android',
    }),
  ];

  const customAdvancedCount = advancedFields.filter(
    (field) => field.isCustom,
  ).length;
  const hasOverrides = [...primaryFields, ...advancedFields].some(
    (field) => field.isCustom,
  );

  const resetAll = () => {
    setEditingKey(null);
    onChange({
      ...config,
      metroPort: DEFAULT_METRO_PORT,
      metroStartCommand: null,
      androidBuildCommand: null,
      iosBuildCommand: null,
      dependenciesInstallCommand: null,
      androidPrebuildCommand: null,
      iosPrebuildCommand: null,
      iosBundleId: null,
      androidPackageName: null,
      androidProjectPath: null,
    });
  };

  const renderRows = (fields: CommandField[]) => (
    <div className="border-line-soft bg-bg-2 overflow-hidden rounded-lg border">
      {fields.map((field) => (
        <CommandRow
          key={field.key}
          field={field}
          editingKey={editingKey}
          onEdit={setEditingKey}
          onStopEditing={() => setEditingKey(null)}
        />
      ))}
    </div>
  );

  return (
    <div className="border-line bg-bg-1 overflow-hidden rounded-xl border">
      <div className="flex items-start gap-[11px] px-[18px] py-4">
        <div className="bg-acc-soft text-acc-ink ring-acc-line mt-px grid h-7 w-7 shrink-0 place-items-center rounded-[7px] ring-1 ring-inset">
          <Smartphone className="h-[15px] w-[15px]" />
        </div>
        <div className="flex-1">
          <div className="text-ink-0 text-sm font-semibold">Mobile preview</div>
          <p className="text-ink-3 mt-0.5 max-w-100 text-xs leading-[1.45]">
            Run the app on a simulator or device from a session. Detects Expo,
            React Native, iOS and Android projects.
          </p>
        </div>
        <PanelSwitch
          checked={enabled}
          label="Enable mobile preview"
          onChange={(next) =>
            onChange({ ...config, mode: next ? 'auto' : 'disabled' })
          }
        />
      </div>

      <div
        className={clsx(
          'border-line-soft border-t transition-opacity',
          !enabled && 'pointer-events-none opacity-[0.34]',
        )}
      >
        <div className="border-line-soft border-b px-[18px] py-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2.5">
            <h4 className={SECTION_LABEL_CLASS}>Runnable app</h4>
            <span className={clsx(TAG_CLASS, 'text-ink-4 border-line border')}>
              {config.detectedApps.length} detected
            </span>
          </div>

          {config.detectedApps.length === 0 ? (
            <p className="text-ink-4 text-[11.5px] leading-[1.45]">
              No mobile app detected yet. Re-scan to look for Expo, React
              Native, iOS and Android projects.
            </p>
          ) : (
            <div className="grid gap-1.5">
              {config.detectedApps.map((app) => {
                const isSelected = app.path === config.selectedAppPath;

                return (
                  <button
                    key={app.path}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => selectApp(isSelected ? null : app.path)}
                    className={clsx(
                      'flex cursor-pointer items-center gap-2.5 rounded-lg border px-[11px] py-2.5 text-left transition-colors',
                      isSelected
                        ? 'border-acc-line bg-acc/[0.09]'
                        : 'border-line-soft bg-bg-2 hover:bg-bg-3',
                    )}
                  >
                    <span
                      className={clsx(
                        'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border-[1.5px]',
                        isSelected ? 'border-acc' : 'border-ink-4',
                      )}
                    >
                      {isSelected && (
                        <span className="bg-acc h-1.5 w-1.5 rounded-full" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-ink-0 block truncate font-mono text-[12.5px]">
                        {formatMobileAppPath(app)}
                      </span>
                      <span className="text-ink-3 mt-px block truncate text-[11.5px]">
                        {app.reasons.join(', ')}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {ALL_STACKS.map((stack) => (
                        <span
                          key={stack}
                          className={clsx(
                            TAG_CLASS,
                            app.stacks.includes(stack)
                              ? 'bg-status-done-soft text-status-done'
                              : 'bg-bg-3 text-ink-2',
                          )}
                        >
                          {stackLabel(stack)}
                        </span>
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {warning && (
            <div className="text-status-run bg-status-run-soft mt-2 flex items-start gap-[7px] rounded-md px-2.5 py-[7px] text-[11.5px] leading-[1.4]">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </div>
          )}
        </div>

        <div className="px-[18px] py-3.5">
          <div className="mb-2.5 flex h-6 items-center justify-between gap-2.5">
            <h4 className={SECTION_LABEL_CLASS}>Commands</h4>
            {hasOverrides && (
              <button
                type="button"
                onClick={resetAll}
                className="text-ink-3 hover:bg-bg-3 hover:text-ink-1 cursor-pointer rounded-md px-[7px] py-1 text-xs font-medium"
              >
                Reset overrides
              </button>
            )}
          </div>

          {renderRows(primaryFields)}

          <div className="mt-2">
            <button
              type="button"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((value) => !value)}
              className="text-ink-3 hover:text-ink-1 flex w-full cursor-pointer items-center gap-[7px] py-1 text-xs font-medium"
            >
              <ChevronRight
                className={clsx(
                  'h-3 w-3 transition-transform',
                  showAdvanced && 'rotate-90',
                )}
              />
              Advanced
              <span className={clsx(TAG_CLASS, 'text-ink-4 border-line border')}>
                {customAdvancedCount > 0
                  ? `${customAdvancedCount} custom`
                  : `${advancedFields.length} fields`}
              </span>
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-2">
                {renderRows(advancedFields)}
                <p className="text-ink-4 text-[11.5px] leading-[1.45]">
                  Left blank, these are read from the selected app’s native
                  project on each run.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border-line-soft bg-bg-0 flex items-center gap-[9px] border-t py-[9px] pr-3.5 pl-[18px]">
        <span
          className={
            detectedStacks.length > 0 ? 'text-status-done' : 'text-ink-4'
          }
        >
          ●
        </span>
        <span className="text-ink-4 truncate font-mono text-[10.5px] tracking-[0.3px]">
          {detectedStacks.length > 0
            ? `Detected ${detectedStacks.join(', ')}${
                config.selectedAppPath ? ` in ${config.selectedAppPath}` : ''
              }`
            : 'Nothing detected'}
          {' · last scan '}
          {config.detectionUpdatedAt
            ? new Date(config.detectionUpdatedAt).toLocaleString()
            : 'never'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onDetect}
          disabled={isDetecting}
          className="border-line bg-bg-2 text-ink-1 hover:bg-bg-3 hover:text-ink-0 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-60"
        >
          <RefreshCw className={clsx('h-3 w-3', isDetecting && 'animate-spin')} />
          {isDetecting ? 'Scanning…' : 'Re-scan'}
        </button>
      </div>
    </div>
  );
}
