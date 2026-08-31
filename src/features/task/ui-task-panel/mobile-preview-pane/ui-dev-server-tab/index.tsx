import type { ComponentProps } from 'react';

import { Button } from '@/common/ui/button';
import type { CommandRunStatus } from '@shared/run-command-types';
import { EmptyState } from '../ui-common';
import { InteractiveLog } from '@/features/common/interactive-log';
import type { MobilePlatform } from '@shared/mobile-simulator-types';

export function DevServerTab({
  platform,
  taskId,
  projectPath,
  consoleCommandId,
  consoleStatus,
  consoleIsPrebuild,
  consoleIsBuild,
  consoleRunning,
  prebuildCommand,
  prebuildCommandId,
  prebuildStatus,
  prebuildStarting,
  buildCommand,
  buildCommandId,
  buildStatus,
  buildStarting,
  buildStopping,
  devServerCommand,
  devServerStarting,
  devServerStopping,
  effectiveDevServerPort,
  needsAppSelection,
  portsInUseError,
  devServerLog,
  setActiveConsoleCommandId,
  handleStartStopPrebuild,
  handleStartStopBuild,
  handleStartStopDevServer,
}: {
  platform: MobilePlatform;
  taskId: string;
  projectPath: string;
  consoleCommandId: string;
  consoleStatus: CommandRunStatus | undefined;
  consoleIsPrebuild: boolean;
  consoleIsBuild: boolean;
  consoleRunning: boolean;
  prebuildCommand: string;
  prebuildCommandId: string;
  prebuildStatus: CommandRunStatus | undefined;
  prebuildStarting: boolean;
  buildCommand: string | null;
  buildCommandId: string;
  buildStatus: CommandRunStatus | undefined;
  buildStarting: boolean;
  buildStopping: boolean;
  devServerCommand: string;
  devServerStarting: boolean;
  devServerStopping: boolean;
  effectiveDevServerPort: number;
  needsAppSelection: boolean;
  portsInUseError: { message: string } | null;
  devServerLog: ComponentProps<typeof InteractiveLog>['log'];
  setActiveConsoleCommandId: (commandId: string | null) => void;
  handleStartStopPrebuild: () => void;
  handleStartStopBuild: () => void;
  handleStartStopDevServer: () => void;
}) {
  return (
    <div className="bg-bg-0 flex h-full min-h-0 flex-col">
      <div className="border-line bg-bg-1 flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-ink-1 text-sm font-medium">
            {consoleIsPrebuild
              ? `${platform === 'android' ? 'Android' : 'iOS'} prebuild`
              : consoleIsBuild
                ? `${platform === 'android' ? 'Android' : 'iOS'} build`
                : 'Dev server'}{' '}
            {consoleStatus?.status ?? 'stopped'}
          </div>
          <div className="text-ink-3 truncate text-xs">
            {consoleStatus?.command ??
              (consoleIsPrebuild
                ? prebuildCommand
                : consoleIsBuild
                ? (buildCommand ?? 'No build command configured')
                : `${devServerCommand} · port ${effectiveDevServerPort}`)}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              size="xs"
              variant="tab"
              active={!consoleIsPrebuild && !consoleIsBuild}
              onClick={() => setActiveConsoleCommandId(null)}
            >
              Metro
            </Button>
            <Button
              size="xs"
              variant="tab"
              active={consoleIsPrebuild}
              onClick={() => setActiveConsoleCommandId(prebuildCommandId)}
            >
              {platform === 'android' ? 'Android' : 'iOS'} prebuild
              {prebuildStatus?.status ? ` · ${prebuildStatus.status}` : ''}
            </Button>
            <Button
              size="xs"
              variant="tab"
              active={consoleIsBuild}
              onClick={() => setActiveConsoleCommandId(buildCommandId)}
            >
              {platform === 'android' ? 'Android' : 'iOS'} build
              {buildStatus?.status ? ` · ${buildStatus.status}` : ''}
            </Button>
          </div>
        </div>
        <Button
          size="sm"
          variant={consoleRunning ? 'secondary' : 'primary'}
          onClick={
            consoleIsPrebuild
              ? handleStartStopPrebuild
              : consoleIsBuild
                ? handleStartStopBuild
                : handleStartStopDevServer
          }
          disabled={
            needsAppSelection ||
            (consoleIsBuild && !buildCommand) ||
            (consoleIsBuild
              ? buildStarting || buildStopping
              : consoleIsPrebuild
                ? prebuildStarting
              : devServerStarting || devServerStopping)
          }
          loading={
            consoleIsBuild
              ? buildStarting || buildStopping
              : consoleIsPrebuild
                ? prebuildStarting
              : devServerStarting || devServerStopping
          }
        >
          {consoleRunning
            ? 'Stop'
            : consoleIsPrebuild
              ? 'Prebuild'
              : consoleIsBuild
                ? 'Build'
                : 'Start dev server'}
        </Button>
      </div>
      {portsInUseError ? (
        <div className="border-status-fail/30 bg-status-fail/10 text-status-fail border-b px-3 py-1.5 text-xs">
          {portsInUseError.message}
        </div>
      ) : null}
      {needsAppSelection ? (
        <EmptyState title="Choose mobile app" detail="Select an app first" />
      ) : (
        <InteractiveLog
          log={devServerLog}
          taskId={taskId}
          runCommandId={consoleCommandId}
          isRunning={consoleRunning}
          workingDir={projectPath}
          emptyText={
            consoleIsPrebuild
              ? `Run prebuild to generate ${platform} folder`
              : consoleIsBuild
                ? 'Run build to stream logs'
                : 'Start dev server to stream logs'
          }
        />
      )}
    </div>
  );
}
