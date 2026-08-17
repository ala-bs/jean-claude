import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  Play,
  Square,
} from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import clsx from 'clsx';

import { Button } from '@/common/ui/button';
import { Select } from '@/common/ui/select';

import type {
  MobilePlatform,
  MobilePreviewIosAppStatus,
} from '@shared/mobile-simulator-types';
import type { MobilePreviewProjectConfig } from '@shared/types';

import { NetworkRequestCountDetail } from '../ui-stream-readouts';
import type { MobilePreviewPaneTab } from '../utils-tabs';
import type { getMobileAppSetupDecision } from '../utils-setup-operation';
import type { getSetupModel, PreviewStepKey } from '../utils-setup-model';
import type { getSetupStepAction } from '../utils-setup-step-actions';

type SetupStepAction = NonNullable<ReturnType<typeof getSetupStepAction>> & {
  onClick: () => void;
};

export function SetupTab({
  model,
  getStepAction,
  platform,
  appOptions,
  appPath,
  appSelectionError,
  androidCertGuidanceVisible,
  detectedApps,
  deviceId,
  effectiveAndroidProjectPath,
  hasActiveSession,
  iosAppStatus,
  iosAppStatusError,
  iosSetupDecision,
  isRestartingAndroidApp,
  isRestartingIosApp,
  isSelectingAppPath,
  needsExpoAndroidPrebuild,
  needsExpoIosPrebuild,
  networkRequestsStore,
  onHideAndroidCertGuidance,
  onRestartAndroidApp,
  onRestartIosApp,
  onRetryIosAppStatus,
  onSelectAppPath,
  onStartWorkspace,
  onStopAll,
  setActiveTab,
  showTunneledNetworkRequests,
  selectedDetectedApp,
  validSelectedAppPath,
}: {
  model: ReturnType<typeof getSetupModel>;
  getStepAction: (stepKey: PreviewStepKey) => SetupStepAction | null;
  platform: MobilePlatform;
  appOptions: ComponentProps<typeof Select>['options'];
  appPath: string;
  appSelectionError: string | null;
  androidCertGuidanceVisible: boolean;
  detectedApps: MobilePreviewProjectConfig['detectedApps'];
  deviceId: string;
  effectiveAndroidProjectPath: string | null;
  hasActiveSession: boolean;
  iosAppStatus: MobilePreviewIosAppStatus | null | undefined;
  iosAppStatusError: string | null;
  iosSetupDecision: ReturnType<typeof getMobileAppSetupDecision>;
  isRestartingAndroidApp: boolean;
  isRestartingIosApp: boolean;
  isSelectingAppPath: boolean;
  needsExpoAndroidPrebuild: boolean;
  needsExpoIosPrebuild: boolean;
  networkRequestsStore: ComponentProps<typeof NetworkRequestCountDetail>['store'];
  onHideAndroidCertGuidance: () => void;
  onRestartAndroidApp: () => void;
  onRestartIosApp: () => void;
  onRetryIosAppStatus: () => void;
  onSelectAppPath?: (appPath: string | null) => void;
  onStartWorkspace: (args: {
    shouldAutoBuildIos: boolean;
    shouldPrebuildAndroid: boolean;
    shouldPrebuildIos: boolean;
  }) => void | Promise<void>;
  onStopAll: () => void | Promise<void>;
  setActiveTab: (tab: MobilePreviewPaneTab) => void;
  showTunneledNetworkRequests: boolean;
  selectedDetectedApp: MobilePreviewProjectConfig['detectedApps'][number] | null;
  validSelectedAppPath: string | null;
}) {
  const {
    setupSteps,
    readySetupSteps,
    anySetupRunning,
    anySetupStopping,
    canStopSetup,
    allSetupReady,
    blockedSetupStep,
    ctaLabel,
    ctaDisabled,
    setupHeadline,
    setupDetail,
  } = model;

  // The setup saga advances at most one long step per press, so Start must stay
  // reachable while things are already running — `canStopSetup` alone is true as
  // soon as Metro is up, and swapping to a lone Stop there would strand the user
  // mid-setup with no way to continue.
  const isStopMode = canStopSetup && allSetupReady;
  const showStopEscape = canStopSetup && !allSetupReady;

  // A newly blocked step expands the details by default so the failure is never
  // hidden, but the user can still collapse it. Derived during render rather
  // than synced by an effect, which would cascade renders.
  const blockedSetupStepKey = blockedSetupStep?.key ?? null;
  const [detailsChoice, setDetailsChoice] = useState<{
    open: boolean;
    forStepKey: string | null;
  }>({ open: false, forStepKey: null });
  const isDetailsOpen =
    detailsChoice.forStepKey === blockedSetupStepKey
      ? detailsChoice.open
      : Boolean(blockedSetupStepKey);

  return (
    <div className="bg-bg-1 min-h-0 flex-1 overflow-y-auto pb-4">
      <div className="border-line-soft border-b p-3.5">
        <div className="flex items-start gap-2.5">
          {blockedSetupStep ? (
            <AlertTriangle className="text-status-fail mt-0.5 size-4 shrink-0" />
          ) : allSetupReady ? (
            <Check className="text-status-done mt-0.5 size-4 shrink-0" />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-ink-0 text-sm font-semibold">{setupHeadline}</div>
            <div className="text-ink-3 mt-0.5 text-[11px] leading-relaxed">
              {setupDetail}
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          {isStopMode ? (
            <Button
              className="min-w-0 flex-1 justify-center"
              variant="danger"
              icon={<Square />}
              disabled={anySetupStopping}
              loading={anySetupStopping}
              onClick={() => void onStopAll()}
            >
              {anySetupStopping ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <>
              <Button
                className="min-w-0 flex-1 justify-center"
                variant="primary"
                icon={
                  anySetupRunning ? <Loader2 className="animate-spin" /> : <Play />
                }
                disabled={ctaDisabled}
                loading={anySetupRunning}
                onClick={() => {
                  if (platform === 'ios' && iosAppStatusError) {
                    onRetryIosAppStatus();
                    return;
                  }
                  void onStartWorkspace({
                    shouldAutoBuildIos: iosSetupDecision.shouldAutoBuild,
                    shouldPrebuildAndroid: needsExpoAndroidPrebuild,
                    shouldPrebuildIos: needsExpoIosPrebuild,
                  });
                }}
              >
                {ctaLabel}
              </Button>
              {showStopEscape ? (
                <Button
                  className="shrink-0 justify-center"
                  variant="secondary"
                  icon={<Square />}
                  aria-label="Stop everything"
                  title="Stop everything"
                  disabled={anySetupStopping}
                  loading={anySetupStopping}
                  onClick={() => void onStopAll()}
                />
              ) : null}
            </>
          )}
        </div>
      </div>

      {detectedApps.length > 1 ? (
        <div className="border-line-soft border-b p-3">
          <div className="text-ink-4 mb-1 text-[9px] font-semibold tracking-wide uppercase">
            Project app
          </div>
          <Select
            value={selectedDetectedApp ? appPath : (validSelectedAppPath ?? '')}
            options={[{ value: '', label: 'Choose app' }, ...appOptions]}
            onChange={(value) => onSelectAppPath?.(value || null)}
            disabled={
              hasActiveSession || !onSelectAppPath || isSelectingAppPath
            }
            size="sm"
            className="w-full justify-between"
          />
          <div className="text-ink-4 mt-1.5 truncate font-mono text-[10px]">
            {selectedDetectedApp
              ? appPath
              : (validSelectedAppPath ?? 'Select app to continue setup')}
          </div>
          {appSelectionError ? (
            <div
              className="text-status-fail mt-1.5 text-[10px]"
              role="alert"
            >
              {appSelectionError}
            </div>
          ) : isSelectingAppPath ? (
            <div className="text-ink-4 mt-1.5 text-[10px]" role="status">
              Updating project app...
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() =>
          setDetailsChoice({ open: !isDetailsOpen, forStepKey: blockedSetupStepKey })
        }
        aria-expanded={isDetailsOpen}
        className="border-line-soft hover:bg-bg-2 flex w-full items-center gap-2.5 border-b px-3 py-2.5 text-left"
      >
        <span aria-hidden className="flex shrink-0 gap-[3px]">
          {setupSteps.map((step, index) => (
            <span
              key={step.key}
              className={clsx(
                'h-[3px] w-3.5 rounded-full transition-colors',
                blockedSetupStep && index >= readySetupSteps
                  ? 'bg-status-fail/40'
                  : index < readySetupSteps
                    ? allSetupReady
                      ? 'bg-status-done'
                      : 'bg-acc'
                    : 'bg-bg-3',
              )}
            />
          ))}
        </span>
        <span className="text-ink-2 min-w-0 flex-1 truncate text-[11.5px]">
          {blockedSetupStep ? blockedSetupStep.label : 'Workspace'}
        </span>
        <span className="text-ink-4 shrink-0 font-mono text-[10px]">
          {readySetupSteps}/{setupSteps.length}
        </span>
        <ChevronDown
          className={clsx(
            'text-ink-4 size-3.5 shrink-0 transition-transform',
            !isDetailsOpen && '-rotate-90',
          )}
        />
      </button>

      <div
        className={clsx(
          'border-line mx-3 mt-3 overflow-hidden rounded-md border bg-zinc-950/45',
          !isDetailsOpen && 'hidden',
        )}
      >
        {setupSteps.map((step) => {
          const action = getStepAction(step.key);
          return (
          <div
            key={step.key}
            onClick={() => step.tab && setActiveTab(step.tab)}
            className={clsx(
              'border-line-soft flex w-full items-center gap-2.5 border-b px-3 py-2 text-left last:border-b-0',
              step.tab ? 'cursor-pointer hover:bg-bg-2' : 'cursor-default',
            )}
          >
            <span
              className={clsx(
                'flex size-5 shrink-0 items-center justify-center rounded-full border',
                step.status === 'ready' && 'border-status-done/30 bg-status-done/10 text-status-done',
                step.status === 'running' && 'border-acc/30 bg-acc-soft text-acc-ink',
                (step.status === 'blocked' || step.status === 'error') &&
                  'border-status-fail/30 bg-status-fail/10 text-status-fail',
                step.status === 'idle' && 'border-zinc-800 text-ink-4',
              )}
            >
              {step.status === 'ready' ? (
                <Check className="size-3" />
              ) : step.status === 'running' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : step.status === 'blocked' || step.status === 'error' ? (
                <AlertTriangle className="size-3" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-ink-1 block text-[12px] font-medium">
                {step.label}
              </span>
              <span
                className={clsx(
                  'block whitespace-normal break-all font-mono text-[10px] leading-4',
                  step.status === 'blocked' || step.status === 'error'
                    ? 'text-status-fail'
                    : 'text-ink-4',
                )}
              >
                {typeof step.detail === 'object' && step.detail !== null ? (
                  <NetworkRequestCountDetail
                    store={networkRequestsStore}
                    showTunneled={showTunneledNetworkRequests}
                  />
                ) : (
                  step.detail
                )}
              </span>
            </span>
            {action ? (
              <Button
                size="xs"
                variant={action.variant}
                disabled={action.disabled}
                loading={action.loading}
                onClick={(event) => {
                  event.stopPropagation();
                  action.onClick();
                }}
                className="min-w-[64px] shrink-0 justify-center"
              >
                {action.label}
              </Button>
            ) : null}
          </div>
          );
        })}
      </div>

      {platform === 'ios' ? (
        <div className="border-line bg-bg-0 mx-3 mt-3 flex items-center justify-between gap-3 rounded-md border p-3">
          <div>
            <div className="text-ink-1 text-xs font-semibold">iOS app</div>
            <div className="text-ink-4 mt-0.5 font-mono text-[10px]">
              {iosAppStatus?.bundleId ?? 'Bundle id unresolved'}
            </div>
          </div>
          <Button
            size="xs"
            variant="secondary"
            disabled={!iosSetupDecision.appReady || isRestartingIosApp}
            loading={isRestartingIosApp}
            onClick={onRestartIosApp}
          >
            Restart app
          </Button>
        </div>
      ) : null}

      {platform === 'android' && androidCertGuidanceVisible ? (
        <div className="border-line bg-bg-0 mx-3 mt-3 rounded-md border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-ink-1 text-xs font-semibold">
                Finish certificate install on Android
              </div>
              <div className="text-ink-4 mt-0.5 text-[10px]">
                Complete these steps on emulator/device.
              </div>
            </div>
            <Button
              size="xs"
              variant="ghost"
              onClick={onHideAndroidCertGuidance}
            >
              Hide
            </Button>
          </div>
          <div className="mt-3">
            <Button
              size="xs"
              variant="secondary"
              disabled={!deviceId || !effectiveAndroidProjectPath || isRestartingAndroidApp}
              loading={isRestartingAndroidApp}
              onClick={onRestartAndroidApp}
            >
              Restart app
            </Button>
          </div>
          <div className="text-ink-3 mt-3 space-y-2 text-[11px] leading-relaxed">
            <div className="flex gap-2">
              <span className="text-ink-4 font-mono">1.</span>
              <span>
                If Android did not open settings, go to <span className="text-ink-1">Settings</span> → <span className="text-ink-1">Security & privacy</span> → <span className="text-ink-1">More security settings</span>.
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-ink-4 font-mono">2.</span>
              <span>
                Open <span className="text-ink-1">Encryption & credentials</span> → <span className="text-ink-1">Install a certificate</span> → <span className="text-ink-1">CA certificate</span>.
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-ink-4 font-mono">3.</span>
              <span>
                Choose <span className="text-ink-1">Jean-Claude CA</span>, accept warning, then relaunch app.
              </span>
            </div>
            <div className="border-line-soft text-ink-4 border-t pt-2 text-[10px]">
              Android app HTTPS also needs <span className="text-ink-2">Trust app</span> + rebuild once so debug builds trust user CAs.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
