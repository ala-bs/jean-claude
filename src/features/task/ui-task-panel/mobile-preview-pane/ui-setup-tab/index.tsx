import { AlertTriangle, Check, Loader2, Play } from 'lucide-react';
import type { ComponentProps } from 'react';
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

  return (
    <div className="bg-bg-1 min-h-0 flex-1 overflow-y-auto pb-4">
      <div className="border-line-soft border-b p-3.5">
        <div className="flex items-center gap-3">
          <div className="relative flex size-12 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-zinc-950">
            <svg className="absolute inset-0 size-12 -rotate-90" viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r="20" fill="none" stroke="var(--color-bg-3)" strokeWidth="4" />
              <circle
                cx="24"
                cy="24"
                r="20"
                fill="none"
                stroke={blockedSetupStep ? 'var(--color-status-fail)' : 'var(--color-acc)'}
                strokeDasharray={Math.PI * 40}
                strokeDashoffset={Math.PI * 40 * (1 - readySetupSteps / setupSteps.length)}
                strokeLinecap="round"
                strokeWidth="4"
              />
            </svg>
            {blockedSetupStep ? (
              <AlertTriangle className="text-status-fail size-4" />
            ) : allSetupReady ? (
              <Check className="text-status-done size-4" />
            ) : (
              <span className="text-ink-0 font-mono text-sm font-semibold">
                {readySetupSteps}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-ink-0 text-sm font-semibold">{setupHeadline}</div>
            <div className="text-ink-3 mt-0.5 text-[11px] leading-relaxed">
              {setupDetail}
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button
            className="min-w-0 flex-1 justify-center"
            variant={allSetupReady ? 'secondary' : 'primary'}
            icon={anySetupRunning ? <Loader2 className="animate-spin" /> : <Play />}
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
          <Button
            className="shrink-0 justify-center"
            variant="secondary"
            disabled={!canStopSetup || anySetupStopping}
            loading={anySetupStopping}
            onClick={() => void onStopAll()}
          >
            Stop all
          </Button>
        </div>
        <div className="text-ink-4 mt-2 flex items-center justify-between text-[10px]">
          <span>{readySetupSteps} of {setupSteps.length} ready</span>
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

      <div className="text-ink-4 px-3 pt-3 pb-1 text-[9px] font-semibold tracking-wide uppercase">
        Workspace
      </div>
      <div className="border-line mx-3 overflow-hidden rounded-md border bg-zinc-950/45">
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
                step.status === 'ready' && 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
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
