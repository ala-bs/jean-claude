import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  Copy,
  Funnel,
  Keyboard,
  Link,
  Loader2,
  MoreHorizontal,
  MousePointer2,
  PanelRight,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Route,
  Settings,
  Terminal,
  Type,
  X,
} from 'lucide-react';
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  type SVGProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import {
  type ScrcpyMediaStreamPacket,
  ScrcpyVideoCodecId,
} from '@yume-chan/scrcpy';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';

import { Dropdown, DropdownDivider, DropdownItem } from '@/common/ui/dropdown';

import { Button } from '@/common/ui/button';
import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';
import { Select } from '@/common/ui/select';

import { InteractiveLog } from '@/features/common/interactive-log';

import {
  type MobilePreviewH264Chunk,
  useAndroidDeviceManagement,
  useIosDeviceManagement,
  useMobilePreviewDevices,
  useMobilePreviewNativeLogs,
  useMobilePreviewNetworkProxy,
  useMobilePreviewSession,
  useReactNativeDevTools,
} from '@/hooks/use-mobile-preview';

import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useRunCommands } from '@/hooks/use-run-commands';

import {
  useMobilePreviewAutoStartProxy,
  useMobilePreviewDeviceSelection,
  useMobilePreviewFps,
  useMobilePreviewPaneWidth,
  useMobilePreviewQuality,
  useMobilePreviewShowGestures,
} from '@/stores/navigation';

import { useTaskMessagesStore } from '@/stores/task-messages';

import { api } from '@/lib/api';
import { createMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';

import type {
  MobilePlatform,
  MobilePreviewAndroidAppStatus,
  MobilePreviewAndroidDeviceProfile,
  MobilePreviewAndroidSystemImage,
  MobilePreviewDevice,
  MobilePreviewIosAppStatus,
  MobilePreviewIosDeviceType,
  MobilePreviewIosRuntime,
  MobilePreviewNetworkRequest,
  MobilePreviewQuality,
  MobilePreviewStreamStrategy,
  MobilePreviewTextSize,
  MobileRotationDirection,
} from '@shared/mobile-simulator-types';

import type { CommandRunStatus } from '@shared/run-command-types';
import type { MobilePreviewProjectConfig } from '@shared/types';

import {
  applyPreviewDeviceSwitch,
  cancelPendingWorkspaceSetup,
  createIosBuildLaunchCoordinator,
  createPreviewSetupOperationCoordinator,
  getDeferredSetupAction,
  getDependencyInstallDeferredAction,
  getIosAppStatusRequestKey,
  getIosAppStatusRequestState,
  getMobileAppSetupDecision,
  getMobileBuildCommandId,
  shouldStopPreviousIosBuild,
} from './utils-setup-operation';
import {
  canStartPointerInteraction,
  createWheelGestureFeedback,
  getNextGestureFeedbackId,
  getPointerDownInput,
  getPointerMoveInputs,
  getPointerUpInput,
  isPointWithinSurfaceBounds,
  matchesActivePointer,
  restartGestureFeedbackTimer,
} from './utils-input';
import { containsH264Keyframe, createH264AccessUnitParser } from './utils-h264';
import {
  getVisibleMobilePreviewPaneTab,
  isMobilePreviewPaneTabVisible,
  type MobilePreviewPaneTab,
} from './utils-tabs';
import {
  mapRotatedSurfacePoint,
  normalizeRotationDegrees,
} from './utils-rotation';
import {
  notifyH264FrameRendered,
  notifyImageFrameRendered,
  notifyRawRgbaFrameRendered,
} from './utils-frame-readiness';
import { canAutoStartMobilePreviewDevice } from '@/features/mobile-preview/utils-mobile-preview-auto-launch';
import { getDeviceCornerRadiusRatio } from './utils-device-frame';
import { getMobilePreviewStandaloneLayoutClasses } from '@/features/mobile-preview/utils-mobile-preview-standalone-layout';
import { useMobilePreviewAutoStart } from '@/features/mobile-preview/use-mobile-preview-auto-start';
import { useMobilePreviewExpoLaunch } from '@/features/mobile-preview/use-mobile-preview-expo-launch';

const SWIPE_THRESHOLD_PX = 8;
const LONG_PRESS_THRESHOLD_MS = 500;
const WHEEL_SWIPE_DURATION_MS = 180;
const WHEEL_INPUT_THROTTLE_MS = 120;
const WHEEL_SWIPE_MIN_DISTANCE_PX = 40;
const WHEEL_SWIPE_MAX_DISTANCE_PX = 320;
const TOUCH_MOVE_THROTTLE_MS = 16;
const POINTER_EDGE_SLOP_PX = 24;
const FIRST_PREVIEW_FRAME_SETUP_WAIT_MS = 15_000;
const GESTURE_FEEDBACK_FADE_MS = 300;

type GestureFeedback = {
  id: number;
  points: Array<{ x: number; y: number }>;
  released: boolean;
};

export function buildGestureFeedbackPath(
  points: Array<{ x: number; y: number }>,
): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

function GestureFeedbackOverlay({ feedback }: { feedback: GestureFeedback | null }) {
  if (!feedback || feedback.points.length === 0) return null;

  const lastPoint = feedback.points.at(-1)!;
  const path = buildGestureFeedbackPath(feedback.points);

  return (
    <svg className="pointer-events-none absolute inset-0 z-20 size-full overflow-visible">
      {feedback.points.length > 1 ? (
        <motion.path
          d={path}
          fill="none"
          stroke="var(--color-acc)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ opacity: 0.8 }}
          animate={{ opacity: feedback.released ? 0 : 0.8 }}
          transition={{ duration: GESTURE_FEEDBACK_FADE_MS / 1000 }}
          style={{ filter: 'drop-shadow(0 0 3px rgb(0 0 0 / 0.55))' }}
        />
      ) : null}
      <motion.circle
        cx={lastPoint.x}
        cy={lastPoint.y}
        r="7"
        fill="var(--color-acc)"
        stroke="rgb(255 255 255 / 0.9)"
        strokeWidth="2"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{
          opacity: feedback.released ? 0 : 0.95,
          scale: feedback.released ? 1.8 : 1,
        }}
        transition={{ duration: GESTURE_FEEDBACK_FADE_MS / 1000 }}
        style={{ transformOrigin: `${lastPoint.x}px ${lastPoint.y}px` }}
      />
    </svg>
  );
}

function logMobilePreviewDebug(..._args: unknown[]) {}

const NETWORK_FILTER_DEBUG_KEY = 'jc:debug-network-filter';

function logNetworkFilterDebug(
  event: string,
  detail?: Record<string, unknown>,
) {
  try {
    if (window.localStorage.getItem(NETWORK_FILTER_DEBUG_KEY) !== '1') return;
  } catch {
    return;
  }

  console.info('[jc:network-filter]', event, detail ?? {});
}

function IconAppleLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-1.5 0 20 20" aria-hidden="true" fill="currentColor" {...props}>
      <g transform="translate(-102 -7439)">
        <g transform="translate(56 160)">
          <path d="M57.5708873,7282.19296 C58.2999598,7281.34797 58.7914012,7280.17098 58.6569121,7279 C57.6062792,7279.04 56.3352055,7279.67099 55.5818643,7280.51498 C54.905374,7281.26397 54.3148354,7282.46095 54.4735932,7283.60894 C55.6455696,7283.69593 56.8418148,7283.03894 57.5708873,7282.19296 M60.1989864,7289.62485 C60.2283111,7292.65181 62.9696641,7293.65879 63,7293.67179 C62.9777537,7293.74279 62.562152,7295.10677 61.5560117,7296.51675 C60.6853718,7297.73474 59.7823735,7298.94772 58.3596204,7298.97372 C56.9621472,7298.99872 56.5121648,7298.17973 54.9134635,7298.17973 C53.3157735,7298.17973 52.8162425,7298.94772 51.4935978,7298.99872 C50.1203933,7299.04772 49.0738052,7297.68074 48.197098,7296.46676 C46.4032359,7293.98379 45.0330649,7289.44985 46.8734421,7286.3899 C47.7875635,7284.87092 49.4206455,7283.90793 51.1942837,7283.88393 C52.5422083,7283.85893 53.8153044,7284.75292 54.6394294,7284.75292 C55.4635543,7284.75292 57.0106846,7283.67793 58.6366882,7283.83593 C59.3172232,7283.86293 61.2283842,7284.09893 62.4549652,7285.8199 C62.355868,7285.8789 60.1747177,7287.09489 60.1989864,7289.62485" />
        </g>
      </g>
    </svg>
  );
}

function IconAndroidLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="19.933 68.509 228.155 228.155" aria-hidden="true" fill="none" {...props}>
      <path d="M101.885 207.092c7.865 0 14.241 6.376 14.241 14.241v61.09c0 7.865-6.376 14.24-14.241 14.24-7.864 0-14.24-6.375-14.24-14.24v-61.09c0-7.864 6.376-14.24 14.24-14.24z" fill="currentColor" />
      <path d="M69.374 133.645c-.047.54-.088 1.086-.088 1.638v92.557c0 9.954 7.879 17.973 17.66 17.973h94.124c9.782 0 17.661-8.02 17.661-17.973v-92.557c0-.552-.02-1.1-.066-1.638H69.374z" fill="currentColor" />
      <path d="M166.133 207.092c7.865 0 14.241 6.376 14.241 14.241v61.09c0 7.865-6.376 14.24-14.241 14.24-7.864 0-14.24-6.375-14.24-14.24v-61.09c0-7.864 6.376-14.24 14.24-14.24zM46.405 141.882c7.864 0 14.24 6.376 14.24 14.241v61.09c0 7.865-6.376 14.241-14.24 14.241-7.865 0-14.241-6.376-14.241-14.24v-61.09c-.001-7.865 6.375-14.242 14.241-14.242zM221.614 141.882c7.864 0 14.24 6.376 14.24 14.241v61.09c0 7.865-6.376 14.241-14.24 14.241-7.865 0-14.241-6.376-14.241-14.24v-61.09c0-7.865 6.376-14.242 14.241-14.242zM69.79 127.565c.396-28.43 25.21-51.74 57.062-54.812h14.312c31.854 3.073 56.666 26.384 57.062 54.812H69.79z" fill="currentColor" />
      <path d="M74.743 70.009l15.022 26.02M193.276 70.009l-15.023 26.02" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M114.878 102.087c.012 3.974-3.277 7.205-7.347 7.216-4.068.01-7.376-3.202-7.388-7.176v-.04c-.011-3.975 3.278-7.205 7.347-7.216 4.068-.011 7.376 3.2 7.388 7.176v.04zM169.874 102.087c.012 3.974-3.277 7.205-7.347 7.216-4.068.01-7.376-3.202-7.388-7.176v-.04c-.011-3.975 3.278-7.205 7.347-7.216 4.068-.011 7.376 3.2 7.388 7.176v.04z" fill="var(--color-bg-0)" />
    </svg>
  );
}

function PlatformLogo({ platform }: { platform: MobilePlatform }) {
  const label = platform === 'ios' ? 'iOS' : 'Android';
  const Icon = platform === 'ios' ? IconAppleLogo : IconAndroidLogo;

  return (
    <span
      aria-label={label}
      title={label}
      className="text-acc-ink bg-acc-soft inline-flex size-5 items-center justify-center rounded-[3px]"
    >
      <Icon className="size-3.5" />
    </span>
  );
}

const FPS_OPTIONS = [
  { value: '15', label: '15 FPS' },
  { value: '30', label: '30 FPS' },
  { value: '60', label: '60 FPS' },
];

const QUALITY_OPTIONS = [
  { value: 'low', label: '480p · 2 Mbps' },
  { value: 'balanced', label: '720p · 8 Mbps' },
  { value: 'high', label: '1080p · 16 Mbps' },
  { value: 'very-high', label: '1440p · 24 Mbps' },
];
const EMPTY_DETECTED_APPS: MobilePreviewProjectConfig['detectedApps'] = [];

function getDefaultAndroidProjectPath({
  appPath,
  detectedApps,
}: {
  appPath: string;
  detectedApps: MobilePreviewProjectConfig['detectedApps'];
}) {
  const app = detectedApps.find((detectedApp) => detectedApp.path === appPath);
  return app?.androidProjectPath ?? null;
}

function getSuggestedAndroidSystemImageId(hostArch: string | null | undefined) {
  if (hostArch === 'arm64') {
    return 'system-images;android-35;google_apis;arm64-v8a';
  }
  if (hostArch === 'x64' || hostArch === 'ia32') {
    return 'system-images;android-35;google_apis;x86_64';
  }

  const architecture = (
    navigator as Navigator & {
      userAgentData?: { architecture?: string; platform?: string };
    }
  ).userAgentData?.architecture?.toLowerCase();
  const platform = `${navigator.platform} ${architecture ?? ''}`.toLowerCase();
  const abi = platform.includes('mac') || platform.includes('arm') || platform.includes('aarch')
    ? 'arm64-v8a'
    : 'x86_64';
  return `system-images;android-35;google_apis;${abi}`;
}

function getPreferredAndroidSystemImage(
  images: MobilePreviewAndroidSystemImage[] | undefined,
  hostArch: string | null | undefined,
) {
  if (!images?.length) return null;
  const preferredAbi =
    hostArch === 'arm64'
      ? 'arm64-v8a'
      : hostArch === 'x64' || hostArch === 'ia32'
        ? 'x86_64'
        : null;
  return (
    images.find(
      (image) => image.tag === 'google_apis' && image.abi === preferredAbi,
    ) ??
    images.find((image) => image.tag === 'google_apis') ??
    images[0]
  );
}

function formatAndroidScreenSpec(
  screen: MobilePreviewAndroidDeviceProfile['screen'],
) {
  if (!screen) return 'Dimensions unknown';
  const density = screen.densityDpi ? ` @ ${screen.densityDpi} dpi` : '';
  return `${screen.width} x ${screen.height}${density}`;
}

function formatAndroidImageTag(tag: string) {
  return tag.replaceAll('_', ' ');
}

function getSuggestedIosDeviceName({
  deviceType,
  runtime,
}: {
  deviceType: MobilePreviewIosDeviceType | null;
  runtime: MobilePreviewIosRuntime | null;
}) {
  if (!deviceType || !runtime) return '';
  return `${deviceType.name} ${runtime.name}`;
}

function getIosDeviceChrome(deviceType: MobilePreviewIosDeviceType) {
  const name = deviceType.name.toLowerCase();
  const isMax = /max|plus/.test(name);
  const isSe = /\bse\b/.test(name);
  const hasDynamicIsland =
    /iphone\s+(1[5-9]|[2-9]\d)|air/.test(name) ||
    /iphone\s+14\s+pro/.test(name);
  const hasClassicNotch = !isSe && !hasDynamicIsland;
  const height = isMax ? 68 : /pro|air/.test(name) ? 64 : 60;
  const aspect = deviceType.screen
    ? Math.min(deviceType.screen.width, deviceType.screen.height) /
      Math.max(deviceType.screen.width, deviceType.screen.height)
    : isSe
      ? 0.56
      : isMax
        ? 0.47
        : 0.455;

  return {
    aspect,
    height,
    hasClassicNotch,
    hasDynamicIsland,
    hasHomeButton: isSe,
  };
}

function getAndroidImageCompatibilityWarning(
  hostArch: string | null | undefined,
  abi: string | null | undefined,
) {
  if (!hostArch || !abi) return null;
  if (hostArch === 'arm64' && abi === 'x86_64') {
    return 'x86_64 images are slower on Apple Silicon.';
  }
  if ((hostArch === 'x64' || hostArch === 'ia32') && abi === 'arm64-v8a') {
    return 'arm64 images may not run on Intel hosts.';
  }
  return null;
}

function parseOptionalPositiveInteger(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function isOptionalPositiveInteger(value: string) {
  const parsed = parseOptionalPositiveInteger(value);
  return parsed === undefined || !Number.isNaN(parsed);
}

function getOptionalPositiveInteger(value: string) {
  const parsed = parseOptionalPositiveInteger(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parsePort(value: string) {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : null;
}

const TEXT_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'x-large', label: 'XL' },
];

type MobilePreviewAction = 'deeplink' | 'port' | 'text-size';

type ImagePreviewStats = {
  receivedFps: number;
};

function formatError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function cleanPreviewError(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}

function getStreamStrategyLabel(
  strategy: MobilePreviewStreamStrategy | null | undefined,
) {
  switch (strategy) {
    case 'coresimulator-framebuffer':
      return 'CoreSimulator framebuffer';
    case 'idb-h264-stream':
      return 'idb H264 stream';
    case 'idb-rbga-stream':
      return 'idb raw RGBA stream';
    case 'idb-video-stream':
      return 'idb video stream';
    case 'simctl-screenshot':
      return 'simctl screenshots';
    case 'adb-screenrecord':
      return 'adb screenrecord';
    case 'adb-screenshot':
      return 'adb screenshots';
    case 'scrcpy':
      return 'scrcpy';
    default:
      return null;
  }
}

function getWaitingForFrameDetail(
  strategy: MobilePreviewStreamStrategy | null | undefined,
) {
  switch (strategy) {
    case 'coresimulator-framebuffer':
      return 'Preview stream is running; waiting for CoreSimulator frames';
    case 'simctl-screenshot':
      return 'Preview stream is running; waiting for simulator screenshots';
    case 'idb-rbga-stream':
    case 'idb-h264-stream':
    case 'idb-video-stream':
      return 'Preview stream is running; waiting for idb frames';
    case 'adb-screenshot':
      return 'Preview stream is running; waiting for Android screenshots';
    case 'adb-screenrecord':
      return 'Preview stream is running; waiting for Android screenrecord frames';
    case 'scrcpy':
      return 'Preview stream is running; waiting for scrcpy frames';
    default:
      return 'Preview stream is running; waiting for frames';
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// A <canvas> reports 300x150 until a frame sets its intrinsic size. That default
// is landscape and would wrongly flip a portrait session, so treat it as unknown.
const DEFAULT_CANVAS_WIDTH = 300;
const DEFAULT_CANVAS_HEIGHT = 150;

function getSurfaceIntrinsicSize(
  surface: HTMLImageElement | HTMLCanvasElement | null,
): { width: number; height: number } | null {
  if (!surface) return null;
  if (surface instanceof HTMLImageElement) {
    if (!surface.naturalWidth || !surface.naturalHeight) return null;
    return { width: surface.naturalWidth, height: surface.naturalHeight };
  }
  if (!surface.width || !surface.height) return null;
  if (
    surface.width === DEFAULT_CANVAS_WIDTH &&
    surface.height === DEFAULT_CANVAS_HEIGHT
  ) {
    return null;
  }
  return { width: surface.width, height: surface.height };
}

/**
 * Device coordinate space for input events. Session dimensions are captured once
 * at stream start, so when the device rotates afterwards they must be re-oriented
 * to match what is actually rendered.
 */
function resolveDeviceSize({
  surface,
  sessionWidth,
  sessionHeight,
  fallback,
}: {
  surface: { width: number; height: number } | null;
  sessionWidth: number | null;
  sessionHeight: number | null;
  fallback: { width: number; height: number };
}) {
  if (!sessionWidth || !sessionHeight) {
    return surface ?? fallback;
  }
  if (!surface || surface.width === surface.height) {
    return { width: sessionWidth, height: sessionHeight };
  }
  const sameOrientation =
    surface.width > surface.height === sessionWidth > sessionHeight;
  return sameOrientation
    ? { width: sessionWidth, height: sessionHeight }
    : { width: sessionHeight, height: sessionWidth };
}

function formatDeviceState(state: MobilePreviewDevice['state']) {
  if (state === 'booted') return 'Booted';
  if (state === 'shutdown') return 'Shutdown';
  return 'Unknown';
}

function formatNetworkClient(request: {
  clientAddress: string | null;
  clientPort: number | null;
}) {
  if (!request.clientAddress) return '-';
  if (request.clientPort === null) return request.clientAddress;
  return `${request.clientAddress}:${request.clientPort}`;
}

type NetworkFilterKey = 'text' | 'method' | 'status' | 'path' | 'host';

type NetworkFilterToken = {
  key: NetworkFilterKey;
  value: string;
  neg: boolean;
  exact?: boolean;
};

type NetworkFilterSuggestion =
  | {
      kind: 'key';
      key: Exclude<NetworkFilterKey, 'text'>;
      label: string;
      hint: string;
      neg: boolean;
    }
  | {
      kind: 'value';
      label: string;
      count: number;
      token: NetworkFilterToken;
    };

const NETWORK_FILTER_FIELDS = [
  { key: 'method', hint: 'HTTP method' },
  { key: 'status', hint: 'response code' },
  { key: 'path', hint: 'URL path' },
  { key: 'host', hint: 'captured domain' },
] as const satisfies ReadonlyArray<{
  key: Exclude<NetworkFilterKey, 'text'>;
  hint: string;
}>;

function parseNetworkFilterToken(rawValue: string): NetworkFilterToken {
  let value = rawValue.trim();
  let neg = false;
  if (value.startsWith('-') || value.startsWith('!')) {
    neg = true;
    value = value.slice(1).trim();
  }

  const colonIndex = value.indexOf(':');
  if (colonIndex > 0) {
    const key = value.slice(0, colonIndex).toLowerCase() as NetworkFilterKey;
    const tokenValue = value.slice(colonIndex + 1).trim();
    if (
      tokenValue &&
      NETWORK_FILTER_FIELDS.some((field) => field.key === key)
    ) {
      return { key, value: tokenValue, neg };
    }
  }

  return { key: 'text', value, neg };
}

function matchesNetworkFilterToken(
  request: MobilePreviewNetworkRequest,
  token: NetworkFilterToken,
) {
  const normalizedValue = token.value.trim().toLowerCase();
  if (!normalizedValue) return true;

  const rawMatch = (() => {
    if (token.key === 'method') {
      return request.method.toLowerCase() === normalizedValue;
    }
    if (token.key === 'status') {
      if (/^\dxx$/.test(normalizedValue)) {
        return request.status !== null
          ? Math.floor(request.status / 100) === Number(normalizedValue[0])
          : request.tunnelOnly && normalizedValue === '2xx';
      }
      return getNetworkStatusLabel(request).toString().toLowerCase() === normalizedValue;
    }
    if (token.key === 'path') {
      const path = getNetworkPath(request.url).toLowerCase();
      return token.exact ? path === normalizedValue : path.includes(normalizedValue);
    }
    if (token.key === 'host') {
      const host = getNetworkHostname(request.url).toLowerCase();
      return token.exact ? host === normalizedValue : host.includes(normalizedValue);
    }
    return [
      request.method,
      request.url,
      getNetworkStatusLabel(request).toString(),
      request.error ?? '',
      formatNetworkClient(request),
    ].some((value) => value.toLowerCase().includes(normalizedValue));
  })();

  return token.neg ? !rawMatch : rawMatch;
}

function matchesNetworkFilter(
  request: MobilePreviewNetworkRequest,
  filter: NetworkFilterToken[],
) {
  return filter.every((token) => matchesNetworkFilterToken(request, token));
}

function formatNetworkHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return '-';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

function formatNetworkPreview(value: string | null) {
  if (!value) return '-';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function quoteCurlArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCurlCommand(request: MobilePreviewNetworkRequest) {
  const lines = [
    'curl',
    `  -X ${quoteCurlArg(request.method)}`,
    `  ${quoteCurlArg(request.url)}`,
  ];

  Object.entries(request.requestHeaders).forEach(([key, value]) => {
    lines.splice(-1, 0, `  -H ${quoteCurlArg(`${key}: ${value}`)}`);
  });

  if (request.requestBodyPreview) {
    lines.splice(
      -1,
      0,
      `  --data-raw ${quoteCurlArg(request.requestBodyPreview)}`,
    );
  }

  return lines.join(' \\\n');
}

function getNetworkStatusClass(request: {
  error: string | null;
  status: number | null;
  tunnelOnly: boolean;
}) {
  if (request.error || (request.status !== null && request.status >= 400)) {
    return 'text-status-fail';
  }
  if (request.status !== null && request.status >= 300) {
    return 'text-amber-300';
  }
  if (request.tunnelOnly) return 'text-sky-300';
  return 'text-emerald-300';
}

function getHeaderValue(headers: Record<string, string>, name: string) {
  const targetName = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === targetName,
  );
  return entry?.[1] ?? null;
}

function getNetworkStatusLabel(request: {
  status: number | null;
  tunnelOnly: boolean;
}) {
  if (request.tunnelOnly) return 'Tunnel';
  return request.status ?? '...';
}

function getNetworkMethodClass(method: string) {
  switch (method.toUpperCase()) {
    case 'POST':
      return 'text-amber-300';
    case 'PUT':
    case 'PATCH':
      return 'text-violet-300';
    case 'DELETE':
      return 'text-status-fail';
    default:
      return 'text-sky-300';
  }
}

function getNetworkHostname(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return '-';
  }
}

function getNetworkPath(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function getNetworkFilterFieldValues(
  requests: MobilePreviewNetworkRequest[],
  key: Exclude<NetworkFilterKey, 'text'>,
) {
  const values = requests.flatMap((request) => {
    if (key === 'method') return [request.method.toUpperCase()];
    if (key === 'status') {
      return request.status === null
        ? [getNetworkStatusLabel(request).toString()]
        : [`${Math.floor(request.status / 100)}xx`, request.status.toString()];
    }
    if (key === 'path') return [getNetworkPath(request.url)];
    return [getNetworkHostname(request.url)];
  });

  return [...new Set(values.filter(Boolean))].sort((first, second) =>
    first.localeCompare(second, undefined, { numeric: true }),
  );
}

function buildNetworkFilterSuggestions({
  draft,
  requests,
}: {
  draft: string;
  requests: MobilePreviewNetworkRequest[];
}): NetworkFilterSuggestion[] {
  let value = draft.trim();
  let neg = false;
  if (value.startsWith('-') || value.startsWith('!')) {
    neg = true;
    value = value.slice(1).trim();
  }

  const colonIndex = value.indexOf(':');
  if (colonIndex > 0) {
    const key = value.slice(0, colonIndex).toLowerCase() as NetworkFilterKey;
    const field = NETWORK_FILTER_FIELDS.find((item) => item.key === key);
    if (field) {
      const filterValue = value.slice(colonIndex + 1).trim().toLowerCase();
      return getNetworkFilterFieldValues(requests, field.key)
        .filter((item) => item.toLowerCase().includes(filterValue))
        .slice(0, 8)
        .map((item) => {
          const token = {
            key: field.key,
            value: item,
            neg,
            exact: field.key === 'host' || field.key === 'path' || undefined,
          };
          return {
            kind: 'value',
            label: `${field.key}:${item}`,
            count: requests.filter((request) =>
              matchesNetworkFilterToken(request, { ...token, neg: false }),
            ).length,
            token,
          };
        });
    }
  }

  const suggestions: NetworkFilterSuggestion[] = [];
  if (value) {
    const token = { key: 'text' as const, value, neg };
    suggestions.push({
      kind: 'value',
      label: value,
      count: requests.filter((request) =>
        matchesNetworkFilterToken(request, { ...token, neg: false }),
      ).length,
      token,
    });
  }

  NETWORK_FILTER_FIELDS.filter(
    (field) => !value || field.key.startsWith(value.toLowerCase()),
  ).forEach((field) => {
    suggestions.push({
      kind: 'key',
      key: field.key,
      label: `${field.key}:`,
      hint: field.hint,
      neg,
    });
  });

  return suggestions;
}

function appendNetworkFilterToken(
  currentTokens: NetworkFilterToken[],
  token: NetworkFilterToken,
) {
  const alreadyExists = currentTokens.some(
    (currentToken) =>
      currentToken.key === token.key &&
      currentToken.value === token.value &&
      currentToken.neg === token.neg &&
      !!currentToken.exact === !!token.exact,
  );
  return alreadyExists ? currentTokens : [...currentTokens, token];
}

function getNetworkTransferredBytes(request: MobilePreviewNetworkRequest) {
  const length =
    getHeaderValue(request.responseHeaders, 'content-length') ??
    getHeaderValue(request.requestHeaders, 'content-length');
  const parsedLength = length ? Number.parseInt(length, 10) : Number.NaN;
  if (Number.isFinite(parsedLength)) return parsedLength;
  return (
    (request.requestBodyPreview?.length ?? 0) +
    (request.responseBodyPreview?.length ?? 0)
  );
}

function getNetworkStats(requests: MobilePreviewNetworkRequest[]) {
  const failed = requests.filter(
    (request) =>
      request.error || (request.status !== null && request.status >= 400),
  ).length;
  const ok = requests.filter(
    (request) =>
      !request.error &&
      !request.tunnelOnly &&
      request.status !== null &&
      request.status >= 200 &&
      request.status < 400,
  ).length;
  const durations = requests
    .map((request) => request.durationMs)
    .filter((duration): duration is number => duration !== null);
  const avgDuration =
    durations.length === 0
      ? null
      : Math.round(
          durations.reduce((sum, duration) => sum + duration, 0) /
            durations.length,
        );
  const bytes = requests.reduce(
    (sum, request) => sum + getNetworkTransferredBytes(request),
    0,
  );
  return { total: requests.length, failed, ok, avgDuration, bytes };
}

function getNetworkFacets(requests: MobilePreviewNetworkRequest[]) {
  const byPath = new Map<string, MobilePreviewNetworkRequest[]>();
  requests.forEach((request) => {
    const path = getNetworkPath(request.url);
    byPath.set(path, [...(byPath.get(path) ?? []), request]);
  });
  return [...byPath.entries()]
    .map(([path, facetRequests]) => ({
      path,
      count: facetRequests.length,
      failed: facetRequests.some(
        (request) =>
          request.error || (request.status !== null && request.status >= 400),
      ),
    }))
    .sort((firstFacet, secondFacet) => secondFacet.count - firstFacet.count);
}

function NetworkFacetButton({
  label,
  count,
  active,
  failed,
  onClick,
  onContextMenu,
  contextPath,
}: {
  label: string;
  count: number;
  active: boolean;
  failed?: boolean;
  onClick: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  contextPath?: string;
}) {
  return (
    <button
      type="button"
      data-network-filter-context={contextPath ? 'endpoint' : undefined}
      data-network-filter-path={contextPath}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseDown={(event) => {
        if (event.button === 2) onContextMenu?.(event);
      }}
      className={clsx(
        'flex h-[26px] w-full items-center gap-2 rounded-[3px] px-2 text-left transition-colors',
        active ? 'bg-zinc-800/70 text-ink-1' : 'text-ink-2 hover:bg-zinc-900/80',
      )}
    >
      <span
        className={clsx(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          failed ? 'bg-status-fail' : 'bg-emerald-300',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      <span className="text-ink-4 font-mono text-[10px]">{count}</span>
    </button>
  );
}

type NetworkPresetFilter = 'all' | 'errors' | 'post' | 'get';
type NetworkDetailTab = 'all' | 'headers' | 'body' | 'request' | 'timing';
type NetworkFilterContextMenuState = {
  x: number;
  y: number;
  title: string;
  subtitle: string;
  items: Array<{
    key: Exclude<NetworkFilterKey, 'text'>;
    value: string;
  }>;
};

function matchesNetworkPreset(
  request: MobilePreviewNetworkRequest,
  preset: NetworkPresetFilter,
) {
  if (preset === 'errors') {
    return request.error || (request.status !== null && request.status >= 400);
  }
  if (preset === 'post') return request.method.toUpperCase() === 'POST';
  if (preset === 'get') return request.method.toUpperCase() === 'GET';
  return true;
}

function NetworkFilterChip({
  label,
  count,
  active,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: 'neutral' | 'danger' | 'success';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[3px] border px-1.5 text-[10px] font-medium transition-colors',
        active
          ? 'border-zinc-800 bg-zinc-800/70 text-ink-1'
          : 'border-transparent text-ink-2 hover:bg-zinc-900/80',
      )}
    >
      {tone !== 'neutral' ? (
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            tone === 'danger' ? 'bg-status-fail' : 'bg-emerald-300',
          )}
        />
      ) : null}
      {label}
      <span className="text-ink-4 font-mono text-[10px]">{count}</span>
    </button>
  );
}

function NetworkFilterAutocomplete({
  tokens,
  onChange,
  requests,
  resultCount,
}: {
  tokens: NetworkFilterToken[];
  onChange: (tokens: NetworkFilterToken[]) => void;
  requests: MobilePreviewNetworkRequest[];
  resultCount: number;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestions = useMemo(
    () => buildNetworkFilterSuggestions({ draft, requests }),
    [draft, requests],
  );
  const isValueSuggestion = draft.replace(/^[-!]/, '').includes(':');

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const focusInput = () => inputRef.current?.focus();
  const addToken = (token: NetworkFilterToken) => {
    if (!token.value.trim()) return;
    logNetworkFilterDebug('autocomplete-add-token', { token });
    onChange([...tokens, token]);
    setDraft('');
    setHighlightedIndex(0);
    setOpen(true);
    requestAnimationFrame(focusInput);
  };
  const removeToken = (index: number) =>
    onChange(tokens.filter((_, tokenIndex) => tokenIndex !== index));
  const toggleToken = (index: number) =>
    onChange(
      tokens.map((token, tokenIndex) =>
        tokenIndex === index ? { ...token, neg: !token.neg } : token,
      ),
    );
  const applySuggestion = (suggestion: NetworkFilterSuggestion) => {
    if (suggestion.kind === 'key') {
      setDraft(`${suggestion.neg ? '-' : ''}${suggestion.key}:`);
      setHighlightedIndex(0);
      setOpen(true);
      requestAnimationFrame(focusInput);
      return;
    }
    addToken(suggestion.token);
  };
  const excludeSuggestion = (suggestion: NetworkFilterSuggestion) => {
    if (suggestion.kind !== 'value') return;
    addToken({ ...suggestion.token, neg: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const suggestion = suggestions[highlightedIndex];
      if (suggestion) applySuggestion(suggestion);
      else addToken(parseNetworkFilterToken(draft));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex((index) =>
        Math.min(index + 1, Math.max(0, suggestions.length - 1)),
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Backspace' && !draft && tokens.length > 0) {
      removeToken(tokens.length - 1);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative min-w-[260px] flex-1">
      <div
        role="button"
        tabIndex={-1}
        onClick={() => {
          focusInput();
          setOpen(true);
        }}
        className={clsx(
          'flex min-h-7 cursor-text items-center gap-1.5 rounded-[3px] border bg-zinc-950 px-2 transition-shadow',
          open
            ? 'border-acc shadow-[0_0_0_2px_color-mix(in_oklch,var(--color-acc)_24%,transparent)]'
            : 'border-zinc-800',
        )}
      >
        <Funnel
          className={clsx(
            'h-3.5 w-3.5 shrink-0',
            open ? 'text-acc' : 'text-ink-4',
          )}
        />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {tokens.map((token, index) => (
            <span
              key={`${token.key}:${token.value}:${token.exact ? 'exact' : 'partial'}:${index}`}
              className={clsx(
                'inline-flex h-5 shrink-0 items-center gap-1 rounded-[3px] border px-1.5 font-mono text-[10px]',
                token.neg
                  ? 'border-status-fail/40 bg-status-fail/10 text-ink-2'
                  : 'border-zinc-800 bg-zinc-900/80 text-ink-1',
              )}
            >
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleToken(index);
                }}
                title={token.neg ? 'Click to include' : 'Click to exclude'}
                className="inline-flex min-w-0 items-center gap-1"
              >
                {token.neg ? <Ban className="text-status-fail h-2.5 w-2.5" /> : null}
                {token.key !== 'text' ? (
                  <span className="text-ink-4">{token.key}:</span>
                ) : null}
                <span className={clsx('max-w-32 truncate', token.neg && 'line-through')}>
                  {token.value}
                </span>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  removeToken(index);
                }}
                className="text-ink-4 hover:text-ink-1 rounded-[2px] p-0.5"
                title="Remove filter"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setHighlightedIndex(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={tokens.length > 0 ? '' : 'Filter status:4xx, method:POST, -host:api'}
            className="text-ink-1 h-5 min-w-28 flex-1 border-0 bg-transparent font-mono text-[11px] outline-none placeholder:text-ink-4"
          />
        </div>
        {tokens.length > 0 || draft ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onChange([]);
              setDraft('');
              focusInput();
            }}
            className="text-ink-4 hover:text-ink-1 rounded-[3px] p-0.5"
            title="Clear filter"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {open && suggestions.length > 0 ? (
        <div className="absolute top-[calc(100%+4px)] right-0 left-0 z-40 max-h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-1 shadow-2xl">
          <div className="text-ink-4 px-2 py-1 text-[9px] font-semibold tracking-wide uppercase">
            {isValueSuggestion ? 'Values' : 'Filter by field'}
          </div>
          {suggestions.map((suggestion, index) => {
            const active = highlightedIndex === index;
            const isNegated =
              suggestion.kind === 'value' ? suggestion.token.neg : suggestion.neg;
            return (
              <button
                key={`${suggestion.kind}:${suggestion.label}:${index}`}
                type="button"
                onMouseEnter={() => setHighlightedIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySuggestion(suggestion);
                }}
                className={clsx(
                  'flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left transition-colors',
                  active ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/60',
                )}
              >
                {suggestion.kind === 'key' ? (
                  <ChevronRight className="text-ink-4 h-3 w-3 shrink-0" />
                ) : isNegated ? (
                  <Ban className="text-status-fail h-3 w-3 shrink-0" />
                ) : (
                  <Plus className="text-ink-4 h-3 w-3 shrink-0" />
                )}
                <span
                  className={clsx(
                    'text-ink-1 min-w-0 truncate font-mono text-[11px]',
                    isNegated && 'line-through',
                  )}
                >
                  {suggestion.label}
                </span>
                <span className="min-w-0 flex-1" />
                {suggestion.kind === 'key' ? (
                  <span className="text-ink-4 text-[10px]">{suggestion.hint}</span>
                ) : (
                  <>
                    {active && !isNegated ? (
                      <span
                        role="button"
                        tabIndex={-1}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          excludeSuggestion(suggestion);
                        }}
                        className="text-status-fail border-status-fail/30 bg-status-fail/10 inline-flex h-5 items-center gap-1 rounded-[3px] border px-1.5 text-[10px]"
                      >
                        <Ban className="h-2.5 w-2.5" />
                        Exclude
                      </span>
                    ) : null}
                    <span className="text-ink-4 min-w-5 text-right font-mono text-[10px]">
                      {suggestion.count}
                    </span>
                  </>
                )}
              </button>
            );
          })}
          <div className="text-ink-4 mt-1 flex items-center gap-2 border-t border-zinc-800 px-2 py-1.5 text-[10px]">
            <span className="font-mono">Enter add</span>
            <span className="font-mono">- exclude</span>
            <span className="font-mono">Backspace remove</span>
            <span className="min-w-0 flex-1" />
            <span className="font-mono">
              {resultCount} match{resultCount === 1 ? '' : 'es'}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NetworkFilterContextMenu({
  state,
  onAddFilter,
  onClose,
}: {
  state: NetworkFilterContextMenuState;
  onAddFilter: (token: NetworkFilterToken) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const left = Math.max(0, Math.min(state.x, window.innerWidth - 260));
  const top = Math.max(0, Math.min(state.y, window.innerHeight - 244));

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const addFilter = (key: Exclude<NetworkFilterKey, 'text'>, value: string, neg: boolean) => {
    const token = {
      key,
      value,
      neg,
      exact: key === 'host' || key === 'path' || undefined,
    };
    logNetworkFilterDebug('context-menu-add-token', { token });
    onAddFilter(token);
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 w-64 overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 shadow-2xl"
      style={{ left, top }}
      role="menu"
    >
      <div className="border-b border-zinc-800 px-3 py-2">
        <div className="text-ink-4 text-[9px] font-semibold tracking-wide uppercase">
          {state.title}
        </div>
        <div className="text-ink-2 mt-1 truncate font-mono text-[10px]">
          {state.subtitle}
        </div>
      </div>
      <div className="p-1">
        {state.items.map((item) => (
          <button
            key={`${item.key}:${item.value}`}
            type="button"
            role="menuitem"
            onClick={() => addFilter(item.key, item.value, false)}
            className="hover:bg-zinc-800/80 flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left"
          >
            <Plus className="text-ink-4 h-3 w-3 shrink-0" />
            <span className="text-ink-4 w-12 shrink-0 text-[10px]">{item.key}</span>
            <span className="text-ink-1 min-w-0 truncate font-mono text-[11px]">
              {item.value}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t border-zinc-800 p-1">
        {state.items.map((item) => (
          <button
            key={`exclude:${item.key}:${item.value}`}
            type="button"
            role="menuitem"
            onClick={() => addFilter(item.key, item.value, true)}
            className="hover:bg-zinc-800/80 flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left"
          >
            <Ban className="text-status-fail h-3 w-3 shrink-0" />
            <span className="text-status-fail w-12 shrink-0 text-[10px]">
              not {item.key}
            </span>
            <span className="text-ink-2 min-w-0 truncate font-mono text-[11px] line-through">
              {item.value}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function NetworkDetailSection({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return (
    <section className="grid gap-1">
      <div className="text-ink-3 text-[10px] font-semibold tracking-wide uppercase">
        {title}
      </div>
      <pre className="text-ink-1 max-h-52 overflow-auto rounded-[3px] border border-zinc-900/90 bg-black/35 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {children}
      </pre>
    </section>
  );
}

function NetworkRequestDetails({
  request,
  onClose,
}: {
  request: MobilePreviewNetworkRequest;
  onClose: () => void;
}) {
  const [detailWidth, setDetailWidth] = useState(392);
  const [activeDetailTab, setActiveDetailTab] =
    useState<NetworkDetailTab>('all');
  const [copiedCurl, setCopiedCurl] = useState(false);
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: detailWidth,
    minWidth: 320,
    maxWidth: 760,
    maxWidthFraction: 0.75,
    direction: 'left',
    onWidthChange: setDetailWidth,
  });
  const requestCookies = getHeaderValue(request.requestHeaders, 'cookie');
  const responseCookies = getHeaderValue(
    request.responseHeaders,
    'set-cookie',
  );

  useEffect(() => {
    queueMicrotask(() => setCopiedCurl(false));
  }, [request.id]);

  const handleCopyCurl = useCallback(async () => {
    await navigator.clipboard.writeText(formatCurlCommand(request));
    setCopiedCurl(true);
    window.setTimeout(() => setCopiedCurl(false), 1400);
  }, [request]);

  const tlsDuration = request.decrypted ? 18 : 0;
  const waitingDuration = Math.max(
    1,
    Math.round((request.durationMs ?? 0) * 0.62),
  );
  const downloadDuration = Math.max(
    1,
    Math.round((request.durationMs ?? 0) * 0.18),
  );
  const timingSections: Array<[string, number, string]> = request.decrypted
    ? [
        ['DNS', 4, 'bg-ink-4'],
        ['Connect', 12, 'bg-sky-300'],
        ['TLS', tlsDuration, 'bg-cyan-300'],
        ['Waiting (TTFB)', waitingDuration, 'bg-amber-400'],
        ['Download', downloadDuration, 'bg-emerald-300'],
      ]
    : [
        ['DNS', 4, 'bg-ink-4'],
        ['Connect', 12, 'bg-sky-300'],
        ['Waiting (TTFB)', waitingDuration, 'bg-amber-400'],
        ['Download', downloadDuration, 'bg-emerald-300'],
      ];
  const rawTimingTotal =
    4 + 12 + tlsDuration + waitingDuration + downloadDuration;
  const timingTotal = rawTimingTotal > 1 ? rawTimingTotal : 1;
  const tabs: Array<{ value: NetworkDetailTab; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'headers', label: 'Headers' },
    { value: 'body', label: 'Body' },
    { value: 'request', label: 'Request' },
    { value: 'timing', label: 'Timing' },
  ];

  return (
    <aside
      style={{ width: detailWidth }}
      className="relative flex min-w-[320px] max-w-[75%] flex-col border-l border-zinc-900/90 bg-zinc-950/80"
    >
      <div
        onMouseDown={handleMouseDown}
        className={clsx(
          'hover:bg-acc/50 absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors',
          isDragging && 'bg-acc/50',
        )}
      />
      <div className="flex items-start justify-between gap-3 border-b border-zinc-900/90 px-3 py-1.5">
        <div className="min-w-0">
          <div className="text-ink-1 flex items-center gap-2 text-[13px] font-medium">
            <span className="font-mono">{request.method}</span>
            <span className={clsx('font-mono', getNetworkStatusClass(request))}>
              {request.status ?? '-'}
            </span>
          </div>
          <div className="text-ink-3 truncate font-mono text-[11px]">
            {request.url}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            size="sm"
            variant="ghost"
            icon={copiedCurl ? <Check /> : <Copy />}
            tooltip={copiedCurl ? 'Copied curl' : 'Copy as curl'}
            onClick={handleCopyCurl}
          />
          <IconButton
            size="sm"
            variant="ghost"
            icon={<X />}
            tooltip="Close"
            onClick={onClose}
          />
        </div>
      </div>
      <div className="flex shrink-0 gap-1 border-b border-zinc-900/90 px-2 py-1">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setActiveDetailTab(tab.value)}
            className={clsx(
              'h-5 rounded-[3px] px-2 text-[10px] font-medium transition-colors',
              activeDetailTab === tab.value
                ? 'bg-zinc-800/70 text-ink-1'
                : 'text-ink-3 hover:bg-zinc-900/80 hover:text-ink-1',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {request.error ? (
          <div className="border-status-fail/40 bg-status-fail/10 text-status-fail mb-3 rounded border px-2 py-1.5 text-xs">
            {request.error}
          </div>
        ) : null}
        <div className="grid gap-2.5">
          {(activeDetailTab === 'all' || activeDetailTab === 'timing') ? (
            <section className="grid gap-1.5">
              <div className="text-ink-3 text-[10px] font-semibold tracking-wide uppercase">
                Timing · {request.durationMs === null ? '-' : `${request.durationMs}ms`}
              </div>
              <div className="grid gap-1.5">
                {timingSections.map(([label, duration, colorClass]) => (
                  <div key={label} className="grid grid-cols-[88px_1fr_40px] items-center gap-2">
                    <span className="text-ink-3 text-[11px]">{label}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-zinc-900">
                      <span
                        className={clsx('block h-full rounded-full', colorClass)}
                        style={{ width: `${(duration / timingTotal) * 100}%` }}
                      />
                    </span>
                    <span className="text-ink-3 text-right font-mono text-[10px]">
                      {duration}ms
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {(activeDetailTab === 'all' || activeDetailTab === 'headers') ? (
            <>
              <NetworkDetailSection title="Response headers">
                {formatNetworkHeaders(request.responseHeaders)}
              </NetworkDetailSection>
              <NetworkDetailSection title="Response cookies">
                {responseCookies ?? '-'}
              </NetworkDetailSection>
            </>
          ) : null}
          {(activeDetailTab === 'all' || activeDetailTab === 'request') ? (
            <>
              <NetworkDetailSection title="Request headers">
                {formatNetworkHeaders(request.requestHeaders)}
              </NetworkDetailSection>
              <NetworkDetailSection title="Request cookies">
                {requestCookies ?? '-'}
              </NetworkDetailSection>
              <NetworkDetailSection title="Request body">
                {formatNetworkPreview(request.requestBodyPreview)}
              </NetworkDetailSection>
            </>
          ) : null}
          {(activeDetailTab === 'all' || activeDetailTab === 'body') ? (
            <NetworkDetailSection title="Response body">
              {formatNetworkPreview(request.responseBodyPreview)}
            </NetworkDetailSection>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function canStartDevice(device: MobilePreviewDevice | undefined) {
  return canAutoStartMobilePreviewDevice(device);
}

function getPreviewDeviceKey(platform: MobilePlatform, deviceId: string) {
  return `${platform}:${deviceId}`;
}

function H264PreviewCanvas({
  sessionId,
  width,
  height,
  subscribeH264Chunks,
  onFpsChange,
  onFrameRendered,
  surfaceStyle,
}: {
  sessionId: string;
  width: number | null;
  height: number | null;
  subscribeH264Chunks: (
    listener: (chunk: MobilePreviewH264Chunk) => void,
  ) => () => void;
  onFpsChange: (fps: number) => void;
  onFrameRendered: (
    sessionId: string,
    source: 'image' | 'raw-rgba' | 'h264',
  ) => void;
  surfaceStyle?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<WebCodecsVideoDecoder | null>(null);
  const writerRef =
    useRef<WritableStreamDefaultWriter<ScrcpyMediaStreamPacket> | null>(null);
  const parserRef = useRef<ReturnType<typeof createH264AccessUnitParser>>(
    createH264AccessUnitParser(),
  );
  const chunksReceivedRef = useRef(0);
  const dataPacketsReceivedRef = useRef(0);
  const accessUnitsRef = useRef(0);
  const queuedDecodesRef = useRef(0);
  const decoderGenerationRef = useRef(0);
  const hasDecodedKeyframeRef = useRef(false);
  const lastStatsSampleRef = useRef({
    at: 0,
    received: 0,
    queued: 0,
    rendered: 0,
    skipped: 0,
  });
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [decodedFrames, setDecodedFrames] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    parserRef.current = createH264AccessUnitParser();
    chunksReceivedRef.current = 0;
    dataPacketsReceivedRef.current = 0;
    accessUnitsRef.current = 0;
    queuedDecodesRef.current = 0;
    decoderGenerationRef.current += 1;
    hasDecodedKeyframeRef.current = false;
    lastStatsSampleRef.current = {
      at: performance.now(),
      received: 0,
      queued: 0,
      rendered: 0,
      skipped: 0,
    };
    queueMicrotask(() => {
      setDecodeError(null);
      setDecodedFrames(0);
      onFpsChange(0);
    });

    if (!WebCodecsVideoDecoder.isSupported) {
      queueMicrotask(() => {
        setDecodeError(
          'WebCodecs VideoDecoder is not available in this renderer',
        );
      });
      return undefined;
    }

    let renderedFrameRequest: number | null = null;
    try {
      const renderer = WebGLVideoFrameRenderer.isSupported
        ? new WebGLVideoFrameRenderer(canvas)
        : new BitmapVideoFrameRenderer(canvas);
      const decoder = new WebCodecsVideoDecoder({
        codec: ScrcpyVideoCodecId.H264,
        renderer,
      });
      decoder.sizeChanged(({ width, height }) => {
        canvas.width = width;
        canvas.height = height;
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer h264 size sessionId=%s size=%dx%d',
          sessionId,
          width,
          height,
        );
      });
      decoderRef.current = decoder;
      writerRef.current = decoder.writable.getWriter();
      const observeRenderedFrame = () => {
        if (decoder.framesRendered > 0) {
          notifyH264FrameRendered(onFrameRendered, sessionId);
          return;
        }
        renderedFrameRequest = requestAnimationFrame(observeRenderedFrame);
      };
      renderedFrameRequest = requestAnimationFrame(observeRenderedFrame);
    } catch (error) {
      queueMicrotask(() => {
        setDecodeError(error instanceof Error ? error.message : String(error));
      });
    }

    return () => {
      if (renderedFrameRequest !== null) {
        cancelAnimationFrame(renderedFrameRequest);
      }
      decoderGenerationRef.current += 1;
      void writerRef.current?.close().catch(() => undefined);
      writerRef.current = null;
      decoderRef.current?.dispose();
      decoderRef.current = null;
    };
  }, [onFpsChange, onFrameRendered, sessionId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const decoder = decoderRef.current;
      const now = performance.now();
      const previous = lastStatsSampleRef.current;
      const seconds = Math.max((now - previous.at) / 1000, 0.001);
      const rendered = decoder?.framesRendered ?? 0;
      const skipped = decoder?.framesSkipped ?? 0;
      const received = dataPacketsReceivedRef.current;
      const queued = queuedDecodesRef.current;

      const renderedFps = Math.round((rendered - previous.rendered) / seconds);
      onFpsChange(renderedFps);
      lastStatsSampleRef.current = {
        at: now,
        received,
        queued,
        rendered,
        skipped,
      };
    }, 1000);

    return () => window.clearInterval(timer);
  }, [onFpsChange, sessionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !height) return;
    canvas.width = width;
    canvas.height = height;
  }, [height, width]);

  const writeH264Packet = useCallback(
    (packet: ScrcpyMediaStreamPacket) => {
      const writer = writerRef.current;
      if (!decoderRef.current || !writer) return;
      const decoderGeneration = decoderGenerationRef.current;
      if (packet.type === 'data') dataPacketsReceivedRef.current += 1;

      if (packet.type === 'configuration') {
        hasDecodedKeyframeRef.current = false;
      } else if (!hasDecodedKeyframeRef.current) {
        if (packet.keyframe === false) {
          return;
        }
        hasDecodedKeyframeRef.current = true;
      }

      void writer.write(packet).catch((error: unknown) => {
        if (
          writerRef.current !== writer ||
          decoderGenerationRef.current !== decoderGeneration
        ) {
          return;
        }
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer h264 decode throw sessionId=%s queued=%d type=%s bytes=%d error=%s',
          sessionId,
          queuedDecodesRef.current,
          packet.type,
          packet.data.length,
          error instanceof Error ? error.message : String(error),
        );
        setDecodeError(error instanceof Error ? error.message : String(error));
      });
      queuedDecodesRef.current += 1;
      if (packet.type === 'data') setDecodedFrames((count) => count || 1);
    },
    [sessionId],
  );

  const processH264Chunk = useCallback(
    (nextChunk: MobilePreviewH264Chunk) => {
      const writer = writerRef.current;
      if (!decoderRef.current || !writer) return;

      chunksReceivedRef.current += 1;
      if (
        chunksReceivedRef.current === 1 ||
        chunksReceivedRef.current % 30 === 0
      ) {
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer h264 process chunk sessionId=%s chunks=%d base64Length=%d packetType=%s',
          sessionId,
          chunksReceivedRef.current,
          nextChunk.frameBase64.length,
          nextChunk.h264PacketType ?? 'raw',
        );
      }

      if (nextChunk.h264PacketType) {
        const data = base64ToBytes(nextChunk.frameBase64);
        const keyframe =
          nextChunk.h264PacketType === 'data'
            ? nextChunk.keyframe || containsH264Keyframe(data) || undefined
            : undefined;
        writeH264Packet({
          type: nextChunk.h264PacketType,
          keyframe,
          data,
        } as ScrcpyMediaStreamPacket);
        return;
      }

      const accessUnits = parserRef.current(
        base64ToBytes(nextChunk.frameBase64),
      );
      accessUnitsRef.current += accessUnits.length;
      if (accessUnits.length > 0 || chunksReceivedRef.current % 30 === 0) {
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer h264 parser sessionId=%s chunks=%d emitted=%d totalAccessUnits=%d framesRendered=%d framesSkipped=%d',
          sessionId,
          chunksReceivedRef.current,
          accessUnits.length,
          accessUnitsRef.current,
          decoderRef.current.framesRendered,
          decoderRef.current.framesSkipped,
        );
      }

      for (const accessUnit of accessUnits) {
        if (accessUnit.configuration) {
          writeH264Packet({
            type: 'configuration',
            data: accessUnit.configuration,
          });
        }
        writeH264Packet({
          type: 'data',
          keyframe: accessUnit.isKey,
          data: accessUnit.data,
        });
        if (
          queuedDecodesRef.current === 1 ||
          queuedDecodesRef.current % 30 === 0
        ) {
          logMobilePreviewDebug(
            'jc:mobile-preview:renderer h264 decode queued sessionId=%s queued=%d key=%s bytes=%d',
            sessionId,
            queuedDecodesRef.current,
            accessUnit.isKey,
            accessUnit.data.length,
          );
        }
      }
    },
    [sessionId, writeH264Packet],
  );

  useEffect(
    () => subscribeH264Chunks(processH264Chunk),
    [processH264Chunk, subscribeH264Chunks],
  );

  return (
    <div className="relative flex h-full items-center justify-center bg-zinc-950 p-4">
      <canvas
        ref={canvasRef}
        className="max-h-full max-w-full rounded-xl shadow-2xl select-none"
        style={surfaceStyle}
      />
      {decodedFrames === 0 ? (
        <div className="bg-bg-0/80 text-ink-2 border-border/70 absolute rounded-xl border px-3 py-2 text-xs shadow-xl backdrop-blur">
          {decodeError
            ? `H264 decode failed: ${decodeError}`
            : 'Waiting for H264 frame...'}
        </div>
      ) : null}
    </div>
  );
}

function RawRgbaPreviewCanvas({
  sessionId,
  width,
  height,
  subscribeH264Chunks,
  onFrameRendered,
  surfaceStyle,
}: {
  sessionId: string;
  width: number;
  height: number;
  subscribeH264Chunks: (
    listener: (chunk: MobilePreviewH264Chunk) => void,
  ) => () => void;
  onFrameRendered: (
    sessionId: string,
    source: 'image' | 'raw-rgba' | 'h264',
  ) => void;
  surfaceStyle?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef(0);
  const [frames, setFrames] = useState(0);

  const processRawFrame = useCallback(
    (chunk: MobilePreviewH264Chunk) => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return;

      const bytes = base64ToBytes(chunk.frameBase64);
      const expectedBytes = width * height * 4;
      if (bytes.length !== expectedBytes) {
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer raw frame size mismatch sessionId=%s bytes=%d expected=%d width=%d height=%d',
          sessionId,
          bytes.length,
          expectedBytes,
          width,
          height,
        );
        return;
      }

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      context.putImageData(
        new ImageData(new Uint8ClampedArray(bytes), width, height),
        0,
        0,
      );
      if (framesRef.current === 0) {
        notifyRawRgbaFrameRendered(onFrameRendered, sessionId);
      }
      framesRef.current += 1;
      if (framesRef.current === 1 || framesRef.current % 30 === 0) {
        logMobilePreviewDebug(
          'jc:mobile-preview:renderer raw output sessionId=%s frames=%d canvas=%dx%d',
          sessionId,
          framesRef.current,
          canvas.width,
          canvas.height,
        );
      }
      setFrames(framesRef.current);
    },
    [height, onFrameRendered, sessionId, width],
  );

  useEffect(() => {
    framesRef.current = 0;
    queueMicrotask(() => setFrames(0));
  }, [sessionId]);

  useEffect(
    () => subscribeH264Chunks(processRawFrame),
    [processRawFrame, subscribeH264Chunks],
  );

  return (
    <div className="relative flex h-full items-center justify-center bg-zinc-950 p-4">
      <canvas
        ref={canvasRef}
        className="max-h-full max-w-full rounded-xl shadow-2xl select-none"
        style={surfaceStyle}
      />
      {frames === 0 ? (
        <div className="bg-bg-0/80 text-ink-2 border-border/70 absolute rounded-xl border px-3 py-2 text-xs shadow-xl backdrop-blur">
          Waiting for raw frame...
        </div>
      ) : null}
    </div>
  );
}

function getPreviewErrorInfo(message: string): {
  title: string;
  summary: string;
  steps: string[];
  detail?: string;
} {
  const cleaned = cleanPreviewError(message);

  if (cleaned.includes('Missing required iOS preview tool: idb')) {
    return {
      title: 'Install iOS streaming tools',
      summary:
        'Jean-Claude can see simulators, but needs idb to send interactive input.',
      steps: [
        'brew tap facebook/fb && brew install idb-companion',
        'python3 -m pip install fb-idb',
        'Restart Jean-Claude after idb is on PATH',
      ],
    };
  }

  if (cleaned.includes('Missing required iOS preview tool: xcrun')) {
    return {
      title: 'Install Xcode tools',
      summary: 'xcrun is required to list and boot iOS simulators.',
      steps: ['xcode-select --install', 'Restart Jean-Claude'],
    };
  }

  if (cleaned.includes('Missing required Android preview tool: adb')) {
    return {
      title: 'Install Android Platform Tools',
      summary: 'adb is required to find Android devices and send input.',
      steps: [
        'brew install --cask android-platform-tools',
        'adb devices -l',
        'Restart Jean-Claude after adb is on PATH',
      ],
    };
  }

  return {
    title: 'Preview error',
    summary: cleaned,
    steps: [],
  };
}

function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div>
        <div className="text-ink-1 text-sm font-medium">{title}</div>
        {detail ? (
          <div className="text-ink-3 mt-1 text-xs">{detail}</div>
        ) : null}
      </div>
    </div>
  );
}

function PreviewErrorState({ message }: { message: string }) {
  const info = getPreviewErrorInfo(message);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="border-border/70 bg-bg-1/70 w-full max-w-[520px] overflow-hidden rounded-2xl border shadow-[0_22px_80px_oklch(0_0_0_/_0.32)]">
        <div className="border-border/60 flex items-start gap-3 border-b p-4">
          <div className="bg-status-warn/15 text-status-warn mt-0.5 rounded-xl p-2">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-ink-1 text-sm font-semibold">{info.title}</div>
            <div className="text-ink-3 mt-1 text-xs leading-relaxed">
              {info.summary}
            </div>
          </div>
        </div>

        {info.steps.length > 0 ? (
          <div className="space-y-2 p-4">
            <div className="text-ink-3 flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
              <Terminal className="h-3.5 w-3.5" />
              Setup steps
            </div>
            <div className="space-y-2">
              {info.steps.map((step) => (
                <code
                  key={step}
                  className="border-border/70 bg-bg-0 text-ink-1 block rounded-lg border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
                >
                  {step}
                </code>
              ))}
            </div>
          </div>
        ) : null}

        {info.detail ? (
          <div className="border-border/60 text-ink-3 border-t px-4 py-3 text-[11px] leading-relaxed">
            {info.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MobilePreviewPane({
  taskId,
  projectId,
  projectPath,
  mobilePreviewConfig,
  variant = 'pane',
  retainSessions = false,
  appPathOverride,
  metroPortOverride,
  metroStatusOverride,
  autoLaunchRunningRuntime = false,
  isSelectingAppPath = false,
  appSelectionError = null,
  onSelectAppPath,
}: {
  taskId: string;
  projectId: string;
  projectPath: string;
  mobilePreviewConfig?: MobilePreviewProjectConfig;
  variant?: 'pane' | 'standalone';
  retainSessions?: boolean;
  appPathOverride?: string;
  metroPortOverride?: number;
  metroStatusOverride?: CommandRunStatus;
  autoLaunchRunningRuntime?: boolean;
  isSelectingAppPath?: boolean;
  appSelectionError?: string | null;
  onSelectAppPath?: (appPath: string | null) => void;
  onClose: () => void;
}) {
  const isStandalone = variant === 'standalone';
  const [platform, setPlatform] = useState<MobilePlatform>('ios');
  const [deviceId, setDeviceId] = useState('');
  const [previewRotationDeg, setPreviewRotationDeg] = useState(0);
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  const [runtimeLaunchRetry, setRuntimeLaunchRetry] = useState(0);
  const [isStandaloneInspectorOpen, setIsStandaloneInspectorOpen] =
    useState(false);
  const [activeAction, setActiveAction] = useState<MobilePreviewAction | null>(
    null,
  );
  const [deeplinkUrl, setDeeplinkUrl] = useState('');
  const [hostPort, setHostPort] = useState('3000');
  const [devicePort, setDevicePort] = useState('3000');
  const [textSize, setTextSize] = useState<MobilePreviewTextSize>('normal');
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [copiedDeviceId, setCopiedDeviceId] = useState(false);
  const [activeTab, setActiveTab] = useState<MobilePreviewPaneTab>('setup');
  const [devToolsLaunchError, setDevToolsLaunchError] = useState<string | null>(
    null,
  );
  const [selectedDevToolsTargetId, setSelectedDevToolsTargetId] = useState('');
  const devToolsViewRef = useRef<HTMLDivElement | null>(null);
  const devToolsOpenRequestRef = useRef(0);
  const devToolsTargetMenuOpenRef = useRef(false);
  const [activeConsoleCommandId, setActiveConsoleCommandId] = useState<
    string | null
  >(null);
  const [resumeSetupAfterPrebuild, setResumeSetupAfterPrebuild] =
    useState(false);
  const [resumeSetupAfterDependenciesInstall, setResumeSetupAfterDependenciesInstall] =
    useState(false);
  const [isManageDevicesOpen, setIsManageDevicesOpen] = useState(false);
  const [isCreateAndroidDeviceOpen, setIsCreateAndroidDeviceOpen] =
    useState(false);
  const [isCreateIosDeviceOpen, setIsCreateIosDeviceOpen] = useState(false);
  const [manageCreatePlatform, setManageCreatePlatform] =
    useState<MobilePlatform>('android');
  const [managedSelectedDeviceKey, setManagedSelectedDeviceKey] = useState<
    string | null
  >(null);
  const [androidDeviceName, setAndroidDeviceName] = useState('Pixel_8_API_35');
  const [androidDeviceProfileId, setAndroidDeviceProfileId] =
    useState('pixel_8');
  const [androidSystemImageId, setAndroidSystemImageId] = useState('');
  const [androidRamMb, setAndroidRamMb] = useState('');
  const [androidVmHeapMb, setAndroidVmHeapMb] = useState('');
  const [androidStorageMb, setAndroidStorageMb] = useState('');
  const [androidHwKeyboard, setAndroidHwKeyboard] = useState(true);
  const [deletingAndroidDeviceId, setDeletingAndroidDeviceId] = useState<
    string | null
  >(null);
  const [iosDeviceName, setIosDeviceName] = useState('');
  const [iosDeviceTypeId, setIosDeviceTypeId] = useState('');
  const [iosRuntimeId, setIosRuntimeId] = useState('');
  const [renamingIosDeviceId, setRenamingIosDeviceId] = useState<string | null>(
    null,
  );
  const [iosRenameValue, setIosRenameValue] = useState('');
  const [deletingIosDeviceId, setDeletingIosDeviceId] = useState<string | null>(
    null,
  );
  const [erasingIosDeviceId, setErasingIosDeviceId] = useState<string | null>(
    null,
  );
  const [enableNetworkMitm, setEnableNetworkMitm] = useState(false);
  const [androidCertGuidanceVisible, setAndroidCertGuidanceVisible] =
    useState(false);
  const [isRestartingAndroidApp, setIsRestartingAndroidApp] = useState(false);
  const [isRestartingIosApp, setIsRestartingIosApp] = useState(false);
  const [showTunneledNetworkRequests, setShowTunneledNetworkRequests] =
    useState(false);
  const [networkPreset, setNetworkPreset] =
    useState<NetworkPresetFilter>('all');
  const [networkFilter, setNetworkFilter] = useState<NetworkFilterToken[]>([]);
  const [networkFacet, setNetworkFacet] = useState('all');
  const [androidAppStatus, setAndroidAppStatus] =
    useState<MobilePreviewAndroidAppStatus | null>(null);
  const [resolvedIosAppStatus, setResolvedIosAppStatus] = useState<{
    requestKey: string;
    value: MobilePreviewIosAppStatus | null;
    error: string | null;
  } | null>(null);
  const [iosAppStatusRefreshNonce, setIosAppStatusRefreshNonce] = useState(0);
  const [launchedIosBuildCommandIds, setLaunchedIosBuildCommandIds] = useState<
    string[]
  >([]);
  const [androidProjectExists, setAndroidProjectExists] = useState<
    boolean | null
  >(null);
  const [deviceRailWidth, setDeviceRailWidth] = useState(220);
  const [inspectorPaneWidth, setInspectorPaneWidth] = useState(392);
  const [networkEndpointRailWidth, setNetworkEndpointRailWidth] =
    useState(184);
  const [selectedNetworkRequestId, setSelectedNetworkRequestId] = useState<
    string | null
  >(null);
  const [networkFilterContextMenu, setNetworkFilterContextMenu] =
    useState<NetworkFilterContextMenuState | null>(null);
  const hasAutoSelectedNetworkRequestRef = useRef(false);
  const { width, setWidth, minWidth, maxWidth } = useMobilePreviewPaneWidth();
  const { fps, setFps } = useMobilePreviewFps();
  const { quality, setQuality } = useMobilePreviewQuality();
  const { showGestures, setShowGestures } = useMobilePreviewShowGestures();
  const { autoStartProxy } = useMobilePreviewAutoStartProxy();
  const { isDragging, handleMouseDown } = useHorizontalResize({
    initialWidth: width,
    minWidth,
    maxWidth,
    maxWidthFraction: 0.85,
    direction: 'left',
    onWidthChange: setWidth,
  });
  const {
    isDragging: isDraggingNetworkEndpointRail,
    handleMouseDown: handleNetworkEndpointRailMouseDown,
  } = useHorizontalResize({
    initialWidth: networkEndpointRailWidth,
    minWidth: 140,
    maxWidth: 320,
    maxWidthFraction: 0.35,
    direction: 'right',
    onWidthChange: setNetworkEndpointRailWidth,
  });
  const {
    isDragging: isDraggingDeviceRail,
    handleMouseDown: handleDeviceRailMouseDown,
  } = useHorizontalResize({
    initialWidth: deviceRailWidth,
    minWidth: 160,
    maxWidth: 340,
    maxWidthFraction: 0.35,
    direction: 'right',
    onWidthChange: setDeviceRailWidth,
  });
  const {
    isDragging: isDraggingInspectorPane,
    handleMouseDown: handleInspectorPaneMouseDown,
  } = useHorizontalResize({
    initialWidth: inspectorPaneWidth,
    minWidth: 300,
    maxWidth: 560,
    maxWidthFraction: 0.55,
    direction: 'left',
    onWidthChange: setInspectorPaneWidth,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const networkPanelRef = useRef<HTMLDivElement>(null);
  const pendingNetworkContextMenuRef = useRef<HTMLElement | null>(null);
  const suppressNetworkClickRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const mobileActionsMenuRef = useRef<{ toggle: () => void } | null>(null);
  const deeplinkInputRef = useRef<HTMLInputElement>(null);
  const selectedDevicePreferenceKeyRef = useRef<string | null>(null);
  const suggestedIosDeviceNameRef = useRef('');
  const previousIosBuildCommandIdRef = useRef<string | null>(null);
  const launchedIosBuildCommandIdsRef = useRef(new Set<string>());
  const pointerStartRef = useRef<{
    pointerId: number;
    pointerType: string;
    clientX: number;
    clientY: number;
    imageX: number;
    imageY: number;
    currentImageX: number;
    currentImageY: number;
    lastMoveSentAt: number;
    startedAt: number;
    didSendTouchDown: boolean;
  } | null>(null);
  const lastWheelInputAtRef = useRef(0);
  const gestureFeedbackIdRef = useRef(0);
  const gestureFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [setupOperationCoordinator] = useState(
    createPreviewSetupOperationCoordinator,
  );
  const [iosBuildLaunchCoordinator] = useState(createIosBuildLaunchCoordinator);
  const lastImageStatsSampleRef = useRef({
    at: 0,
    received: 0,
  });
  const imageFrameCountRef = useRef(0);
  const [imageStats, setImageStats] = useState<ImagePreviewStats>({
    receivedFps: 0,
  });
  const [h264Fps, setH264Fps] = useState(0);
  const [gestureFeedback, setGestureFeedback] =
    useState<GestureFeedback | null>(null);
  const selectedAppPath = mobilePreviewConfig?.selectedAppPath ?? null;
  const detectedApps = mobilePreviewConfig?.detectedApps ?? EMPTY_DETECTED_APPS;
  const validSelectedAppPath =
    selectedAppPath && detectedApps.some((app) => app.path === selectedAppPath)
      ? selectedAppPath
      : null;
  const hasAppPathOverride =
    typeof appPathOverride === 'string' && appPathOverride.length > 0;
  const needsAppSelection =
    !hasAppPathOverride && detectedApps.length > 1 && !validSelectedAppPath;
  const appPath = hasAppPathOverride
    ? appPathOverride
    : (validSelectedAppPath ?? detectedApps[0]?.path ?? '.');
  const selectedDetectedApp =
    detectedApps.find((app) => app.path === appPath) ?? null;
  const isExpoApp = selectedDetectedApp?.stacks.includes('expo') ?? false;
  const devicePreferenceKey = `${taskId}:${appPath}`;
  const legacyDevicePreferenceKey = `${projectId}:${appPath}`;
  const {
    selectedDevice: savedSelectedDevice,
    setSelectedDevice: setSavedSelectedDevice,
    setVisibleDeviceIdsByPlatform,
    visibleDeviceIdsByPlatform: savedVisibleDeviceIdsByPlatform,
  } = useMobilePreviewDeviceSelection({
    key: devicePreferenceKey,
    legacyKey: legacyDevicePreferenceKey,
  });
  const visibleDeviceIdsByPlatform = useMemo(
    () => savedVisibleDeviceIdsByPlatform ?? { android: null, ios: null },
    [savedVisibleDeviceIdsByPlatform],
  );
  const androidProjectPath =
    mobilePreviewConfig?.androidProjectPath ??
    getDefaultAndroidProjectPath({ appPath, detectedApps });
  const inferredAndroidProjectPath = appPath === '.' ? 'android' : `${appPath}/android`;
  const effectiveProjectPath =
    appPath && appPath !== '.' ? `${projectPath}/${appPath}` : projectPath;
  const devServerCommandId = useMemo(
    () => createMobileDevServerCommandId(appPath),
    [appPath],
  );
  const buildCommandId = useMemo(
    () => getMobileBuildCommandId({ appPath, platform, deviceId }),
    [appPath, deviceId, platform],
  );
  const iosBuildCommandIdPrefix = `mobile-build:${encodeURIComponent(appPath || '.')}:ios:`;
  const prebuildCommandId = useMemo(
    () => `mobile-prebuild:${encodeURIComponent(appPath || '.')}:${platform}`,
    [appPath, platform],
  );
  const dependenciesInstallCommandId = useMemo(
    () => `mobile-dependencies-install:${encodeURIComponent(appPath || '.')}`,
    [appPath],
  );
  const devServerCommand =
    mobilePreviewConfig?.metroStartCommand ?? 'npx expo start --dev-client';
  const dependenciesInstallCommand =
    mobilePreviewConfig?.dependenciesInstallCommand ??
    (mobilePreviewConfig?.packageManager === 'pnpm'
      ? 'pnpm install'
      : mobilePreviewConfig?.packageManager === 'yarn'
        ? 'yarn install'
        : mobilePreviewConfig?.packageManager === 'bun'
          ? 'bun install'
          : 'npm install');
  const consoleCommandScope =
    platform === 'ios' ? `${appPath}\u0000${platform}\u0000${deviceId}` : `${appPath}\u0000${platform}`;
  const packageManagerRunner =
    mobilePreviewConfig?.packageManager === 'pnpm'
      ? 'pnpm exec expo prebuild'
      : mobilePreviewConfig?.packageManager === 'yarn'
        ? 'yarn expo prebuild'
        : mobilePreviewConfig?.packageManager === 'bun'
          ? 'bunx expo prebuild'
          : 'npx expo prebuild';
  const defaultPrebuildCommand = `${packageManagerRunner} --platform ${platform}`;
  const prebuildCommand =
    (platform === 'android'
      ? mobilePreviewConfig?.androidPrebuildCommand
      : mobilePreviewConfig?.iosPrebuildCommand) ?? defaultPrebuildCommand;
  const buildCommand =
    platform === 'android'
      ? (mobilePreviewConfig?.androidBuildCommand ?? null)
      : (mobilePreviewConfig?.iosBuildCommand ?? null);
  const configuredDevServerPort = mobilePreviewConfig?.metroPort ?? 8081;
  const runCommands = useRunCommands({
    taskId,
    projectId,
    workingDir: effectiveProjectPath,
  });
  const devServerStatus =
    metroStatusOverride ?? runCommands.statusByCommandId[devServerCommandId];
  const buildStatus = runCommands.statusByCommandId[buildCommandId];
  const prebuildStatus = runCommands.statusByCommandId[prebuildCommandId];
  const dependenciesInstallStatus =
    runCommands.statusByCommandId[dependenciesInstallCommandId];
  const devServerStarting = runCommands.isCommandStarting(devServerCommandId);
  const effectiveDevServerPort =
    !devServerStarting && devServerStatus?.status === 'running'
      ? (metroPortOverride ??
        devServerStatus.ports?.[0] ??
        configuredDevServerPort)
      : (metroPortOverride ?? configuredDevServerPort);
  const reactNativeDevTools = useReactNativeDevTools({
    metroPort: effectiveDevServerPort,
    panel: 'console',
    enabled: activeTab === 'devtools',
  });
  useEffect(() => {
    const targets = reactNativeDevTools.data?.targets ?? [];
    if (targets.length === 0) {
      queueMicrotask(() => setSelectedDevToolsTargetId(''));
      return;
    }
    if (targets.some((target) => target.id === selectedDevToolsTargetId)) return;
    const nextTargetId = targets.at(-1)?.id ?? '';
    queueMicrotask(() => setSelectedDevToolsTargetId(nextTargetId));
  }, [reactNativeDevTools.data?.targets, selectedDevToolsTargetId]);
  useEffect(() => {
    queueMicrotask(() => setActiveConsoleCommandId(null));
  }, [consoleCommandScope]);
  const currentIosBuildCommandId = platform === 'ios' && deviceId ? buildCommandId : null;
  const iosBuildLifecycleRef = useRef({
    statusByCommandId: runCommands.statusByCommandId,
    isCommandStarting: runCommands.isCommandStarting,
    stopCommand: runCommands.stopCommand,
  });
  useEffect(() => {
    iosBuildLifecycleRef.current = {
      statusByCommandId: runCommands.statusByCommandId,
      isCommandStarting: runCommands.isCommandStarting,
      stopCommand: runCommands.stopCommand,
    };
  }, [runCommands]);
  useEffect(() => {
    launchedIosBuildCommandIdsRef.current = new Set(launchedIosBuildCommandIds);
  }, [launchedIosBuildCommandIds]);
  useEffect(() => {
    const previousCommandId = previousIosBuildCommandIdRef.current;
    previousIosBuildCommandIdRef.current = currentIosBuildCommandId;
    if (previousCommandId && previousCommandId !== currentIosBuildCommandId) {
      iosBuildLaunchCoordinator.cancel(previousCommandId);
    }
    if (
      !shouldStopPreviousIosBuild({
        previousCommandId,
        currentCommandId: currentIosBuildCommandId,
        previousStatus: previousCommandId
          ? runCommands.statusByCommandId[previousCommandId]?.status
          : undefined,
        previousStarting: previousCommandId
          ? runCommands.isCommandStarting(previousCommandId)
          : false,
      })
    ) {
      return;
    }
    void runCommands.stopCommand(previousCommandId!);
  }, [currentIosBuildCommandId, iosBuildLaunchCoordinator, runCommands]);
  useEffect(
    () => () => {
      iosBuildLaunchCoordinator.cancelAll();
      const lifecycle = iosBuildLifecycleRef.current;
      const commandIds = new Set(launchedIosBuildCommandIdsRef.current);
      if (previousIosBuildCommandIdRef.current) {
        commandIds.add(previousIosBuildCommandIdRef.current);
      }
      commandIds.forEach((commandId) => {
        if (
          lifecycle.statusByCommandId[commandId]?.status === 'running' ||
          lifecycle.isCommandStarting(commandId)
        ) {
          void lifecycle.stopCommand(commandId);
        }
      });
    },
    [iosBuildLaunchCoordinator],
  );
  useEffect(() => {
    queueMicrotask(() => {
      setLaunchedIosBuildCommandIds((current) => {
        const next = current.filter((commandId) => {
          const status = runCommands.statusByCommandId[commandId]?.status;
          return !(
            (status === 'stopped' || status === 'errored') &&
            !runCommands.isCommandStarting(commandId)
          );
        });
        return next.length === current.length ? current : next;
      });
    });
  }, [runCommands]);
  const normalizedBuildStatus =
    platform === 'ios' && runCommands.status === null
      ? 'loading'
      : buildStatus?.status === 'running'
      ? 'running'
      : buildStatus?.status === 'stopped'
        ? 'completed'
        : buildStatus?.status === 'errored'
          ? 'errored'
          : 'idle';
  const normalizedPrebuildStatus =
    prebuildStatus?.status === 'stopped' ? 'completed' : prebuildStatus?.status;
  const iosAppStatusRequestKey =
    platform === 'ios' && deviceId
      ? getIosAppStatusRequestKey({
          projectId,
          taskId,
          appPath,
          deviceId,
          buildStatus: buildStatus?.status,
          prebuildStatus: prebuildStatus?.status,
          refreshNonce: iosAppStatusRefreshNonce,
          iosBundleId: mobilePreviewConfig?.iosBundleId,
          packageManager: mobilePreviewConfig?.packageManager,
        })
      : null;
  const {
    value: iosAppStatus,
    error: iosAppStatusError,
    isLoading: isIosAppStatusLoading,
  } = getIosAppStatusRequestState({
    requestKey: iosAppStatusRequestKey,
    resolved: resolvedIosAppStatus,
  });
  const androidStatusProjectPath =
    androidProjectPath ??
    (platform === 'android' && isExpoApp ? inferredAndroidProjectPath : null);
  const consoleCommandId = activeConsoleCommandId ?? devServerCommandId;
  const consoleStatus = runCommands.statusByCommandId[consoleCommandId];
  const devServerLog =
    useTaskMessagesStore(
      (state) => state.runCommandLogs[taskId]?.[consoleCommandId],
    ) ?? null;

  useEffect(() => {
    if (platform !== 'android' || !deviceId || !androidStatusProjectPath) {
      queueMicrotask(() => setAndroidAppStatus(null));
      queueMicrotask(() => setAndroidProjectExists(null));
      return;
    }

    let cancelled = false;
    api.mobilePreview
      .getAndroidAppStatus({
        projectId,
        taskId,
        androidProjectPath: androidStatusProjectPath,
        deviceId,
      })
      .then((status) => {
        if (!cancelled) {
          setAndroidAppStatus(status);
          setAndroidProjectExists(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = formatError(error) ?? '';
          setAndroidAppStatus(null);
          setAndroidProjectExists(
            message.includes('No native Android project found') ? false : null,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    androidStatusProjectPath,
    buildStatus?.status,
    deviceId,
    platform,
    prebuildStatus?.status,
    projectId,
    taskId,
  ]);
  useEffect(() => {
    if (!iosAppStatusRequestKey || platform !== 'ios' || !deviceId) {
      queueMicrotask(() => setResolvedIosAppStatus(null));
      return;
    }

    let cancelled = false;
    const requestId = crypto.randomUUID();
    queueMicrotask(() => {
      if (!cancelled) {
        setResolvedIosAppStatus((current) =>
          current?.requestKey === iosAppStatusRequestKey ? current : null,
        );
      }
    });
    api.mobilePreview
      .getIosAppStatus({ projectId, taskId, appPath, deviceId, requestId })
      .then((status) => {
        if (!cancelled) {
          setResolvedIosAppStatus({
            requestKey: iosAppStatusRequestKey,
            value: status,
            error: null,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setResolvedIosAppStatus({
            requestKey: iosAppStatusRequestKey,
            value: null,
            error: formatError(error) ?? 'Failed to check iOS app status',
          });
        }
      });

    return () => {
      cancelled = true;
      void api.mobilePreview
        .cancelIosAppStatus({ projectId, taskId, requestId })
        .catch(() => {});
    };
  }, [
    appPath,
    buildStatus?.status,
    deviceId,
    iosAppStatusRequestKey,
    mobilePreviewConfig?.iosBundleId,
    mobilePreviewConfig?.packageManager,
    platform,
    prebuildStatus?.status,
    projectId,
    taskId,
  ]);
  const nativeLogParams = useMemo(
    () => (deviceId ? { platform, deviceId } : null),
    [deviceId, platform],
  );
  const nativeLogs = useMobilePreviewNativeLogs(nativeLogParams);
  const selectedPreviewDevice = useMemo(
    () => (deviceId ? { platform, deviceId } : null),
    [deviceId, platform],
  );
  const selectedPreviewDeviceKey = selectedPreviewDevice
    ? getPreviewDeviceKey(selectedPreviewDevice.platform, selectedPreviewDevice.deviceId)
    : null;
  const networkProxyParams = useMemo(
    () =>
      deviceId && !needsAppSelection
        ? {
            projectPath,
            appPath,
            platform,
            deviceId,
            autoConfigureDevice: true,
          }
        : null,
    [appPath, deviceId, needsAppSelection, platform, projectPath],
  );
  const networkProxy = useMobilePreviewNetworkProxy(networkProxyParams);
  const androidManagement = useAndroidDeviceManagement(
    platform === 'android' || isManageDevicesOpen,
  );
  const iosManagement = useIosDeviceManagement(
    platform === 'ios' || isManageDevicesOpen || isCreateIosDeviceOpen,
  );
  const networkCertificateInstalled =
    networkProxy.certificate?.platform === platform &&
    networkProxy.certificate.deviceId === deviceId;
  const networkProxyStartParams = useMemo(
    () =>
      networkProxyParams
        ? {
            ...networkProxyParams,
            enableMitm: enableNetworkMitm && networkCertificateInstalled,
          }
        : null,
    [enableNetworkMitm, networkCertificateInstalled, networkProxyParams],
  );
  const networkRequests = useMemo(
    () =>
      [...networkProxy.requests].sort(
        (firstRequest, secondRequest) =>
          Date.parse(secondRequest.startedAt) -
          Date.parse(firstRequest.startedAt),
      ),
    [networkProxy.requests],
  );
  const displayedNetworkRequests = useMemo(
    () =>
      showTunneledNetworkRequests
        ? networkRequests
        : networkRequests.filter((request) => !request.tunnelOnly),
    [networkRequests, showTunneledNetworkRequests],
  );
  const visibleNetworkRequests = useMemo(
    () =>
      displayedNetworkRequests
        .filter((request) => matchesNetworkPreset(request, networkPreset))
        .filter(
          (request) =>
            networkFacet === 'all' || getNetworkPath(request.url) === networkFacet,
        )
        .filter((request) => matchesNetworkFilter(request, networkFilter)),
    [displayedNetworkRequests, networkFacet, networkFilter, networkPreset],
  );
  const networkStats = useMemo(
    () => getNetworkStats(displayedNetworkRequests),
    [displayedNetworkRequests],
  );
  const networkFacets = useMemo(
    () => getNetworkFacets(displayedNetworkRequests),
    [displayedNetworkRequests],
  );
  const selectedNetworkRequest =
    visibleNetworkRequests.find(
      (request) => request.id === selectedNetworkRequestId,
    ) ?? null;

  useEffect(() => {
    if (networkFilter.length === 0) return;
    logNetworkFilterDebug('filter-applied', {
      tokens: networkFilter,
      displayedCount: displayedNetworkRequests.length,
      visibleCount: visibleNetworkRequests.length,
      hiddenSamples: displayedNetworkRequests
        .filter(
          (request) =>
            matchesNetworkPreset(request, networkPreset) &&
            (networkFacet === 'all' || getNetworkPath(request.url) === networkFacet) &&
            !matchesNetworkFilter(request, networkFilter),
        )
        .slice(0, 8)
        .map((request) => ({
          method: request.method,
          status: getNetworkStatusLabel(request),
          host: getNetworkHostname(request.url),
          path: getNetworkPath(request.url),
          tokenResults: networkFilter.map((token) => ({
            token,
            matches: matchesNetworkFilterToken(request, token),
          })),
        })),
      visibleSamples: visibleNetworkRequests.slice(0, 5).map((request) => ({
        host: getNetworkHostname(request.url),
        path: getNetworkPath(request.url),
      })),
    });
  }, [
    displayedNetworkRequests,
    networkFacet,
    networkFilter,
    networkPreset,
    visibleNetworkRequests,
  ]);

  useEffect(() => {
    if (hasAutoSelectedNetworkRequestRef.current) return;
    const firstRequest = visibleNetworkRequests[0];
    if (!firstRequest) return;
    hasAutoSelectedNetworkRequestRef.current = true;
    queueMicrotask(() => setSelectedNetworkRequestId(firstRequest.id));
  }, [visibleNetworkRequests]);

  useEffect(() => {
    if (!selectedNetworkRequestId) return;
    if (
      visibleNetworkRequests.some(
        (request) => request.id === selectedNetworkRequestId,
      )
    ) {
      return;
    }

    queueMicrotask(() =>
      setSelectedNetworkRequestId(visibleNetworkRequests[0]?.id ?? null),
    );
  }, [selectedNetworkRequestId, visibleNetworkRequests]);

  useEffect(() => {
    if (networkFacet === 'all') return;
    if (networkFacets.some((facet) => facet.path === networkFacet)) return;
    queueMicrotask(() => setNetworkFacet('all'));
  }, [networkFacet, networkFacets]);

  const {
    data: iosDevices = [],
    error: iosDevicesError,
    isLoading: isLoadingIosDevices,
  } = useMobilePreviewDevices('ios');
  const {
    data: androidDevices = [],
    error: androidDevicesError,
    isLoading: isLoadingAndroidDevices,
  } = useMobilePreviewDevices('android');
  const {
    session,
    activeSessionDeviceKeys,
    frameUrl,
    imageFrameCount,
    subscribeH264Chunks,
    start,
    cancelStart,
    stop,
    sendInput,
    rotate,
    isStarting,
    isStopping,
    isRotating,
    isHydratingRetainedSessions,
    startError,
    stopError,
    rotateError,
  } = useMobilePreviewSession(taskId, selectedPreviewDevice, {
    retainSessions,
  });

  const selectPreviewDevice = useCallback(
    ({ platform: nextPlatform, deviceId: nextDeviceId }: {
      platform: MobilePlatform;
      deviceId: string;
    }) => {
      if (nextPlatform === platform && nextDeviceId === deviceId) return;
      if (!retainSessions && session && session.status !== 'stopped') {
        void stop().catch((error: unknown) => {
          setInputNotice(formatError(error) ?? 'Failed to stop preview stream');
        });
      }
      applyPreviewDeviceSwitch({
        platform: nextPlatform,
        deviceId: nextDeviceId,
        cancelPending: () =>
          cancelPendingWorkspaceSetup({
            cancelSetupOperation: setupOperationCoordinator.cancel,
            cancelStart,
            setResumeSetupAfterPrebuild,
          }),
        setPlatform,
        setDeviceId,
      });
    },
    [
      cancelStart,
      deviceId,
      platform,
      retainSessions,
      session,
      setupOperationCoordinator,
      stop,
    ],
  );

  const allDevices = useMemo(
    () => [...androidDevices, ...iosDevices],
    [androidDevices, iosDevices],
  );
  const managedDeviceKey = `${platform}:${deviceId}`;
  const selectedManagedDevice = useMemo(() => {
    const preferredKey = managedSelectedDeviceKey ?? managedDeviceKey;
    return (
      allDevices.find(
        (device) => `${device.platform}:${device.id}` === preferredKey,
      ) ?? allDevices[0] ?? null
    );
  }, [allDevices, managedDeviceKey, managedSelectedDeviceKey]);
  const managedDevicesByPlatform = useMemo(
    () => ({
      android: allDevices.filter((device) => device.platform === 'android'),
      ios: allDevices.filter((device) => device.platform === 'ios'),
    }),
    [allDevices],
  );
  const isCreatingManagedDevice =
    isCreateAndroidDeviceOpen || isCreateIosDeviceOpen;

  useEffect(() => {
    if (!isManageDevicesOpen) return undefined;

    function handleManageDevicesEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (isCreatingManagedDevice) {
        setIsCreateAndroidDeviceOpen(false);
        setIsCreateIosDeviceOpen(false);
      } else {
        setIsManageDevicesOpen(false);
      }
    }

    window.addEventListener('keydown', handleManageDevicesEscape, true);
    return () =>
      window.removeEventListener('keydown', handleManageDevicesEscape, true);
  }, [isCreatingManagedDevice, isManageDevicesOpen]);
  const hasPendingVisibleDeviceDefaults =
    visibleDeviceIdsByPlatform.android === null ||
    visibleDeviceIdsByPlatform.ios === null;
  const visibleDevices = useMemo(
    () =>
      allDevices.filter((device) => {
        const visibleDeviceIds = visibleDeviceIdsByPlatform[device.platform];
        return visibleDeviceIds === null || visibleDeviceIds.includes(device.id);
      }),
    [allDevices, visibleDeviceIdsByPlatform],
  );
  const selectedDevice = useMemo(
    () =>
      allDevices.find(
        (device) => device.id === deviceId && device.platform === platform,
      ),
    [allDevices, deviceId, platform],
  );
  const previewSurfaceStyle = useMemo<CSSProperties>(
    () => {
      const radiusRatio = getDeviceCornerRadiusRatio({
        platform,
        deviceName: selectedDevice?.name ?? '',
      });
      const screenAspectRatio =
        session?.width && session.height ? session.width / session.height : 0.46;
      return {
        borderRadius: `${radiusRatio * 100}% / ${radiusRatio * screenAspectRatio * 100}%`,
        transform: `rotate(${previewRotationDeg}deg)`,
        transformOrigin: 'center',
        transition: 'transform 120ms ease',
      };
    },
    [
      platform,
      previewRotationDeg,
      selectedDevice?.name,
      session,
    ],
  );
  const selectedDeviceCanStart = canStartDevice(selectedDevice);
  const activeSessionDeviceReady =
    !!session &&
    session.status !== 'stopped' &&
    session.platform === platform &&
    session.deviceId === deviceId;

  const androidProfileOptions = useMemo(
    () =>
      (androidManagement.profiles.data ?? []).map((profile) => ({
        value: profile.id,
        label: profile.name,
        description: profile.manufacturer ?? undefined,
      })),
    [androidManagement.profiles.data],
  );
  const androidSystemImageOptions = useMemo(
    () =>
      (androidManagement.systemImages.data ?? []).map((image) => ({
        value: image.id,
        label: `API ${image.apiLevel} · ${image.tag} · ${image.abi}`,
      })),
    [androidManagement.systemImages.data],
  );
  const availableIosRuntimes = useMemo(
    () => (iosManagement.runtimes.data ?? []).filter((runtime) => runtime.available),
    [iosManagement.runtimes.data],
  );
  const iosDeviceTypes = useMemo(
    () =>
      (iosManagement.deviceTypes.data ?? []).filter(
        (deviceType) =>
          deviceType.productFamily === 'iPhone' ||
          deviceType.name.toLowerCase().includes('iphone'),
      ),
    [iosManagement.deviceTypes.data],
  );
  const iosRuntimeOptions = useMemo(
    () =>
      availableIosRuntimes.map((runtime) => ({
        value: runtime.id,
        label: runtime.name,
      })),
    [availableIosRuntimes],
  );
  const iosDeviceTypeOptions = useMemo(
    () =>
      iosDeviceTypes.map((deviceType) => ({
        value: deviceType.id,
        label: deviceType.name,
      })),
    [iosDeviceTypes],
  );
  const selectedAndroidProfile = useMemo(
    () =>
      androidManagement.profiles.data?.find(
        (profile) => profile.id === androidDeviceProfileId,
      ) ?? null,
    [androidDeviceProfileId, androidManagement.profiles.data],
  );
  const selectedAndroidSystemImage = useMemo(
    () =>
      androidManagement.systemImages.data?.find(
        (image) => image.id === androidSystemImageId,
      ) ?? null,
    [androidSystemImageId, androidManagement.systemImages.data],
  );
  const selectedIosRuntime = useMemo(
    () =>
      availableIosRuntimes.find((runtime) => runtime.id === iosRuntimeId) ?? null,
    [availableIosRuntimes, iosRuntimeId],
  );
  const selectedIosDeviceType = useMemo(
    () =>
      iosDeviceTypes.find((deviceType) => deviceType.id === iosDeviceTypeId) ?? null,
    [iosDeviceTypeId, iosDeviceTypes],
  );
  const suggestedIosDeviceName = getSuggestedIosDeviceName({
    deviceType: selectedIosDeviceType,
    runtime: selectedIosRuntime,
  });
  const androidHostArch = androidManagement.toolStatus.data?.hostArch;
  const androidImageCompatibilityWarning = getAndroidImageCompatibilityWarning(
    androidHostArch,
    selectedAndroidSystemImage?.abi,
  );
  const androidManagementError =
    formatError(androidManagement.createDevice.error) ??
    formatError(androidManagement.deleteDevice.error) ??
    formatError(androidManagement.installSystemImage.error) ??
    formatError(androidManagement.profiles.error) ??
    formatError(androidManagement.systemImages.error) ??
    formatError(androidManagement.toolStatus.error);
  const iosManagementError =
    formatError(iosManagement.createDevice.error) ??
    formatError(iosManagement.deleteDevice.error) ??
    formatError(iosManagement.eraseDevice.error) ??
    formatError(iosManagement.renameDevice.error) ??
    formatError(iosManagement.runtimes.error) ??
    formatError(iosManagement.deviceTypes.error) ??
    formatError(iosManagement.toolStatus.error);
  const androidAdvancedNumbersAreValid = [
    androidRamMb,
    androidVmHeapMb,
    androidStorageMb,
  ].every(isOptionalPositiveInteger);
  const trimmedAndroidDeviceName = androidDeviceName.trim();
  const canCreateAndroidDevice =
    trimmedAndroidDeviceName.length > 0 &&
    androidAdvancedNumbersAreValid &&
    androidProfileOptions.some((option) => option.value === androidDeviceProfileId) &&
    androidSystemImageOptions.some(
      (option) => option.value === androidSystemImageId,
    );
  const trimmedIosDeviceName = iosDeviceName.trim();
  const canCreateIosDevice =
    trimmedIosDeviceName.length > 0 &&
    iosDeviceTypeOptions.some((option) => option.value === iosDeviceTypeId) &&
    iosRuntimeOptions.some((option) => option.value === iosRuntimeId);
  const devicesErrorMessage =
    formatError(androidDevicesError) ?? formatError(iosDevicesError);
  const isLoadingDevices = isLoadingAndroidDevices || isLoadingIosDevices;

  useEffect(() => {
    if (
      androidSystemImageId &&
      androidSystemImageOptions.some((option) => option.value === androidSystemImageId)
    ) {
      return;
    }
    if (!androidHostArch) return;
    const image = getPreferredAndroidSystemImage(
      androidManagement.systemImages.data,
      androidHostArch,
    );
    if (image) queueMicrotask(() => setAndroidSystemImageId(image.id));
  }, [
    androidHostArch,
    androidManagement.systemImages.data,
    androidSystemImageId,
    androidSystemImageOptions,
  ]);

  useEffect(() => {
    if (
      androidDeviceProfileId &&
      androidProfileOptions.some((option) => option.value === androidDeviceProfileId)
    ) {
      return;
    }
    const firstProfile = androidProfileOptions[0];
    if (firstProfile) queueMicrotask(() => setAndroidDeviceProfileId(firstProfile.value));
  }, [androidDeviceProfileId, androidProfileOptions]);

  useEffect(() => {
    if (
      iosRuntimeId &&
      iosRuntimeOptions.some((option) => option.value === iosRuntimeId)
    ) {
      return;
    }
    const firstRuntime = iosRuntimeOptions[0];
    if (firstRuntime) queueMicrotask(() => setIosRuntimeId(firstRuntime.value));
  }, [iosRuntimeId, iosRuntimeOptions]);

  useEffect(() => {
    if (
      iosDeviceTypeId &&
      iosDeviceTypeOptions.some((option) => option.value === iosDeviceTypeId)
    ) {
      return;
    }
    const firstDeviceType = iosDeviceTypeOptions[0];
    if (firstDeviceType) {
      queueMicrotask(() => setIosDeviceTypeId(firstDeviceType.value));
    }
  }, [iosDeviceTypeId, iosDeviceTypeOptions]);

  useEffect(() => {
    const previousSuggestedName = suggestedIosDeviceNameRef.current;
    suggestedIosDeviceNameRef.current = suggestedIosDeviceName;
    if (
      !suggestedIosDeviceName ||
      (iosDeviceName && iosDeviceName !== previousSuggestedName)
    ) {
      return;
    }
    queueMicrotask(() => setIosDeviceName(suggestedIosDeviceName));
  }, [iosDeviceName, suggestedIosDeviceName]);

  useEffect(() => {
    selectedDevicePreferenceKeyRef.current = null;
    queueMicrotask(() => {
      if (savedSelectedDevice) {
        setPlatform(savedSelectedDevice.platform);
        setDeviceId(savedSelectedDevice.deviceId);
      } else {
        setDeviceId('');
      }
      selectedDevicePreferenceKeyRef.current = devicePreferenceKey;
    });
  }, [devicePreferenceKey, savedSelectedDevice]);

  useEffect(() => {
    if (isLoadingDevices) return;
    if (activeSessionDeviceReady) return;
    if (selectedDevicePreferenceKeyRef.current !== devicePreferenceKey) return;

    if (autoLaunchRunningRuntime && !savedSelectedDevice && !deviceId) {
      return;
    }

    if (visibleDevices.length === 0) {
      queueMicrotask(() => setDeviceId(''));
      return;
    }

    if (
      !visibleDevices.some(
        (device) => device.id === deviceId && device.platform === platform,
      )
    ) {
      const preferredDevice =
        visibleDevices.find((device) => device.platform === platform) ??
        visibleDevices[0];
      queueMicrotask(() => {
        setPlatform(preferredDevice.platform);
        setDeviceId(preferredDevice.id);
      });
    }
  }, [
    activeSessionDeviceReady,
    autoLaunchRunningRuntime,
    deviceId,
    devicePreferenceKey,
    isLoadingDevices,
    platform,
    savedSelectedDevice,
    setDeviceId,
    visibleDevices,
  ]);

  const handleCreateAndroidDevice = useCallback(async () => {
    if (!canCreateAndroidDevice) return;
    try {
      await androidManagement.createDevice.mutateAsync({
        name: trimmedAndroidDeviceName,
        deviceProfileId: androidDeviceProfileId,
        systemImageId: androidSystemImageId,
        ramMb: getOptionalPositiveInteger(androidRamMb),
        vmHeapMb: getOptionalPositiveInteger(androidVmHeapMb),
        storageMb: getOptionalPositiveInteger(androidStorageMb),
        hwKeyboard: androidHwKeyboard,
      });
      setVisibleDeviceIdsByPlatform((current) => ({
        ...current,
        android: [
          ...new Set([
            ...(current.android ?? androidDevices.map((device) => device.id)),
            trimmedAndroidDeviceName,
          ]),
        ],
      }));
      selectPreviewDevice({
        platform: 'android',
        deviceId: trimmedAndroidDeviceName,
      });
      setIsCreateAndroidDeviceOpen(false);
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }, [
    androidDeviceProfileId,
    androidHwKeyboard,
    androidManagement.createDevice,
    androidDevices,
    androidRamMb,
    androidStorageMb,
    androidSystemImageId,
    androidVmHeapMb,
    canCreateAndroidDevice,
    selectPreviewDevice,
    setVisibleDeviceIdsByPlatform,
    trimmedAndroidDeviceName,
  ]);

  const handleInstallSuggestedAndroidImage = useCallback(async () => {
    try {
      await androidManagement.installSystemImage.mutateAsync({
        systemImageId: getSuggestedAndroidSystemImageId(androidHostArch),
      });
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }, [androidHostArch, androidManagement.installSystemImage]);

  async function handleDeleteAndroidDevice(name: string) {
    if (!window.confirm(`Delete Android device "${name}"?`)) return;
    setDeletingAndroidDeviceId(name);
    try {
      await androidManagement.deleteDevice.mutateAsync(name);
      setVisibleDeviceIdsByPlatform((current) => ({
        ...current,
        android: (current.android ?? androidDevices.map((device) => device.id)).filter(
          (id) => id !== name,
        ),
      }));
    } catch {
      // Mutation error is rendered from React Query state.
    } finally {
      setDeletingAndroidDeviceId(null);
    }
  }

  const handleCreateIosDevice = useCallback(async () => {
    if (!canCreateIosDevice) return;
    try {
      const createdDeviceId = await iosManagement.createDevice.mutateAsync({
        name: trimmedIosDeviceName,
        deviceTypeId: iosDeviceTypeId,
        runtimeId: iosRuntimeId,
      });
      if (createdDeviceId) {
        setVisibleDeviceIdsByPlatform((current) => ({
          ...current,
          ios: [
            ...new Set([
              ...(current.ios ?? iosDevices.map((device) => device.id)),
              createdDeviceId,
            ]),
          ],
        }));
        selectPreviewDevice({ platform: 'ios', deviceId: createdDeviceId });
      }
      setIsCreateIosDeviceOpen(false);
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }, [
    canCreateIosDevice,
    iosDevices,
    iosDeviceTypeId,
    iosManagement.createDevice,
    iosRuntimeId,
    selectPreviewDevice,
    setVisibleDeviceIdsByPlatform,
    trimmedIosDeviceName,
  ]);

  async function handleDeleteIosDevice(deviceIdToDelete: string) {
    if (!window.confirm('Delete this iOS simulator?')) return;
    setDeletingIosDeviceId(deviceIdToDelete);
    try {
      await iosManagement.deleteDevice.mutateAsync(deviceIdToDelete);
      setVisibleDeviceIdsByPlatform((current) => ({
        ...current,
        ios: (current.ios ?? iosDevices.map((device) => device.id)).filter(
          (id) => id !== deviceIdToDelete,
        ),
      }));
    } catch {
      // Mutation error is rendered from React Query state.
    } finally {
      setDeletingIosDeviceId(null);
    }
  }

  async function handleEraseIosDevice(deviceIdToErase: string) {
    if (!window.confirm('Erase this iOS simulator content and settings?')) return;
    setErasingIosDeviceId(deviceIdToErase);
    try {
      await iosManagement.eraseDevice.mutateAsync(deviceIdToErase);
    } catch {
      // Mutation error is rendered from React Query state.
    } finally {
      setErasingIosDeviceId(null);
    }
  }

  async function handleRenameIosDevice(deviceIdToRename: string) {
    const name = iosRenameValue.trim();
    if (!name) return;
    try {
      await iosManagement.renameDevice.mutateAsync({
        deviceId: deviceIdToRename,
        name,
      });
      setRenamingIosDeviceId(null);
      setIosRenameValue('');
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }

  useEffect(() => {
    queueMicrotask(() => setCopiedDeviceId(false));
  }, [deviceId]);

  useEffect(() => {
    if (isLoadingDevices) return;

    queueMicrotask(() => {
      setVisibleDeviceIdsByPlatform((current) => {
        const next = { ...current };
        let changed = false;
        const defaults: Record<MobilePlatform, MobilePreviewDevice[]> = {
          android: androidDevices.filter((device) => device.state === 'booted'),
          ios: iosDevices.filter((device) => device.state === 'booted'),
        };
        if (defaults.android.length === 0 && androidDevices[0]) {
          defaults.android = [androidDevices[0]];
        }

        (['android', 'ios'] as const).forEach((devicePlatform) => {
          if (next[devicePlatform] !== null) return;
          next[devicePlatform] = defaults[devicePlatform].map(
            (device) => device.id,
          );
          changed = true;
        });
        return changed ? next : current;
      });
    });
  }, [
    androidDevices,
    iosDevices,
    isLoadingDevices,
    setVisibleDeviceIdsByPlatform,
  ]);

  useEffect(() => {
    if (selectedDevicePreferenceKeyRef.current !== devicePreferenceKey) return;
    if (hasPendingVisibleDeviceDefaults) return;

    if (!deviceId) {
      setSavedSelectedDevice(null);
      return;
    }

    setSavedSelectedDevice({ platform, deviceId });
  }, [
    deviceId,
    devicePreferenceKey,
    hasPendingVisibleDeviceDefaults,
    platform,
    setSavedSelectedDevice,
  ]);

  const appOptions = useMemo(
    () =>
      detectedApps.map((app) => ({
        value: app.path,
        label:
          app.path === '.'
            ? `Root (${app.stacks.join(', ')})`
            : `${app.path} (${app.stacks.join(', ')})`,
        description: app.reasons.join(', '),
      })),
    [detectedApps],
  );

  const isRunning =
    session?.status === 'checking-tools' ||
    session?.status === 'starting' ||
    session?.status === 'streaming';
  const hasActiveSession = !!session && session.status !== 'stopped';
  const isInputPreparing = session?.inputStatus === 'starting';
  const displayError =
    session?.error ??
    formatError(startError) ??
    formatError(stopError) ??
    formatError(rotateError);
  const fatalSessionError = session?.status === 'error' ? displayError : null;
  const streamStrategyLabel = getStreamStrategyLabel(session?.streamStrategy);

  const runtimeLaunchState = useMobilePreviewExpoLaunch({
    isRunningRuntime: autoLaunchRunningRuntime,
    isLoadingDevices,
    selectedDevice: selectedDevice ?? null,
    isExpoApp,
    taskId,
    projectId,
    appPath,
    metroPort: effectiveDevServerPort,
    retryGeneration: runtimeLaunchRetry,
    isSelectedDeviceReady: activeSessionDeviceReady,
  });
  useEffect(() => {
    imageFrameCountRef.current = imageFrameCount;
  }, [imageFrameCount]);

  const handlePreviewFrameRendered = useCallback(
    (sessionId: string, source: 'image' | 'raw-rgba' | 'h264') => {
      setupOperationCoordinator.markFrameRendered(sessionId, source);
    },
    [setupOperationCoordinator],
  );

  useEffect(() => {
    setupOperationCoordinator.reconcile(
      getPreviewDeviceKey(platform, deviceId),
      session?.id ?? null,
    );
  }, [deviceId, platform, session?.id, setupOperationCoordinator]);

  useEffect(
    () => () => setupOperationCoordinator.cancel(),
    [setupOperationCoordinator],
  );

  useEffect(() => {
    lastImageStatsSampleRef.current = {
      at: performance.now(),
      received: 0,
    };
    queueMicrotask(() => {
      setImageStats({
        receivedFps: 0,
      });
      setH264Fps(0);
    });
  }, [session?.id]);

  useEffect(() => {
    queueMicrotask(() => setPreviewRotationDeg(0));
  }, [session?.id]);

  useEffect(() => {
    if (session?.status !== 'streaming') {
      queueMicrotask(() => {
        setImageStats((current) =>
          current.receivedFps === 0 ? current : { receivedFps: 0 },
        );
      });
      return undefined;
    }

    const timer = window.setInterval(() => {
      const now = performance.now();
      const previous = lastImageStatsSampleRef.current;
      const seconds = Math.max((now - previous.at) / 1000, 0.001);
      const received = imageFrameCountRef.current;
      const receivedFps = Math.round((received - previous.received) / seconds);

      setImageStats((current) =>
        current.receivedFps === receivedFps ? current : { receivedFps },
      );
      lastImageStatsSampleRef.current = {
        at: now,
        received,
      };
    }, 1000);

    return () => window.clearInterval(timer);
  }, [session?.id, session?.status]);

  const previewFps =
    session?.frameFormat === 'h264' ? h264Fps : imageStats.receivedFps;
  const previewMethodText =
    session?.status === 'streaming'
      ? (streamStrategyLabel ?? session.streamStrategy)
      : null;
  const previewFpsText =
    session?.status === 'streaming' ? `${previewFps} fps` : null;

  const mapClientPointToImage = useCallback(
    (
      clientX: number,
      clientY: number,
      options: {
        clampToBounds?: boolean;
        allowOutsideBounds?: boolean;
        edgeSlopPx?: number;
      } = {},
    ) => {
      const image = imgRef.current;
      const canvas = containerRef.current?.querySelector('canvas') ?? null;
      const surface = image ?? canvas;
      if (!surface) return null;

      const rect = surface.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const slop = options.clampToBounds
        ? (options.edgeSlopPx ?? POINTER_EDGE_SLOP_PX)
        : 0;
      if (
        !options.allowOutsideBounds &&
        !isPointWithinSurfaceBounds({
          x: clientX,
          y: clientY,
          surface: rect,
          slop,
        })
      ) {
        return null;
      }

      const { width: naturalWidth, height: naturalHeight } = resolveDeviceSize({
        surface: getSurfaceIntrinsicSize(surface),
        sessionWidth: session?.width ?? null,
        sessionHeight: session?.height ?? null,
        fallback: { width: rect.width, height: rect.height },
      });

      const x = options.clampToBounds
        ? clamp(clientX, rect.left, rect.right)
        : clientX;
      const y = options.clampToBounds
        ? clamp(clientY, rect.top, rect.bottom)
        : clientY;
      const rotation = normalizeRotationDegrees(previewRotationDeg);
      const displayWidth =
        rotation === 90 || rotation === 270 ? naturalHeight : naturalWidth;
      const displayHeight =
        rotation === 90 || rotation === 270 ? naturalWidth : naturalHeight;
      const rawPoint = {
        x: (x - rect.left) * (displayWidth / rect.width),
        y: (y - rect.top) * (displayHeight / rect.height),
      };
      const point = mapRotatedSurfacePoint({
        ...rawPoint,
        width: naturalWidth,
        height: naturalHeight,
        rotationDegrees: previewRotationDeg,
      });

      return {
        x: clamp(Math.round(point.x), 0, naturalWidth - 1),
        y: clamp(Math.round(point.y), 0, naturalHeight - 1),
      };
    },
    [previewRotationDeg, session?.height, session?.width],
  );

  const sendInputSafe = useCallback(
    (event: Parameters<typeof sendInput>[0]) => {
      void sendInput(event)
        .then(() => setInputNotice(null))
        .catch((sendError) => {
          setInputNotice(formatError(sendError) ?? 'Input failed');
        });
    },
    [sendInput],
  );

  const getGestureFeedbackPoint = useCallback((clientX: number, clientY: number) => {
    const containerRect = containerRef.current?.getBoundingClientRect();
    const image = imgRef.current;
    const canvas = containerRef.current?.querySelector('canvas') ?? null;
    const surfaceRect = (image ?? canvas)?.getBoundingClientRect();
    if (!containerRect || !surfaceRect) return null;
    return {
      x:
        clamp(clientX, surfaceRect.left, surfaceRect.right) -
        containerRect.left,
      y:
        clamp(clientY, surfaceRect.top, surfaceRect.bottom) -
        containerRect.top,
    };
  }, []);

  const clearGestureFeedbackTimer = useCallback(() => {
    if (!gestureFeedbackTimerRef.current) return;
    clearTimeout(gestureFeedbackTimerRef.current);
    gestureFeedbackTimerRef.current = null;
  }, []);

  const beginGestureFeedback = useCallback(
    (clientX: number, clientY: number) => {
      if (!showGestures) return;
      const point = getGestureFeedbackPoint(clientX, clientY);
      if (!point) return;
      clearGestureFeedbackTimer();
      gestureFeedbackIdRef.current = getNextGestureFeedbackId(
        gestureFeedbackIdRef.current,
      );
      setGestureFeedback({
        id: gestureFeedbackIdRef.current,
        points: [point],
        released: false,
      });
    },
    [clearGestureFeedbackTimer, getGestureFeedbackPoint, showGestures],
  );

  const extendGestureFeedback = useCallback(
    (clientX: number, clientY: number) => {
      if (!showGestures) return;
      const point = getGestureFeedbackPoint(clientX, clientY);
      if (!point) return;
      setGestureFeedback((current) => {
        if (!current || current.released) return current;
        const previous = current.points.at(-1);
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 2) {
          return current;
        }
        return { ...current, points: [...current.points.slice(-59), point] };
      });
    },
    [getGestureFeedbackPoint, showGestures],
  );

  const releaseGestureFeedback = useCallback(() => {
    if (!showGestures) return;
    clearGestureFeedbackTimer();
    setGestureFeedback((current) =>
      current ? { ...current, released: true } : current,
    );
    gestureFeedbackTimerRef.current = setTimeout(() => {
      gestureFeedbackTimerRef.current = null;
      setGestureFeedback(null);
    }, GESTURE_FEEDBACK_FADE_MS);
  }, [clearGestureFeedbackTimer, showGestures]);

  const showWheelGestureFeedback = useCallback(
    (startPoint: { x: number; y: number }, endPoint: { x: number; y: number }) => {
      if (!showGestures) return;
      const feedback = createWheelGestureFeedback({
        currentId: gestureFeedbackIdRef.current,
        startPoint,
        endPoint,
      });
      gestureFeedbackIdRef.current = feedback.id;
      setGestureFeedback(feedback);
      gestureFeedbackTimerRef.current = restartGestureFeedbackTimer({
        currentTimer: gestureFeedbackTimerRef.current,
        delayMs: GESTURE_FEEDBACK_FADE_MS,
        onExpire: () => {
          gestureFeedbackTimerRef.current = null;
          setGestureFeedback(null);
        },
      });
    },
    [showGestures],
  );

  useEffect(() => {
    if (!showGestures) {
      clearGestureFeedbackTimer();
      queueMicrotask(() => setGestureFeedback(null));
    }
    return clearGestureFeedbackTimer;
  }, [clearGestureFeedbackTimer, showGestures]);

  const autoPreviewStartAttemptKey = selectedPreviewDeviceKey
    ? [
        taskId,
        appPath,
        effectiveDevServerPort,
        devServerStatus?.pid ?? 'unknown-process',
        selectedPreviewDeviceKey,
      ].join('\0')
    : null;
  const {
    error: autoPreviewStartError,
    retry: retryAutoPreviewStart,
    clearError: clearAutoPreviewStartError,
  } = useMobilePreviewAutoStart({
    enabled:
      autoLaunchRunningRuntime &&
      !needsAppSelection &&
      !hasActiveSession &&
      !isHydratingRetainedSessions &&
      !!deviceId &&
      selectedDeviceCanStart,
    attemptKey: autoPreviewStartAttemptKey,
    start: () =>
      start({
        projectPath: effectiveProjectPath,
        platform,
        deviceId,
        fps,
        quality,
      }),
  });

  const handleStartStop = useCallback(async () => {
    try {
      if (hasActiveSession) {
        setupOperationCoordinator.cancel();
        await stop();
        return;
      }

      if (!deviceId || !selectedDeviceCanStart || needsAppSelection) return;
      await start({
        projectPath: effectiveProjectPath,
        platform,
        deviceId,
        fps,
        quality,
      });
      clearAutoPreviewStartError();
    } catch {
      // Hook exposes start/stop errors for rendering.
    }
  }, [
    deviceId,
    fps,
    hasActiveSession,
    platform,
    effectiveProjectPath,
    quality,
    selectedDeviceCanStart,
    needsAppSelection,
    start,
    stop,
    setupOperationCoordinator,
    clearAutoPreviewStartError,
  ]);

  const handleSelectDevice = useCallback(
    (device: MobilePreviewDevice) => {
      selectPreviewDevice({ platform: device.platform, deviceId: device.id });
    },
    [selectPreviewDevice],
  );

  const showActionNotice = useCallback((message: string) => {
    setInputNotice(message);
  }, []);

  const handleCopyDeviceId = useCallback(async () => {
    if (!deviceId) return;
    await navigator.clipboard.writeText(deviceId);
    setCopiedDeviceId(true);
    showActionNotice('Device UUID copied');
  }, [deviceId, showActionNotice]);

  const handleOpenDeeplink = useCallback(async () => {
    if (!deviceId || !deeplinkUrl.trim()) return;
    setIsRunningAction(true);
    try {
      await api.mobilePreview.openDeeplink({
        platform,
        deviceId,
        url: deeplinkUrl.trim(),
      });
      showActionNotice('Deeplink opened');
    } catch (error) {
      setInputNotice(formatError(error) ?? 'Failed to open deeplink');
    } finally {
      setIsRunningAction(false);
    }
  }, [deeplinkUrl, deviceId, platform, showActionNotice]);

  const handleShowDeeplinkAction = useCallback(() => {
    mobileActionsMenuRef.current?.toggle();
    setActiveAction('deeplink');
    requestAnimationFrame(() => {
      deeplinkInputRef.current?.focus();
    });
  }, []);

  const parsedHostPort = parsePort(hostPort);
  const parsedDevicePort = parsePort(devicePort);
  const canForwardPort = parsedHostPort !== null && parsedDevicePort !== null;

  const handleForwardPort = useCallback(async () => {
    if (
      !deviceId ||
      platform !== 'android' ||
      parsedHostPort === null ||
      parsedDevicePort === null
    ) {
      return;
    }
    setIsRunningAction(true);
    try {
      await api.mobilePreview.forwardPort({
        platform,
        deviceId,
        hostPort: parsedHostPort,
        devicePort: parsedDevicePort,
      });
      showActionNotice(
        `Forwarded :${parsedDevicePort} -> localhost:${parsedHostPort}`,
      );
    } catch (error) {
      setInputNotice(formatError(error) ?? 'Failed to forward port');
    } finally {
      setIsRunningAction(false);
    }
  }, [deviceId, parsedDevicePort, parsedHostPort, platform, showActionNotice]);

  const handleSetTextSize = useCallback(async () => {
    if (!deviceId) return;
    setIsRunningAction(true);
    try {
      await api.mobilePreview.setTextSize({
        platform,
        deviceId,
        size: textSize,
      });
      showActionNotice('Text size applied');
    } catch (error) {
      setInputNotice(formatError(error) ?? 'Failed to set text size');
    } finally {
      setIsRunningAction(false);
    }
  }, [deviceId, platform, showActionNotice, textSize]);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        !canStartPointerInteraction({
          isPrimary: event.isPrimary,
          button: event.button,
          pointerType: event.pointerType,
          activePointerId: pointerStartRef.current?.pointerId ?? null,
        })
      ) {
        return;
      }
      containerRef.current?.focus();
      const point = mapClientPointToImage(event.clientX, event.clientY, {
        clampToBounds: session?.platform === 'ios',
      });
      if (!point) return;

      beginGestureFeedback(event.clientX, event.clientY);
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerStartRef.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        clientX: event.clientX,
        clientY: event.clientY,
        imageX: point.x,
        imageY: point.y,
        currentImageX: point.x,
        currentImageY: point.y,
        lastMoveSentAt: 0,
        startedAt: Date.now(),
        didSendTouchDown: false,
      };
      const downInput = getPointerDownInput({
        platform: session?.platform ?? platform,
        pointerType: event.pointerType,
        point,
      });
      if (downInput) {
        pointerStartRef.current.didSendTouchDown = true;
        sendInputSafe(downInput);
      }
    },
    [
      beginGestureFeedback,
      mapClientPointToImage,
      platform,
      sendInputSafe,
      session?.platform,
    ],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const startPoint = pointerStartRef.current;
      if (!startPoint || startPoint.pointerId !== event.pointerId) {
        return;
      }

      const point = mapClientPointToImage(event.clientX, event.clientY, {
        clampToBounds: session?.platform === 'ios',
      });
      if (!point) return;

      extendGestureFeedback(event.clientX, event.clientY);
      startPoint.currentImageX = point.x;
      startPoint.currentImageY = point.y;

      if (
        (session?.platform !== 'ios' && session?.platform !== 'android') ||
        !startPoint.pointerType
      ) {
        return;
      }

      const distance = Math.hypot(
        event.clientX - startPoint.clientX,
        event.clientY - startPoint.clientY,
      );
      if (distance <= SWIPE_THRESHOLD_PX) return;

      const now = Date.now();
      if (now - startPoint.lastMoveSentAt < TOUCH_MOVE_THROTTLE_MS) return;

      startPoint.lastMoveSentAt = now;
      const inputs = getPointerMoveInputs({
        platform: session.platform,
        pointerType: startPoint.pointerType,
        startPoint: { x: startPoint.imageX, y: startPoint.imageY },
        point,
        didSendTouchDown: startPoint.didSendTouchDown,
      });
      if (inputs.some((input) => input.type === 'touchDown')) {
        startPoint.didSendTouchDown = true;
      }
      inputs.forEach(sendInputSafe);
    },
    [extendGestureFeedback, mapClientPointToImage, sendInputSafe, session],
  );

  const finishPointerInteraction = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const startPoint = pointerStartRef.current;
      if (!startPoint || startPoint.pointerId !== pointerId) return;
      pointerStartRef.current = null;
      extendGestureFeedback(clientX, clientY);
      releaseGestureFeedback();

      const endPoint = mapClientPointToImage(clientX, clientY, {
        clampToBounds: session?.platform === 'ios',
      });

      if (startPoint.didSendTouchDown) {
        const upInput = getPointerUpInput({
          didSendTouchDown: true,
          point: {
            x: endPoint?.x ?? startPoint.currentImageX,
            y: endPoint?.y ?? startPoint.currentImageY,
          },
        });
        if (upInput) sendInputSafe(upInput);
        return;
      }

      if (session?.platform === 'ios') {
        const distance = Math.hypot(
          clientX - startPoint.clientX,
          clientY - startPoint.clientY,
        );
        const pressDurationMs = Date.now() - startPoint.startedAt;

        if (distance > SWIPE_THRESHOLD_PX && endPoint) {
          sendInputSafe({
            type: 'swipe',
            x1: startPoint.imageX,
            y1: startPoint.imageY,
            x2: endPoint.x,
            y2: endPoint.y,
            durationMs: Math.max(1, pressDurationMs),
          });
          return;
        }

        if (pressDurationMs >= LONG_PRESS_THRESHOLD_MS) {
          sendInputSafe({
            type: 'longPress',
            x: startPoint.imageX,
            y: startPoint.imageY,
            durationMs: pressDurationMs,
          });
          return;
        }

        sendInputSafe({ type: 'tap', x: startPoint.imageX, y: startPoint.imageY });
        return;
      }

      if (!endPoint) return;

      const distance = Math.hypot(
        clientX - startPoint.clientX,
        clientY - startPoint.clientY,
      );

      if (distance > SWIPE_THRESHOLD_PX) {
        sendInputSafe({
          type: 'swipe',
          x1: startPoint.imageX,
          y1: startPoint.imageY,
          x2: endPoint.x,
          y2: endPoint.y,
          durationMs: Math.max(1, Date.now() - startPoint.startedAt),
        });
        return;
      }

      const pressDurationMs = Date.now() - startPoint.startedAt;
      if (pressDurationMs >= LONG_PRESS_THRESHOLD_MS) {
        sendInputSafe({
          type: 'longPress',
          x: endPoint.x,
          y: endPoint.y,
          durationMs: pressDurationMs,
        });
        return;
      }

      sendInputSafe({ type: 'tap', x: endPoint.x, y: endPoint.y });
    },
    [
      extendGestureFeedback,
      mapClientPointToImage,
      releaseGestureFeedback,
      sendInputSafe,
      session?.platform,
    ],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      finishPointerInteraction(event.pointerId, event.clientX, event.clientY);
    },
    [finishPointerInteraction],
  );

  const handlePointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const startPoint = pointerStartRef.current;
    if (!matchesActivePointer(startPoint?.pointerId ?? null, event.pointerId)) {
      return;
    }
    pointerStartRef.current = null;
    releaseGestureFeedback();
    if (!startPoint || !startPoint.didSendTouchDown) {
      return;
    }

    sendInputSafe({
      type: 'touchUp',
      x: startPoint.currentImageX,
      y: startPoint.currentImageY,
    });
  }, [releaseGestureFeedback, sendInputSafe]);

  useEffect(() => {
    const handleDocumentPointerUp = (event: globalThis.PointerEvent) => {
      finishPointerInteraction(event.pointerId, event.clientX, event.clientY);
    };
    const handleDocumentPointerCancel = (event: globalThis.PointerEvent) => {
      const startPoint = pointerStartRef.current;
      if (
        !startPoint ||
        !matchesActivePointer(startPoint.pointerId, event.pointerId)
      ) {
        return;
      }
      pointerStartRef.current = null;
      releaseGestureFeedback();
      if (!startPoint.didSendTouchDown) return;

      sendInputSafe({
        type: 'touchUp',
        x: startPoint.currentImageX,
        y: startPoint.currentImageY,
      });
    };

    document.addEventListener('pointerup', handleDocumentPointerUp);
    document.addEventListener('pointercancel', handleDocumentPointerCancel);
    return () => {
      document.removeEventListener('pointerup', handleDocumentPointerUp);
      document.removeEventListener(
        'pointercancel',
        handleDocumentPointerCancel,
      );
    };
  }, [finishPointerInteraction, releaseGestureFeedback, sendInputSafe]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!isRunning) return;

      const now = Date.now();
      if (now - lastWheelInputAtRef.current < WHEEL_INPUT_THROTTLE_MS) return;

      const point = mapClientPointToImage(event.clientX, event.clientY, {
        clampToBounds: true,
        edgeSlopPx: 0,
      });
      if (!point) return;

      event.preventDefault();
      lastWheelInputAtRef.current = now;
      containerRef.current?.focus();

      const clientDistance = clamp(
        Math.abs(event.deltaY),
        WHEEL_SWIPE_MIN_DISTANCE_PX,
        WHEEL_SWIPE_MAX_DISTANCE_PX,
      );
      const direction = event.deltaY >= 0 ? -1 : 1;
      const endPoint = mapClientPointToImage(
        event.clientX,
        event.clientY + direction * clientDistance,
        { clampToBounds: true, allowOutsideBounds: true },
      );
      if (!endPoint) return;

      const feedbackStartPoint = getGestureFeedbackPoint(
        event.clientX,
        event.clientY,
      );
      const feedbackEndPoint = getGestureFeedbackPoint(
        event.clientX,
        event.clientY + direction * clientDistance,
      );
      if (feedbackStartPoint && feedbackEndPoint) {
        showWheelGestureFeedback(feedbackStartPoint, feedbackEndPoint);
      }

      sendInputSafe({
        type: 'swipe',
        x1: point.x,
        y1: point.y,
        x2: endPoint.x,
        y2: endPoint.y,
        durationMs: WHEEL_SWIPE_DURATION_MS,
      });
    },
    [
      isRunning,
      getGestureFeedbackPoint,
      mapClientPointToImage,
      sendInputSafe,
      showWheelGestureFeedback,
    ],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!isRunning) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        sendInputSafe({
          type: 'key',
          key: session?.platform === 'ios' ? 'home' : 'back',
        });
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        sendInputSafe({ type: 'key', key: 'backspace' });
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        sendInputSafe({ type: 'key', key: 'enter' });
        return;
      }

      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        sendInputSafe({ type: 'text', text: event.key });
      }
    },
    [isRunning, sendInputSafe, session?.platform],
  );

  const handleHomeButton = useCallback(() => {
    if (!isRunning) return;
    sendInputSafe({ type: 'key', key: 'home' });
  }, [isRunning, sendInputSafe]);

  const handleBackButton = useCallback(() => {
    if (!isRunning) return;

    if (session?.platform !== 'ios') {
      sendInputSafe({ type: 'key', key: 'back' });
      return;
    }

    const surfaceElement =
      imgRef.current ?? containerRef.current?.querySelector('canvas') ?? null;
    const surface = getSurfaceIntrinsicSize(surfaceElement);
    const { width, height } = resolveDeviceSize({
      surface,
      sessionWidth: session.width ?? null,
      sessionHeight: session.height ?? null,
      fallback: surface ?? { width: 0, height: 0 },
    });
    if (width <= 0 || height <= 0) return;

    const y = Math.round(height / 2);
    sendInputSafe({
      type: 'swipe',
      x1: 1,
      y1: y,
      x2: Math.round(width * 0.45),
      y2: y,
      durationMs: 220,
    });
  }, [isRunning, sendInputSafe, session]);

  const handleShowKeyboardButton = useCallback(() => {
    if (!isRunning) return;
    void sendInput({ type: 'showKeyboard' })
      .then(() => {
        setInputNotice(
          session?.platform === 'android'
            ? 'Android keyboard request sent. If it stays hidden, type directly in the preview.'
            : null,
        );
      })
      .catch((error) => {
        setInputNotice(formatError(error) ?? 'Keyboard request failed');
      });
  }, [isRunning, sendInput, session?.platform]);

  const handleRotateButton = useCallback(
    (direction: MobileRotationDirection) => {
      if (!isRunning) return;
      void rotate(direction)
        .then(() => {
          setPreviewRotationDeg((current) =>
            normalizeRotationDegrees(
              current + (direction === 'right' ? 90 : -90),
            ),
          );
          setInputNotice(null);
        })
        .catch((error) => {
          setInputNotice(formatError(error) ?? 'Rotation failed');
        });
    },
    [isRunning, rotate],
  );

  const inputPreparingOverlay = isInputPreparing ? (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/45 backdrop-blur-[1px]">
      <div className="border-border bg-bg-0/95 text-ink-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs shadow-lg">
        <Loader2 className="text-acc size-4 animate-spin" />
        Preparing touch input...
      </div>
    </div>
  ) : null;

  const actionTray =
    activeAction && deviceId ? (
      <div className="border-line bg-bg-1 flex flex-wrap items-center gap-2 border-t px-4 py-2">
        {activeAction === 'deeplink' ? (
          <>
            <Input
              ref={deeplinkInputRef}
              value={deeplinkUrl}
              onChange={(event) => setDeeplinkUrl(event.target.value)}
              placeholder="myapp://path"
              size="sm"
              className="min-w-52 flex-1"
            />
            <Button
              onClick={() => void handleOpenDeeplink()}
              disabled={!deeplinkUrl.trim() || isRunningAction}
              loading={isRunningAction}
              variant="secondary"
              size="sm"
            >
              Open
            </Button>
          </>
        ) : null}
        {activeAction === 'port' ? (
          <>
            <div className="flex items-center gap-1">
              <span className="text-ink-3 text-xs">Host</span>
              <Input
                value={hostPort}
                onChange={(event) => setHostPort(event.target.value)}
                inputMode="numeric"
                size="sm"
                className="w-20"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-ink-3 text-xs">Device</span>
              <Input
                value={devicePort}
                onChange={(event) => setDevicePort(event.target.value)}
                inputMode="numeric"
                size="sm"
                className="w-20"
              />
            </div>
            <Button
              onClick={() => void handleForwardPort()}
              disabled={!canForwardPort || isRunningAction}
              loading={isRunningAction}
              variant="secondary"
              size="sm"
            >
              Forward
            </Button>
          </>
        ) : null}
        {activeAction === 'text-size' ? (
          <>
            <Select
              value={textSize}
              options={TEXT_SIZE_OPTIONS}
              onChange={(value) => setTextSize(value as MobilePreviewTextSize)}
              size="sm"
              className="w-28"
            />
            <Button
              onClick={() => void handleSetTextSize()}
              disabled={isRunningAction}
              loading={isRunningAction}
              variant="secondary"
              size="sm"
            >
              Apply
            </Button>
          </>
        ) : null}
        <IconButton
          onClick={() => setActiveAction(null)}
          size="sm"
          icon={<X />}
          tooltip="Hide action"
        />
      </div>
    ) : null;

  const devServerRunning = devServerStatus?.status === 'running';
  const buildRunning = buildStatus?.status === 'running';
  const devServerStopping = runCommands.isCommandStopping(devServerCommandId);
  const buildStarting = runCommands.isCommandStarting(buildCommandId);
  const buildStopping = runCommands.isCommandStopping(buildCommandId);
  const prebuildStarting = runCommands.isCommandStarting(prebuildCommandId);
  const prebuildStopping = runCommands.isCommandStopping(prebuildCommandId);
  const handleStartStopDevServer = () => {
    if (devServerRunning) {
      void runCommands.stopCommand(devServerCommandId);
      return;
    }
    if (needsAppSelection) return;
    void runCommands.startAdHocCommand({
      runCommandId: devServerCommandId,
      name: 'Mobile dev server',
      command: devServerCommand,
      ports: [configuredDevServerPort],
      availablePort: { provider: 'args' },
    });
  };
  const handleStartStopBuild = () => {
    setActiveTab('dev-server');
    setActiveConsoleCommandId(buildCommandId);
    if (buildRunning) {
      void runCommands.stopCommand(buildCommandId);
      return;
    }
    if (!buildCommand || needsAppSelection) return;
    if (platform === 'ios' && !deviceId) return;
    if (platform === 'ios') {
      setLaunchedIosBuildCommandIds((current) =>
        current.includes(buildCommandId) ? current : [...current, buildCommandId],
      );
      void iosBuildLaunchCoordinator.launch({
        commandId: buildCommandId,
        start: () =>
          runCommands.startAdHocCommand({
            runCommandId: buildCommandId,
            name: 'iOS build',
            command: buildCommand,
            ports: [],
          }),
        stop: runCommands.stopCommand,
      });
      return;
    }
    void runCommands.startAdHocCommand({
      runCommandId: buildCommandId,
      name: 'Android build',
      command: buildCommand,
      ports: [],
    });
  };
  const handleStartStopPrebuild = () => {
    setActiveTab('dev-server');
    setActiveConsoleCommandId(prebuildCommandId);
    if (prebuildStatus?.status === 'running') {
      setResumeSetupAfterPrebuild(false);
      void runCommands.stopCommand(prebuildCommandId);
      return;
    }
    void runCommands.startAdHocCommand({
      runCommandId: prebuildCommandId,
      name: platform === 'android' ? 'Expo Android prebuild' : 'Expo iOS prebuild',
      command: prebuildCommand,
      ports: [],
    });
  };
  const consoleIsBuild = consoleCommandId === buildCommandId;
  const consoleIsPrebuild = consoleCommandId === prebuildCommandId;
  const consoleRunning = consoleStatus?.status === 'running';
  const devServerBody = (
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
      {runCommands.portsInUseError ? (
        <div className="border-status-fail/30 bg-status-fail/10 text-status-fail border-b px-3 py-1.5 text-xs">
          {runCommands.portsInUseError.message}
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

  const nativeLogSession = nativeLogs.session;
  const nativeLogStatus = nativeLogSession?.status ?? 'stopped';
  const handleStartStopNativeLogs = () => {
    if (nativeLogSession && nativeLogStatus === 'running') {
      void nativeLogs.stop(nativeLogSession.id);
      return;
    }
    if (!deviceId) return;
    void nativeLogs.start({ platform, deviceId });
  };
  const logsBody = (
    <div className="bg-bg-0 flex h-full min-h-0 flex-col">
      <div className="border-line bg-bg-1 flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="text-ink-1 text-sm font-medium">
            Device logs {nativeLogStatus}
          </div>
          <div className="text-ink-3 truncate text-xs">
            {nativeLogSession?.command ??
              (platform === 'ios' ? 'xcrun simctl log stream' : 'adb logcat')}
          </div>
        </div>
      </div>
      {nativeLogs.error || nativeLogSession?.error ? (
        <div className="border-status-fail/30 bg-status-fail/10 text-status-fail border-b px-3 py-1.5 text-xs">
          {formatError(nativeLogs.error) ?? nativeLogSession?.error}
        </div>
      ) : null}
      {!deviceId ? (
        <EmptyState title="No device selected" detail="Select a device first" />
      ) : nativeLogs.logs.length === 0 ? (
        <EmptyState
          title="No device logs"
          detail="Start logs to stream native output"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed">
          {nativeLogs.logs.map((entry, index) => (
            <div
              key={`${entry.timestamp}-${index}`}
              className={clsx(
                'whitespace-pre-wrap',
                entry.stream === 'stderr' ? 'text-amber-200' : 'text-zinc-200',
                entry.stream === 'system' && 'text-sky-200',
              )}
            >
              {entry.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const networkSession = networkProxy.session;
  const networkStatus = networkSession?.status ?? 'stopped';

  const handleStartStopNetworkProxy = () => {
    if (networkSession && networkStatus === 'running') {
      void networkProxy.stop(networkSession.id);
      return;
    }
    if (!networkProxyStartParams) return;
    void networkProxy.start(networkProxyStartParams);
  };
  const handleStopAll = useCallback(async () => {
    iosBuildLaunchCoordinator.cancelAll();
    cancelPendingWorkspaceSetup({
      cancelSetupOperation: setupOperationCoordinator.cancel,
      cancelStart,
      setResumeSetupAfterPrebuild,
    });
    setResumeSetupAfterDependenciesInstall(false);
    const stops: Promise<unknown>[] = [];

    if (hasActiveSession) {
      stops.push(stop());
    }
    if (devServerRunning) {
      stops.push(runCommands.stopCommand(devServerCommandId));
    }
    if (platform === 'android' && buildRunning) {
      stops.push(runCommands.stopCommand(buildCommandId));
    }
    const iosBuildCommandIds = new Set(launchedIosBuildCommandIds);
    Object.keys(runCommands.statusByCommandId).forEach((commandId) => {
      if (commandId.startsWith(iosBuildCommandIdPrefix)) {
        iosBuildCommandIds.add(commandId);
      }
    });
    iosBuildCommandIds.forEach((commandId) => {
      if (
        runCommands.statusByCommandId[commandId]?.status === 'running' ||
        runCommands.isCommandStarting(commandId)
      ) {
        stops.push(runCommands.stopCommand(commandId));
      }
    });
    if (prebuildStatus?.status === 'running') {
      stops.push(runCommands.stopCommand(prebuildCommandId));
    }
    if (nativeLogSession && nativeLogStatus === 'running') {
      stops.push(nativeLogs.stop(nativeLogSession.id));
    }
    if (networkSession && networkStatus === 'running') {
      stops.push(networkProxy.stop(networkSession.id));
    }

    await Promise.allSettled(stops);
    setLaunchedIosBuildCommandIds([]);
  }, [
    buildCommandId,
    buildRunning,
    cancelStart,
    devServerCommandId,
    devServerRunning,
    hasActiveSession,
    iosBuildLaunchCoordinator,
    iosBuildCommandIdPrefix,
    launchedIosBuildCommandIds,
    nativeLogSession,
    nativeLogStatus,
    nativeLogs,
    networkProxy,
    networkSession,
    networkStatus,
    platform,
    prebuildCommandId,
    prebuildStatus?.status,
    runCommands,
    setupOperationCoordinator,
    stop,
    setResumeSetupAfterDependenciesInstall,
  ]);
  const handleInstallNetworkCertificate = () => {
    if (!deviceId || !networkProxyParams) return;

    void (async () => {
      try {
        if (networkSession && networkStatus === 'running') {
          await networkProxy.stop(networkSession.id);
        }
        await networkProxy.installCertificate({ platform, deviceId });
        const mitmParams = { ...networkProxyParams, enableMitm: true };
        setEnableNetworkMitm(true);
        await networkProxy.start(mitmParams);
        if (platform === 'android') {
          setAndroidCertGuidanceVisible(true);
        } else {
          showActionNotice('CA installed; HTTPS decrypt enabled');
        }
      } catch (error) {
        setInputNotice(
          formatError(error) ?? 'Failed to install proxy certificate',
        );
      }
    })();
  };
  const handlePrepareAndroidAppTrust = () => {
    if (platform !== 'android' || !networkProxyParams) return;
    if (!effectiveAndroidProjectPath) {
      setInputNotice('Set Android project folder in project settings first');
      return;
    }

    void (async () => {
      try {
        const result = await networkProxy.prepareAndroidAppTrust({
          projectId,
          taskId,
          androidProjectPath: effectiveAndroidProjectPath,
        });
        const editedFiles = result.nativeFiles
          .map((filePath) =>
            filePath.startsWith(projectPath)
              ? filePath.slice(projectPath.length).replace(/^\/+/, '')
              : filePath,
          )
          .join(', ');
        showActionNotice(`${result.message} Edited: ${editedFiles}`);
      } catch (error) {
        setInputNotice(
          formatError(error) ?? 'Failed to prepare Android app trust',
        );
      }
    })();
  };
  const handleRestartAndroidApp = () => {
    if (platform !== 'android' || !deviceId || !effectiveAndroidProjectPath) return;

    void (async () => {
      setIsRestartingAndroidApp(true);
      try {
        const result = await api.mobilePreview.restartAndroidApp({
          projectId,
          taskId,
          androidProjectPath: effectiveAndroidProjectPath,
          deviceId,
        });
        showActionNotice(`${result.packageName} restarted`);
      } catch (error) {
        setInputNotice(formatError(error) ?? 'Failed to restart Android app');
      } finally {
        setIsRestartingAndroidApp(false);
      }
    })();
  };
  const handleRestartIosApp = () => {
    if (platform !== 'ios' || !deviceId || !iosAppStatus?.appInstalled) return;

    void (async () => {
      setIsRestartingIosApp(true);
      try {
        const result = await api.mobilePreview.restartIosApp({
          projectId,
          taskId,
          appPath,
          deviceId,
        });
        showActionNotice(`${result.bundleId} restarted`);
      } catch (error) {
        setInputNotice(formatError(error) ?? 'Failed to restart iOS app');
      } finally {
        setIsRestartingIosApp(false);
      }
    })();
  };
  const networkProxySubtitle = networkSession
    ? `${networkSession.proxyUrl} · HTTPS decrypt ${
        networkSession.enableMitm ? 'on' : 'off'
      }`
    : platform === 'android'
      ? 'Android emulator proxy auto-configured'
      : 'iOS simulator proxy routing automatic';
  const networkPresetCounts = {
    all: displayedNetworkRequests.length,
    errors: displayedNetworkRequests.filter((request) =>
      matchesNetworkPreset(request, 'errors'),
    ).length,
    post: displayedNetworkRequests.filter((request) =>
      matchesNetworkPreset(request, 'post'),
    ).length,
    get: displayedNetworkRequests.filter((request) =>
      matchesNetworkPreset(request, 'get'),
    ).length,
  };
  const handleNetworkRequestContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    request: MobilePreviewNetworkRequest,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const host = getNetworkHostname(request.url);
    const path = getNetworkPath(request.url);
    setNetworkFilterContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: 'Add filter from request',
      subtitle: `${host}${path}`,
      items: [
        { key: 'method', value: request.method.toUpperCase() },
        { key: 'status', value: getNetworkStatusLabel(request).toString() },
        { key: 'host', value: host },
        { key: 'path', value: path },
      ],
    });
  };
  const handleNetworkFacetContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    path: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setNetworkFilterContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: 'Add filter from endpoint',
      subtitle: path,
      items: [{ key: 'path', value: path }],
    });
  };
  const openNetworkFilterContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    trigger: HTMLElement,
  ) => {
    const path = trigger.dataset.networkFilterPath;
    if (path) {
      event.preventDefault();
      event.stopPropagation();
      setNetworkFilterContextMenu({
        x: event.clientX,
        y: event.clientY,
        title: 'Add filter from endpoint',
        subtitle: path,
        items: [{ key: 'path', value: path }],
      });
      return true;
    }

    const requestId = trigger.dataset.networkRequestId;
    const request = visibleNetworkRequests.find(
      (networkRequest) => networkRequest.id === requestId,
    );
    if (!request) return false;

    const host = getNetworkHostname(request.url);
    const requestPath = getNetworkPath(request.url);
    event.preventDefault();
    event.stopPropagation();
    setNetworkFilterContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: 'Add filter from request',
      subtitle: `${host}${requestPath}`,
      items: [
        { key: 'host', value: host },
        { key: 'path', value: requestPath },
      ],
    });
    return true;
  };
  const getNetworkFilterContextTrigger = (target: EventTarget | null) =>
    target instanceof HTMLElement
      ? target.closest<HTMLElement>('[data-network-filter-context]')
      : null;
  const handleNetworkContextMenuCapture = (event: ReactMouseEvent<HTMLElement>) => {
    const trigger = getNetworkFilterContextTrigger(event.target);
    if (!trigger) return;
    pendingNetworkContextMenuRef.current = null;
    openNetworkFilterContextMenu(event, trigger);
  };
  const handleNetworkMouseDownCapture = (event: ReactMouseEvent<HTMLElement>) => {
    const isSecondaryClick = event.button === 2 || (event.button === 0 && event.ctrlKey);
    if (!isSecondaryClick) return;
    const trigger = getNetworkFilterContextTrigger(event.target);
    if (!trigger) return;
    pendingNetworkContextMenuRef.current = trigger;
    suppressNetworkClickRef.current = true;
    window.setTimeout(() => {
      suppressNetworkClickRef.current = false;
    }, 0);
    event.preventDefault();
    event.stopPropagation();
  };
  const handleNetworkMouseUpCapture = (event: ReactMouseEvent<HTMLElement>) => {
    const trigger = pendingNetworkContextMenuRef.current;
    if (!trigger) return;
    pendingNetworkContextMenuRef.current = null;
    openNetworkFilterContextMenu(event, trigger);
  };
  const handleNetworkClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressNetworkClickRef.current) return;
    suppressNetworkClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const networkBody = (
    <div
      ref={networkPanelRef}
      onContextMenuCapture={handleNetworkContextMenuCapture}
      onMouseDownCapture={handleNetworkMouseDownCapture}
      onMouseUpCapture={handleNetworkMouseUpCapture}
      onClickCapture={handleNetworkClickCapture}
      className="relative flex h-full min-h-0 flex-col bg-zinc-950"
    >
      {networkProxy.error || networkSession?.error ? (
        <div className="border-status-fail/40 bg-status-fail/10 text-status-fail border-b px-4 py-2 text-xs">
          {formatError(networkProxy.error) ?? networkSession?.error}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center border-b border-zinc-900/90 bg-zinc-950 px-3 py-1.5">
        <NetworkFilterAutocomplete
          tokens={networkFilter}
          onChange={setNetworkFilter}
          requests={displayedNetworkRequests}
          resultCount={visibleNetworkRequests.length}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-900/90 bg-zinc-950 px-3 py-1">
        <NetworkFilterChip
          label="All"
          count={networkPresetCounts.all}
          active={networkPreset === 'all'}
          onClick={() => setNetworkPreset('all')}
        />
        <NetworkFilterChip
          label="Errors"
          count={networkPresetCounts.errors}
          active={networkPreset === 'errors'}
          tone="danger"
          onClick={() => setNetworkPreset('errors')}
        />
        <NetworkFilterChip
          label="POST"
          count={networkPresetCounts.post}
          active={networkPreset === 'post'}
          onClick={() => setNetworkPreset('post')}
        />
        <NetworkFilterChip
          label="GET"
          count={networkPresetCounts.get}
          active={networkPreset === 'get'}
          tone="success"
          onClick={() => setNetworkPreset('get')}
        />
        <label className="text-ink-3 inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[3px] border border-zinc-800 bg-zinc-900/50 px-2 text-[10px]">
          <input
            type="checkbox"
            checked={showTunneledNetworkRequests}
            onChange={(event) =>
              setShowTunneledNetworkRequests(event.currentTarget.checked)
            }
            className="h-3 w-3"
          />
          Tunnels
        </label>
        <div className="min-w-0 flex-1" />
        <div className="text-ink-4 hidden max-w-[260px] truncate font-mono text-[10px] xl:block">
          {networkProxySubtitle}
        </div>
        <label className="text-ink-3 inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[3px] border border-zinc-800 bg-zinc-900/50 px-2 text-[10px]">
          <input
            type="checkbox"
            checked={enableNetworkMitm && networkCertificateInstalled}
            onChange={(event) =>
              setEnableNetworkMitm(event.currentTarget.checked)
            }
            disabled={
              !!networkSession ||
              !networkCertificateInstalled ||
              networkProxy.isStarting ||
              networkProxy.isStopping
            }
            className="h-3 w-3"
          />
          Decrypt
        </label>
      </div>
      {!networkProxyParams ? (
        <EmptyState
          title="Network capture unavailable"
          detail={
            needsAppSelection ? 'Select an app first' : 'Select a device first'
          }
        />
      ) : networkRequests.length === 0 ? (
        <div className="flex h-full items-center justify-center p-6 text-center">
          <div>
            <div className="text-ink-1 text-sm font-medium">
              No network requests
            </div>
            <div className="text-ink-3 mt-1 max-w-md text-xs">
              {platform === 'ios'
                ? 'Start the proxy, then use the app. Jean-Claude routes iOS simulator traffic through macOS proxy settings until stop.'
                : 'Start the proxy, then use the app. HTTP should show full requests; HTTPS may only show CONNECT tunnels unless the app trusts the Jean-Claude CA.'}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            style={{ width: networkEndpointRailWidth }}
            className="relative hidden shrink-0 flex-col border-r border-zinc-900/90 bg-zinc-950 p-1.5 lg:flex"
          >
            <div
              onMouseDown={handleNetworkEndpointRailMouseDown}
              className={clsx(
                'hover:bg-acc/40 absolute top-0 right-[-2px] z-20 h-full w-1 cursor-col-resize transition-colors',
                isDraggingNetworkEndpointRail && 'bg-acc/50',
              )}
            />
            <div className="text-ink-4 px-2 pt-0.5 pb-1.5 text-[9px] font-semibold tracking-wide uppercase">
              Endpoints
            </div>
            <NetworkFacetButton
              label="All requests"
              count={displayedNetworkRequests.length}
              active={networkFacet === 'all'}
              onClick={() => setNetworkFacet('all')}
            />
            {networkFacets.map((facet) => (
              <NetworkFacetButton
                key={facet.path}
                label={facet.path.replace(/^\/api\//, '')}
                count={facet.count}
                active={networkFacet === facet.path}
                failed={facet.failed}
                onClick={() => setNetworkFacet(facet.path)}
                onContextMenu={(event) =>
                  handleNetworkFacetContextMenu(event, facet.path)
                }
              />
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-auto bg-zinc-950">
            <div className="text-ink-4 sticky top-0 z-10 grid h-[23px] grid-cols-[54px_46px_78px_minmax(0,1fr)] items-center gap-2 border-b border-zinc-900/90 bg-zinc-950 px-2.5 text-[9px] font-semibold tracking-wide uppercase">
              <span>Method</span>
              <span>Status</span>
              <span>Time</span>
              <span>URL</span>
            </div>
            {visibleNetworkRequests.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6 text-center">
                <div>
                  <div className="text-ink-1 text-sm font-medium">
                    {displayedNetworkRequests.length === 0
                      ? 'Only tunnel requests'
                      : 'No matching requests'}
                  </div>
                  <div className="text-ink-3 mt-1 max-w-md text-xs">
                    {displayedNetworkRequests.length === 0
                      ? 'Enable Tunnels to inspect CONNECT rows'
                      : 'Adjust the filter or choose another endpoint'}
                  </div>
                </div>
              </div>
            ) : visibleNetworkRequests.map((request) => {
              const selected = request.id === selectedNetworkRequestId;
              const maxDuration = Math.max(
                1,
                ...displayedNetworkRequests.map(
                  (networkRequest) => networkRequest.durationMs ?? 0,
                ),
              );
              const durationWidth =
                request.durationMs === null
                  ? 0
                  : Math.max(10, (request.durationMs / maxDuration) * 100);
              return (
                <button
                  key={`${request.sessionId}:${request.id}`}
                  type="button"
                  data-network-filter-context="request"
                  data-network-request-id={request.id}
                  className={clsx(
                    'grid h-[26px] w-full grid-cols-[54px_46px_78px_minmax(0,1fr)] items-center gap-2 border-b border-zinc-900/80 px-2.5 text-left transition-colors',
                    selected
                      ? 'bg-acc-soft shadow-[inset_2px_0_0_var(--color-acc)]'
                      : 'hover:bg-zinc-900/70',
                  )}
                  onClick={() => setSelectedNetworkRequestId(request.id)}
                  onContextMenu={(event) =>
                    handleNetworkRequestContextMenu(event, request)
                  }
                  onMouseDown={(event) => {
                    if (event.button === 2) {
                      handleNetworkRequestContextMenu(event, request);
                    }
                  }}
                >
                  <span
                    className={clsx(
                      'font-mono text-[11px] font-semibold',
                      getNetworkMethodClass(request.method),
                    )}
                  >
                    {request.method}
                  </span>
                  <span
                    className={clsx(
                      'font-mono text-[11px] font-semibold',
                      getNetworkStatusClass(request),
                    )}
                  >
                    {getNetworkStatusLabel(request)}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="h-1 w-[26px] overflow-hidden rounded-full bg-zinc-900">
                      <span
                        className={clsx(
                          'block h-full rounded-full',
                          request.error ||
                            (request.status !== null && request.status >= 400)
                            ? 'bg-status-fail'
                            : 'bg-emerald-300',
                        )}
                        style={{ width: `${durationWidth}%` }}
                      />
                    </span>
                    <span className="text-ink-4 font-mono text-[10px]">
                      {request.durationMs === null
                        ? '-'
                        : `${request.durationMs}ms`}
                    </span>
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px]">
                    <span className="text-ink-4">
                      {getNetworkHostname(request.url)}
                    </span>
                    <span className="text-ink-1">
                      {getNetworkPath(request.url)}
                    </span>
                    {request.error ? (
                      <span className="text-status-fail ml-2">
                        {request.error}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          {selectedNetworkRequest ? (
            <NetworkRequestDetails
              request={selectedNetworkRequest}
              onClose={() => setSelectedNetworkRequestId(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );

  const networkProxyError = networkProxy.error || networkSession?.error;
  const appReady = !needsAppSelection;
  const deviceReady =
    !!deviceId && (selectedDeviceCanStart || activeSessionDeviceReady);
  const metroStatus = devServerRunning
    ? 'ready'
    : devServerStarting
      ? 'running'
      : 'idle';
  const previewStatus =
    session?.status === 'streaming'
      ? 'ready'
      : isStarting ||
          session?.status === 'checking-tools' ||
          session?.status === 'starting'
        ? 'running'
        : 'idle';
  const proxyStatus = networkProxyError
    ? 'error'
    : networkStatus === 'running'
      ? 'ready'
      : networkProxy.isStarting
        ? 'running'
        : 'idle';
  const effectiveAndroidProjectPath = androidProjectPath
    ? androidProjectExists === false
      ? null
      : androidProjectPath
    : androidProjectExists === true
      ? inferredAndroidProjectPath
      : null;
  const androidSetupDecision = getMobileAppSetupDecision({
    platform: 'android',
    isExpoApp,
    nativeProjectExists: androidProjectExists,
    appInstalled: androidAppStatus?.appInstalled ?? null,
    appIdentityResolved: !!androidAppStatus?.packageName,
    buildStatus: normalizedBuildStatus,
  });
  const iosSetupDecision = getMobileAppSetupDecision({
    platform: 'ios',
    isExpoApp,
    nativeProjectExists: iosAppStatus?.nativeProjectExists ?? null,
    appInstalled: iosAppStatus?.appInstalled ?? null,
    appIdentityResolved: !!iosAppStatus?.bundleId,
    buildStatus: normalizedBuildStatus,
    statusCheckFailed: !!iosAppStatusError,
  });
  const appSetupDecision =
    platform === 'android' ? androidSetupDecision : iosSetupDecision;
  const needsExpoAndroidPrebuild =
    platform === 'android' && androidSetupDecision.needsPrebuild;
  const needsExpoIosPrebuild = platform === 'ios' && iosSetupDecision.needsPrebuild;
  const needsExpoPrebuild = needsExpoAndroidPrebuild || needsExpoIosPrebuild;
  const prebuildDone =
    platform === 'android'
      ? !!effectiveAndroidProjectPath
      : iosAppStatus?.nativeProjectExists === true;
  const prebuildStatusValue = !needsExpoPrebuild
    ? 'ready'
    : prebuildStarting || prebuildStatus?.status === 'running'
      ? 'running'
      : prebuildStatus?.status === 'errored'
        ? 'error'
        : prebuildDone
          ? 'ready'
          : 'idle';
  const androidAppInstalled = androidAppStatus?.appInstalled === true;
  const androidAppMissing = androidAppStatus?.appInstalled === false;
  const selectedAppInstalled =
    platform === 'android' ? androidAppInstalled : iosSetupDecision.appReady;
  const androidTrustConfigured = !!androidAppStatus?.trustConfigured;
  const androidTrustReady =
    platform !== 'android' || (androidAppInstalled && androidTrustConfigured);
  const httpsStatus =
    proxyStatus === 'error'
      ? 'idle'
      : networkProxy.isInstallingCertificate ||
          networkProxy.isPreparingAndroidAppTrust
        ? 'running'
        : networkStatus === 'running' &&
            networkSession?.enableMitm &&
            networkCertificateInstalled &&
            androidTrustReady
          ? 'ready'
          : platform === 'android' &&
              networkStatus === 'running' &&
              networkSession?.enableMitm &&
              networkCertificateInstalled &&
              !androidTrustReady
            ? 'blocked'
            : 'idle';
  const dependenciesInstallStatusValue =
    dependenciesInstallStatus?.status === 'stopped'
      ? 'completed'
      : dependenciesInstallStatus?.status;
  const setupSteps = [
    {
      key: 'app',
      label: 'App selected',
      status: appReady ? 'ready' : 'blocked',
      detail: appReady ? appPath : 'Choose app first',
      tab: null,
    },
    {
      key: 'dependencies-install',
      label: 'Dependencies installed',
      status:
        dependenciesInstallStatusValue === 'errored'
          ? 'error'
          : dependenciesInstallStatusValue === 'running'
            ? 'running'
            : dependenciesInstallStatusValue === 'completed'
              ? 'ready'
              : 'idle',
      detail:
        dependenciesInstallStatusValue === 'completed'
          ? dependenciesInstallCommand
          : dependenciesInstallStatusValue === 'running'
            ? 'Installing dependencies...'
            : dependenciesInstallStatusValue === 'errored'
              ? 'Dependency install failed; check Metro tab logs'
              : dependenciesInstallCommand,
      tab: 'dev-server' as const,
    },
    {
      key: 'device',
      label: 'Device ready',
      status: deviceReady ? 'ready' : deviceId ? 'blocked' : 'idle',
      detail: selectedDevice
        ? `${selectedDevice.name} · ${formatDeviceState(selectedDevice.state)}`
        : activeSessionDeviceReady
          ? `${deviceId} · active preview session`
        : 'Select booted device',
      tab: null,
    },
    ...((autoStartProxy && needsExpoAndroidPrebuild) || needsExpoIosPrebuild
      ? [
          {
            key: 'prebuild',
            label: `${platform === 'android' ? 'Android' : 'iOS'} project generated`,
            status: prebuildStatusValue,
            detail:
              prebuildStatusValue === 'ready'
                ? `${platform === 'android' ? inferredAndroidProjectPath : `${appPath === '.' ? '' : `${appPath}/`}ios`} · generated`
                : prebuildStatusValue === 'running'
                  ? 'Running expo prebuild...'
                  : prebuildStatusValue === 'error'
                    ? 'Prebuild failed; check Metro tab logs'
                    : `Expo app has no ${platform} folder`,
            tab: 'dev-server' as const,
          },
        ]
      : []),
    ...((platform === 'android' && effectiveAndroidProjectPath) || platform === 'ios'
      ? [
          {
            key: 'install',
            label: 'App installed',
            status: iosAppStatusError
              ? 'error'
              : isIosAppStatusLoading ||
                  normalizedBuildStatus === 'loading' ||
                  buildStarting ||
                  buildRunning
              ? 'running'
              : selectedAppInstalled
              ? 'ready'
              : appSetupDecision.needsBuild
                ? 'blocked'
                : 'idle',
            detail:
              platform === 'android'
                ? androidAppStatus?.packageName
                  ? androidAppInstalled
                    ? `${androidAppStatus.packageName} · installed`
                    : `${androidAppStatus.packageName} · build required`
                  : 'Package id not detected; build optional'
                : iosAppStatus?.bundleId
                  ? iosSetupDecision.appReady
                    ? `${iosAppStatus.bundleId} · installed`
                    : `${iosAppStatus.bundleId} · build required`
                  : isIosAppStatusLoading
                    ? 'Checking simulator app status...'
                    : normalizedBuildStatus === 'loading'
                      ? 'Checking persisted build history...'
                    : iosAppStatusError
                      ? `Status check failed: ${iosAppStatusError}`
                    : iosSetupDecision.buildVerificationFailed
                      ? 'Build completed, but bundle id is still unresolved'
                      : normalizedBuildStatus === 'errored'
                        ? 'Build failed; check iOS build logs'
                        : 'Bundle id not detected; build required',
            tab: 'dev-server' as const,
          },
        ]
      : []),
    {
      key: 'metro',
      label: 'Metro running',
      status: metroStatus,
      detail: devServerRunning
        ? `port ${effectiveDevServerPort} · live`
        : devServerStarting
          ? 'Starting dev server...'
          : 'Not started',
      tab: 'dev-server',
    },
    {
      key: 'preview',
      label: 'Preview streaming',
      status: previewStatus,
      detail: previewMethodText ?? (previewStatus === 'running' ? 'Starting stream...' : 'Not started'),
      tab: null,
    },
    ...(autoStartProxy
      ? [
          {
            key: 'proxy',
            label: 'Proxy running',
            status: proxyStatus,
            detail: networkProxyError
              ? cleanPreviewError(formatError(networkProxyError) ?? 'Proxy failed')
              : networkStatus === 'running'
                ? (networkSession?.proxyUrl ?? 'Proxy live')
                : networkProxy.isStarting
                  ? 'Starting proxy...'
                  : platform === 'android'
                    ? 'Android emulator proxy auto-configured'
                    : 'iOS proxy routing automatic',
            tab: 'network' as const,
          },
          {
            key: 'https',
            label: 'HTTPS decrypt ready',
            status: httpsStatus,
            detail:
              httpsStatus === 'ready'
                ? `${networkStats.total} requests · decrypt on`
                : httpsStatus === 'blocked'
                  ? effectiveAndroidProjectPath
                    ? androidTrustConfigured
                      ? 'Build and install app on device'
                      : 'Rebuild app so debug trust config applies'
                    : 'Set Android project folder in project settings'
                  : httpsStatus === 'running'
                    ? 'Preparing certificate trust...'
                    : !networkCertificateInstalled
                      ? platform === 'android' && androidCertGuidanceVisible
                        ? 'Finish CA install on Android, then restart app'
                        : 'Install CA certificate to decrypt HTTPS'
                      : networkStatus !== 'running'
                        ? 'Start proxy with HTTPS decrypt'
                        : 'Waiting for certificate trust',
            tab: 'network' as const,
          },
        ]
      : []),
  ] as const;
  const readySetupSteps = setupSteps.filter((step) => step.status === 'ready').length;
  const incompleteSetupSteps = setupSteps.filter((step) => step.status !== 'ready');
  const anySetupRunning = setupSteps.some((step) => step.status === 'running');
  const anySetupStopping =
    isStopping ||
    devServerStopping ||
    buildStopping ||
    prebuildStopping ||
    networkProxy.isStopping;
  const canStopSetup = !!(
    hasActiveSession ||
    isStarting ||
    devServerRunning ||
    buildRunning ||
    prebuildStatus?.status === 'running' ||
    (nativeLogSession && nativeLogStatus === 'running') ||
    (networkSession && networkStatus === 'running') ||
    anySetupStopping
  );
  const allSetupReady = readySetupSteps === setupSteps.length;
  const blockedSetupStep = setupSteps.find(
    (step) => step.status === 'blocked' || step.status === 'error',
  );
  const nextSetupStep =
    blockedSetupStep ??
    incompleteSetupSteps.find((step) => step.status !== 'running') ??
    incompleteSetupSteps[0] ??
    null;
  const missingSetupLabels = incompleteSetupSteps
    .filter((step) => step.status !== 'running')
    .map((step) => step.label);
  const missingSetupDetail = missingSetupLabels.length
    ? `Missing: ${missingSetupLabels.join(', ')}.`
    : 'Setup is running.';
  const ctaLabel = allSetupReady
    ? 'Workspace ready'
    : anySetupRunning
      ? 'Starting workspace...'
      : needsAppSelection
        ? 'Continue setup'
        : platform === 'ios' && iosAppStatusError
          ? 'Retry app status'
        : ((autoStartProxy && needsExpoAndroidPrebuild) || needsExpoIosPrebuild) &&
            !prebuildDone
          ? 'Run Expo prebuild'
          : autoStartProxy && proxyStatus === 'error'
            ? 'Restart proxy'
            : autoStartProxy && httpsStatus === 'blocked'
              ? 'Fix Android trust'
              : nextSetupStep?.key === 'https'
                  ? networkCertificateInstalled
                    ? 'Finish HTTPS setup'
                    : 'Install certificate'
              : readySetupSteps > 2
                ? 'Continue setup'
                : 'Start workspace';
  const ctaDisabled = allSetupReady || anySetupRunning || needsAppSelection || !deviceReady;
  const setupHeadline = allSetupReady
    ? 'Workspace ready'
    : nextSetupStep
      ? `Next: ${nextSetupStep.label}`
    : readySetupSteps > 2
      ? 'Resume mobile debug'
      : 'Debug this app end-to-end';
  const setupDetail = allSetupReady
    ? autoStartProxy
      ? 'Preview, Metro, proxy, and HTTPS decrypt are live.'
      : 'Preview and Metro are live. Proxy stays manual.'
    : nextSetupStep
      ? `${nextSetupStep.detail}. ${missingSetupDetail}`
    : autoStartProxy
      ? 'One action starts Metro, preview, proxy, and HTTPS decrypt. Logs stay manual.'
      : 'One action starts Metro and preview. Proxy stays manual.';

  const handleStartWorkspace = useCallback(async ({
    shouldAutoBuildIos,
    shouldPrebuildAndroid,
    shouldPrebuildIos,
  }: {
    shouldAutoBuildIos: boolean;
    shouldPrebuildAndroid: boolean;
    shouldPrebuildIos: boolean;
  }) => {
    if (needsAppSelection || !deviceReady) return;
    const setupCoordinator = setupOperationCoordinator;
    const setupOperation = setupCoordinator.begin(
      getPreviewDeviceKey(platform, deviceId),
    );
      if (!setupOperation) return;

      try {
      if (dependenciesInstallStatusValue !== 'completed') {
        if (dependenciesInstallStatusValue === 'errored') {
          setInputNotice('Dependency install failed; check Metro tab logs');
          return;
        }
        if (dependenciesInstallStatusValue !== 'running') {
          setResumeSetupAfterDependenciesInstall(true);
          await runCommands.startAdHocCommand({
            runCommandId: dependenciesInstallCommandId,
            name: 'Mobile dependencies install',
            command: dependenciesInstallCommand,
            ports: [],
          });
        }
        return;
      }

      const setupEffectiveAndroidProjectPath = androidProjectPath
        ? androidProjectExists === false
          ? null
          : androidProjectPath
        : androidProjectExists === true
          ? inferredAndroidProjectPath
          : null;
      if (
        (autoStartProxy &&
          shouldPrebuildAndroid &&
          !setupEffectiveAndroidProjectPath) ||
        shouldPrebuildIos
      ) {
        setResumeSetupAfterPrebuild(true);
        await runCommands.startAdHocCommand({
          runCommandId: prebuildCommandId,
          name: platform === 'android' ? 'Expo Android prebuild' : 'Expo iOS prebuild',
          command: prebuildCommand,
          ports: [],
        });
        showActionNotice('Expo prebuild started; setup will continue when it finishes');
        return;
      }

      if (!devServerRunning && !devServerStarting) {
        void runCommands.startAdHocCommand({
          runCommandId: devServerCommandId,
          name: 'Mobile dev server',
          command: devServerCommand,
          ports: [configuredDevServerPort],
          availablePort: { provider: 'args' },
        });
      }

      let setupSessionId = session?.id ?? null;
      if (
        hasActiveSession &&
        (!session ||
          session.platform !== platform ||
          session.deviceId !== deviceId)
      ) {
        setupCoordinator.cancel();
        return;
      }
      if (!hasActiveSession) {
        const startedSession = await start({
          projectPath: effectiveProjectPath,
          platform,
          deviceId,
          fps,
          quality,
        });
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        if (
          startedSession.platform !== platform ||
          startedSession.deviceId !== deviceId ||
          startedSession.status === 'stopped'
        ) {
          setupCoordinator.cancel();
          return;
        }
        setupSessionId = startedSession.id;
      }

      if (
        !setupSessionId ||
        !setupCoordinator.bindSession(setupOperation, setupSessionId)
      ) {
        return;
      }

      if (platform === 'ios') {
        const frameResult = await setupCoordinator.waitForFrame(
          setupOperation,
          setupSessionId,
          FIRST_PREVIEW_FRAME_SETUP_WAIT_MS,
        );
        if (
          frameResult === 'cancelled' ||
          !setupCoordinator.isCurrent(setupOperation)
        ) {
          return;
        }
      }

      if (!setupCoordinator.isCurrent(setupOperation)) return;
      if (
        platform === 'ios' &&
        shouldAutoBuildIos &&
        buildCommand &&
        !buildRunning &&
        !buildStarting
      ) {
        setLaunchedIosBuildCommandIds((current) =>
          current.includes(buildCommandId) ? current : [...current, buildCommandId],
        );
        setActiveConsoleCommandId(buildCommandId);
        void iosBuildLaunchCoordinator.launch({
          commandId: buildCommandId,
          start: () =>
            runCommands.startAdHocCommand({
              runCommandId: buildCommandId,
              name: 'iOS build',
              command: buildCommand,
              ports: [],
            }),
          stop: runCommands.stopCommand,
        });
      }

      if (!autoStartProxy) {
        if (
          platform === 'android' &&
          setupEffectiveAndroidProjectPath &&
          androidAppMissing &&
          buildCommand &&
          !buildRunning &&
          !buildStarting
        ) {
          setActiveConsoleCommandId(buildCommandId);
          void runCommands.startAdHocCommand({
            runCommandId: buildCommandId,
            name: 'Android build',
            command: buildCommand,
            ports: [],
          });
        }
        return;
      }

      if (platform === 'android' && !setupEffectiveAndroidProjectPath) {
        if (shouldPrebuildAndroid) {
          setResumeSetupAfterPrebuild(true);
          await runCommands.startAdHocCommand({
            runCommandId: prebuildCommandId,
            name: 'Expo Android prebuild',
            command: prebuildCommand,
            ports: [],
          });
          showActionNotice('Expo prebuild started; setup will continue when it finishes');
        } else {
          setInputNotice('Checking Android project folder before proxy setup');
        }
        return;
      }

      if (!networkProxyParams) return;
      if (!setupCoordinator.isCurrent(setupOperation)) return;

      if (proxyStatus === 'error' && networkSession) {
        await networkProxy.stop(networkSession.id);
        if (!setupCoordinator.isCurrent(setupOperation)) return;
      }

      if (!networkCertificateInstalled) {
        if (networkSession && networkStatus === 'running') {
          await networkProxy.stop(networkSession.id);
          if (!setupCoordinator.isCurrent(setupOperation)) return;
        }
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        await networkProxy.installCertificate({ platform, deviceId });
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        setEnableNetworkMitm(true);
        if (platform === 'android') {
          setAndroidCertGuidanceVisible(true);
        }
        await networkProxy.start({ ...networkProxyParams, enableMitm: true });
      } else if (networkStatus !== 'running') {
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        setEnableNetworkMitm(true);
        await networkProxy.start({ ...networkProxyParams, enableMitm: true });
      } else if (networkSession && !networkSession.enableMitm) {
        await networkProxy.stop(networkSession.id);
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        setEnableNetworkMitm(true);
        await networkProxy.start({ ...networkProxyParams, enableMitm: true });
      }

      if (!setupCoordinator.isCurrent(setupOperation)) return;
      if (
        platform === 'android' &&
        setupEffectiveAndroidProjectPath &&
        !androidTrustConfigured
      ) {
        const trustResult = await networkProxy.prepareAndroidAppTrust({
          projectId,
          taskId,
          androidProjectPath: setupEffectiveAndroidProjectPath,
        });
        if (!setupCoordinator.isCurrent(setupOperation)) return;
        setAndroidAppStatus((current) =>
          current
            ? { ...current, trustConfigured: true }
            : {
                appInstalled: null,
                packageName: null,
                trustConfigured: true,
              },
        );

        if (
          buildCommand &&
          !buildRunning &&
          !buildStarting &&
          (trustResult.changed || androidAppMissing)
        ) {
          setActiveConsoleCommandId(buildCommandId);
          void runCommands.startAdHocCommand({
            runCommandId: buildCommandId,
            name: 'Android build',
            command: buildCommand,
            ports: [],
          });
        }
      } else if (
        platform === 'android' &&
        setupEffectiveAndroidProjectPath &&
        androidAppMissing &&
        buildCommand &&
        !buildRunning &&
        !buildStarting
      ) {
        setActiveConsoleCommandId(buildCommandId);
        void runCommands.startAdHocCommand({
          runCommandId: buildCommandId,
          name: 'Android build',
          command: buildCommand,
          ports: [],
        });
      }
    } catch (error) {
      if (setupCoordinator.isCurrent(setupOperation)) {
        setInputNotice(formatError(error) ?? 'Workspace setup failed');
      }
    } finally {
      setupCoordinator.complete(setupOperation);
    }
  }, [
    buildCommand,
    buildCommandId,
    buildRunning,
    buildStarting,
    androidAppMissing,
    androidProjectExists,
    androidTrustConfigured,
    autoStartProxy,
    devServerCommand,
    devServerCommandId,
    configuredDevServerPort,
    dependenciesInstallCommand,
    dependenciesInstallCommandId,
    dependenciesInstallStatusValue,
    devServerRunning,
    devServerStarting,
    deviceId,
    deviceReady,
    effectiveProjectPath,
    fps,
    hasActiveSession,
    androidProjectPath,
    inferredAndroidProjectPath,
    iosBuildLaunchCoordinator,
    needsAppSelection,
    networkCertificateInstalled,
    networkProxy,
    networkProxyParams,
    networkSession,
    networkStatus,
    platform,
    prebuildCommand,
    prebuildCommandId,
    projectId,
    proxyStatus,
    quality,
    runCommands,
    session,
    showActionNotice,
    start,
    setupOperationCoordinator,
    taskId,
  ]);

  useEffect(() => {
    const deferredAction = getDependencyInstallDeferredAction({
      resumeRequested: resumeSetupAfterDependenciesInstall,
      status: dependenciesInstallStatusValue,
    });
    if (deferredAction === 'none') return;
    queueMicrotask(() => {
      setResumeSetupAfterDependenciesInstall(false);
      if (deferredAction === 'error') {
        setInputNotice('Dependency install failed; check Metro tab logs');
        return;
      }
      void handleStartWorkspace({
        shouldAutoBuildIos: iosSetupDecision.shouldAutoBuild,
        shouldPrebuildAndroid: needsExpoAndroidPrebuild,
        shouldPrebuildIos: needsExpoIosPrebuild,
      });
    });
  }, [
    dependenciesInstallStatusValue,
    handleStartWorkspace,
    iosSetupDecision.shouldAutoBuild,
    needsExpoAndroidPrebuild,
    needsExpoIosPrebuild,
    resumeSetupAfterDependenciesInstall,
  ]);

  useEffect(() => {
    const deferredAction = getDeferredSetupAction({
      resumeRequested: resumeSetupAfterPrebuild,
      prebuildStatus: normalizedPrebuildStatus,
      prebuildDone,
    });
    if (deferredAction === 'none') return;
    if (deferredAction === 'error') {
      queueMicrotask(() => {
        setResumeSetupAfterPrebuild(false);
        setInputNotice('Expo prebuild failed; check Metro tab logs');
      });
      return;
    }
    queueMicrotask(() => {
      setResumeSetupAfterPrebuild(false);
      void handleStartWorkspace({
        shouldAutoBuildIos: iosSetupDecision.shouldAutoBuild,
        shouldPrebuildAndroid: needsExpoAndroidPrebuild,
        shouldPrebuildIos: needsExpoIosPrebuild,
      });
    });
  }, [
    handleStartWorkspace,
    prebuildDone,
    normalizedPrebuildStatus,
    iosSetupDecision.shouldAutoBuild,
    needsExpoAndroidPrebuild,
    needsExpoIosPrebuild,
    resumeSetupAfterPrebuild,
  ]);

  function getSetupStepAction(stepKey: (typeof setupSteps)[number]['key']) {
    if (stepKey === 'dependencies-install') {
      return {
        label:
          dependenciesInstallStatusValue === 'running' ? 'Stop' : 'Run',
        onClick: () => {
          if (dependenciesInstallStatusValue === 'running') {
            setResumeSetupAfterDependenciesInstall(false);
            void runCommands.stopCommand(dependenciesInstallCommandId);
            return;
          }
          setResumeSetupAfterDependenciesInstall(false);
          void runCommands.startAdHocCommand({
            runCommandId: dependenciesInstallCommandId,
            name: 'Mobile dependencies install',
            command: dependenciesInstallCommand,
            ports: [],
          });
        },
        disabled: runCommands.isCommandStarting(dependenciesInstallCommandId),
        loading: runCommands.isCommandStarting(dependenciesInstallCommandId),
        variant: dependenciesInstallStatusValue === 'running' ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'prebuild') {
      return {
        label: prebuildStatus?.status === 'running' ? 'Stop' : 'Run',
        onClick: handleStartStopPrebuild,
        disabled: prebuildStarting,
        loading: prebuildStarting,
        variant: prebuildStatus?.status === 'running' ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'install') {
      if (platform === 'ios' && iosAppStatusError) {
        return {
          label: 'Retry',
          onClick: () => setIosAppStatusRefreshNonce((current) => current + 1),
          disabled: isIosAppStatusLoading,
          loading: isIosAppStatusLoading,
          variant: 'primary',
        } as const;
      }
      return {
        label: buildRunning
          ? 'Stop'
          : selectedAppInstalled || normalizedBuildStatus === 'completed'
            ? 'Rebuild'
            : 'Build',
        onClick: handleStartStopBuild,
          disabled:
            !buildCommand ||
            needsAppSelection ||
            (platform === 'ios' && !deviceId) ||
            normalizedBuildStatus === 'loading' ||
            buildStarting ||
            buildStopping,
        loading: buildStarting || buildStopping,
        variant: buildRunning ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'metro') {
      return {
        label: devServerRunning ? 'Stop' : 'Start',
        onClick: handleStartStopDevServer,
        disabled: needsAppSelection || devServerStarting || devServerStopping,
        loading: devServerStarting || devServerStopping,
        variant: devServerRunning ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'preview') {
      return {
        label: hasActiveSession ? 'Stop' : 'Start',
        onClick: handleStartStop,
        disabled:
          isStopping ||
          (!hasActiveSession &&
            (!deviceId || !deviceReady || isStarting || needsAppSelection)),
        loading: isStarting || isStopping,
        variant: hasActiveSession ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'logs') {
      return {
        label: nativeLogSession && nativeLogStatus === 'running' ? 'Stop' : 'Start',
        onClick: handleStartStopNativeLogs,
        disabled: !deviceId || nativeLogs.isStarting || nativeLogs.isStopping,
        loading: nativeLogs.isStarting || nativeLogs.isStopping,
        variant:
          nativeLogSession && nativeLogStatus === 'running' ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'proxy') {
      return {
        label: networkSession && networkStatus === 'running' ? 'Stop' : 'Start',
        onClick: handleStartStopNetworkProxy,
        disabled:
          !networkProxyStartParams ||
          networkProxy.isStarting ||
          networkProxy.isStopping ||
          networkProxy.isInstallingCertificate,
        loading: networkProxy.isStarting || networkProxy.isStopping,
        variant:
          networkSession && networkStatus === 'running' ? 'secondary' : 'primary',
      } as const;
    }
    if (stepKey === 'https') {
      return {
        label:
          platform === 'android' && !androidTrustConfigured ? 'Trust app' : 'Install cert',
        onClick:
          platform === 'android' && !androidTrustConfigured
            ? handlePrepareAndroidAppTrust
            : handleInstallNetworkCertificate,
        disabled:
          !deviceId ||
          !networkProxyStartParams ||
          networkProxy.isInstallingCertificate ||
          networkProxy.isPreparingAndroidAppTrust ||
          networkProxy.isStarting ||
          networkProxy.isStopping,
        loading:
          networkProxy.isInstallingCertificate ||
          networkProxy.isPreparingAndroidAppTrust,
        variant: 'secondary',
      } as const;
    }
    return null;
  }

  const setupBody = (
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
                setIosAppStatusRefreshNonce((current) => current + 1);
                return;
              }
              void handleStartWorkspace({
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
            onClick={() => void handleStopAll()}
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
          const action = getSetupStepAction(step.key);
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
                {step.detail}
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
            onClick={handleRestartIosApp}
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
              onClick={() => setAndroidCertGuidanceVisible(false)}
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
              onClick={handleRestartAndroidApp}
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

  const devToolsResult = reactNativeDevTools.data ?? null;
  const devToolsTargets = devToolsResult?.targets ?? [];
  const devToolsTarget =
    devToolsTargets.find((target) => target.id === selectedDevToolsTargetId) ??
    devToolsTargets.at(-1) ??
    null;
  const devToolsFrontendUrl =
    devToolsTarget?.devtoolsFrontendUrl ?? devToolsResult?.frontendUrl ?? null;
  const devToolsViewId = `rn-devtools:${taskId}`;
  const handleDevToolsTargetMenuOpenChange = useCallback(
    (open: boolean) => {
      devToolsTargetMenuOpenRef.current = open;
      void api.mobilePreview
        .setEmbeddedReactNativeDevToolsVisibility({
          viewId: devToolsViewId,
          visible: !open,
        })
        .catch((error) => {
          setDevToolsLaunchError(formatError(error) ?? String(error));
        });
    },
    [devToolsViewId],
  );
  const devToolsError =
    devToolsLaunchError ??
    formatError(reactNativeDevTools.error) ??
    devToolsResult?.error ??
    null;
  const updateEmbeddedDevToolsBounds = useCallback(() => {
    const element = devToolsViewRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    void api.mobilePreview
      .setEmbeddedReactNativeDevToolsBounds({
        viewId: devToolsViewId,
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      })
      .catch((error) => {
        setDevToolsLaunchError(formatError(error) ?? String(error));
      });
  }, [devToolsViewId]);

  useEffect(() => {
    if (activeTab !== 'devtools' || !devToolsFrontendUrl) {
      void api.mobilePreview.closeEmbeddedReactNativeDevTools({
        viewId: devToolsViewId,
      });
      return;
    }

    const element = devToolsViewRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const requestId = devToolsOpenRequestRef.current + 1;
    devToolsOpenRequestRef.current = requestId;
    setDevToolsLaunchError(null);
    void api.mobilePreview
      .openEmbeddedReactNativeDevTools({
        viewId: devToolsViewId,
        frontendUrl: devToolsFrontendUrl,
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      })
      .then(() => {
        if (devToolsOpenRequestRef.current !== requestId) return;
        return api.mobilePreview.setEmbeddedReactNativeDevToolsVisibility({
          viewId: devToolsViewId,
          visible: !devToolsTargetMenuOpenRef.current,
        });
      })
      .catch((error) => {
        if (devToolsOpenRequestRef.current !== requestId) return;
        setDevToolsLaunchError(formatError(error) ?? String(error));
      });

    const resizeObserver = new ResizeObserver(updateEmbeddedDevToolsBounds);
    resizeObserver.observe(element);
    window.addEventListener('resize', updateEmbeddedDevToolsBounds);

    return () => {
      devToolsOpenRequestRef.current += 1;
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateEmbeddedDevToolsBounds);
      void api.mobilePreview.closeEmbeddedReactNativeDevTools({
        viewId: devToolsViewId,
      });
    };
  }, [
    activeTab,
    devToolsFrontendUrl,
    devToolsViewId,
    updateEmbeddedDevToolsBounds,
  ]);

  const devToolsBody = (
    <div className="bg-bg-0 flex h-full min-h-0 flex-col">
      <div className="border-line bg-bg-1 flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-ink-1 text-sm font-medium">React Native DevTools</div>
          <div className="text-ink-3 truncate text-xs">
            Metro {devToolsResult?.metroBaseUrl ?? `http://localhost:${effectiveDevServerPort}`} · Console
          </div>
          <div className="text-ink-4 mt-1 font-mono text-[10px]">
            {devToolsTargets.length} target
            {devToolsTargets.length === 1 ? '' : 's'}
          </div>
        </div>
        {devToolsTargets.length > 1 ? (
          <Select
            value={devToolsTarget?.id ?? ''}
            options={devToolsTargets.map((target) => ({
              value: target.id,
              label: target.title || target.deviceName || target.id,
              description: target.deviceName ?? target.appId ?? undefined,
            }))}
            onChange={setSelectedDevToolsTargetId}
            onOpenChange={handleDevToolsTargetMenuOpenChange}
            className="max-w-[260px]"
          />
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          loading={reactNativeDevTools.isFetching}
          onClick={() => void reactNativeDevTools.refetch()}
        >
          Refresh
        </Button>
      </div>
      {devToolsError ? (
        <div className="border-status-warn/30 bg-status-warn/10 text-status-warn border-b px-3 py-1.5 text-xs">
          {cleanPreviewError(devToolsError)}
        </div>
      ) : null}
      {reactNativeDevTools.isLoading ? (
        <EmptyState title="Finding DevTools target" detail="Checking Metro inspector" />
      ) : devToolsFrontendUrl ? (
        <div className="bg-bg-0 min-h-0 flex-1">
          <div
            ref={devToolsViewRef}
            className="bg-bg-0 h-full min-h-[360px] w-full"
          />
        </div>
      ) : (
        <EmptyState
          title="No RN DevTools target"
          detail="Start Metro, launch app, make sure Hermes debug build is running"
        />
      )}
    </div>
  );

  const visibleActiveTab = getVisibleMobilePreviewPaneTab({
    tab: activeTab,
    networkEnabled: autoStartProxy,
  });
  const inspectorBody =
    visibleActiveTab === 'setup'
      ? setupBody
      : visibleActiveTab === 'dev-server'
      ? devServerBody
      : visibleActiveTab === 'network'
        ? networkBody
        : visibleActiveTab === 'devtools'
          ? devToolsBody
        : logsBody;

  let body = null;
  if (fatalSessionError) {
    body = <PreviewErrorState message={fatalSessionError} />;
  } else if (session?.frameFormat === 'raw-rgba') {
    body = (
      <div className="flex h-full flex-col bg-zinc-950">
        <div
          ref={containerRef}
          tabIndex={0}
          role="application"
          aria-label="Mobile preview input area"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          className="focus-visible:ring-acc relative min-h-0 flex-1 touch-none outline-none focus-visible:ring-2"
        >
          {inputPreparingOverlay}
          <RawRgbaPreviewCanvas
            sessionId={session.id}
            width={session.width ?? 0}
            height={session.height ?? 0}
            subscribeH264Chunks={subscribeH264Chunks}
            onFrameRendered={handlePreviewFrameRendered}
            surfaceStyle={previewSurfaceStyle}
          />
          <GestureFeedbackOverlay
            key={gestureFeedback?.id ?? 0}
            feedback={gestureFeedback}
          />
        </div>
      </div>
    );
  } else if (session?.frameFormat === 'h264') {
    body = (
      <div className="flex h-full flex-col bg-zinc-950">
        <div
          ref={containerRef}
          tabIndex={0}
          role="application"
          aria-label="Mobile preview input area"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          className="focus-visible:ring-acc relative min-h-0 flex-1 touch-none outline-none focus-visible:ring-2"
        >
          {inputPreparingOverlay}
          <H264PreviewCanvas
            sessionId={session.id}
            width={null}
            height={null}
            subscribeH264Chunks={subscribeH264Chunks}
            onFpsChange={setH264Fps}
            onFrameRendered={handlePreviewFrameRendered}
            surfaceStyle={previewSurfaceStyle}
          />
          <GestureFeedbackOverlay
            key={gestureFeedback?.id ?? 0}
            feedback={gestureFeedback}
          />
        </div>
      </div>
    );
  } else if (frameUrl) {
    body = (
      <div className="flex h-full flex-col bg-zinc-950">
        <div
          ref={containerRef}
          tabIndex={0}
          role="application"
          aria-label="Mobile preview input area"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          className="focus-visible:ring-acc relative flex min-h-0 flex-1 touch-none items-center justify-center p-4 outline-none focus-visible:ring-2"
        >
          {inputPreparingOverlay}
          <img
            ref={imgRef}
            src={frameUrl}
            alt="Mobile preview"
            onLoad={() => {
              if (session) {
                notifyImageFrameRendered(handlePreviewFrameRendered, session.id);
              }
            }}
            draggable={false}
            className="max-h-full max-w-full rounded-xl shadow-2xl select-none"
            style={previewSurfaceStyle}
          />
          <GestureFeedbackOverlay
            key={gestureFeedback?.id ?? 0}
            feedback={gestureFeedback}
          />
        </div>
      </div>
    );
  } else if (needsAppSelection) {
    body = (
      <div className="flex h-full items-center justify-center p-6">
        <div className="border-border/70 bg-bg-1/70 w-full max-w-[420px] rounded-xl border p-4">
          <div className="text-ink-1 text-sm font-semibold">
            Choose mobile app
          </div>
          <div className="text-ink-3 mt-1 text-xs">
            Multiple mobile apps detected. Choose one in Setup → Project app.
          </div>
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => setActiveTab('setup')}>
            Open Setup
          </Button>
        </div>
      </div>
    );
  } else if (displayError) {
    body = <PreviewErrorState message={displayError} />;
  } else if (
    isStarting ||
    session?.status === 'checking-tools' ||
    session?.status === 'starting'
  ) {
    body = (
      <EmptyState
        title="Starting preview..."
        detail="Preparing simulator stream"
      />
    );
  } else if (session?.status === 'streaming') {
    body = (
      <EmptyState
        title="Waiting for first frame..."
        detail={getWaitingForFrameDetail(session.streamStrategy)}
      />
    );
  } else if (session?.status === 'stopped') {
    body = (
      <EmptyState title="Preview stopped" detail="Start again when ready" />
    );
  } else if (devicesErrorMessage) {
    body = (
      <EmptyState
        title="Unable to load devices"
        detail={`${devicesErrorMessage}. ${
          platform === 'ios'
            ? 'Install Xcode Command Line Tools and create an iOS simulator.'
            : 'Install Android Platform Tools and connect or boot an Android device.'
        }`}
      />
    );
  } else if (!deviceId) {
    body = (
      <EmptyState
        title={isLoadingDevices ? 'Loading devices...' : 'No device selected'}
        detail={
          isLoadingDevices ? undefined : 'Select or connect a simulator device'
        }
      />
    );
  } else if (!selectedDeviceCanStart) {
    body = (
      <EmptyState
        title="Device not ready"
        detail="Select a booted or shutdown simulator device"
      />
    );
  } else {
    body = (
      <EmptyState
        title="Preview idle"
        detail="Start preview to stream device frames"
      />
    );
  }

  const orderedDevices = [...visibleDevices].sort((firstDevice, secondDevice) => {
    if (firstDevice.state === 'booted' && secondDevice.state !== 'booted') {
      return -1;
    }
    if (secondDevice.state === 'booted' && firstDevice.state !== 'booted') {
      return 1;
    }
    if (firstDevice.platform !== secondDevice.platform) {
      return firstDevice.platform === 'android' ? -1 : 1;
    }
    return firstDevice.name.localeCompare(secondDevice.name);
  });
  const standaloneLayout = getMobilePreviewStandaloneLayoutClasses({
    isStandalone,
    isInspectorOpen: isStandaloneInspectorOpen,
  });

  return (
    <div
      style={isStandalone ? undefined : { width }}
      className={clsx(
        'bg-bg-0 relative flex h-full min-w-0 flex-col overflow-hidden',
        isStandalone ? 'w-full' : 'panel-edge-shadow',
      )}
    >
      {!isStandalone ? (
        <div
          onMouseDown={handleMouseDown}
          className={clsx(
            'hover:bg-acc/50 absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors',
            isDragging && 'bg-acc/50',
          )}
        />
      ) : null}
      {inputNotice ? (
        <div className="border-status-fail/30 bg-status-fail/10 text-status-fail flex items-start gap-2 border-b px-3 py-2 font-mono text-[11px]">
          <span className="min-w-0 flex-1">{inputNotice}</span>
          <button
            type="button"
            className="text-status-fail/70 hover:text-status-fail shrink-0"
            aria-label="Dismiss notice"
            onClick={() => setInputNotice(null)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {autoPreviewStartError ? (
        <div
          className="border-status-fail/30 bg-status-fail/10 text-status-fail flex items-center gap-2 border-b px-3 py-1.5 font-mono text-[10.5px]"
          role="alert"
        >
          <span className="min-w-0 flex-1">{autoPreviewStartError}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={retryAutoPreviewStart}
          >
            Retry preview
          </Button>
        </div>
      ) : null}
      {runtimeLaunchState.status !== 'idle' ? (
        <div
          className={clsx(
            'border-b px-3 py-1.5 font-mono text-[10.5px]',
            runtimeLaunchState.status === 'error'
              ? 'border-status-fail/30 bg-status-fail/10 text-status-fail'
              : runtimeLaunchState.status === 'ready'
                ? 'border-status-done/25 bg-status-done-soft text-status-done'
                : runtimeLaunchState.status === 'unsupported'
                  ? 'border-status-warn/30 bg-status-warn/10 text-status-warn'
                  : 'border-line-soft bg-bg-1 text-ink-3',
          )}
          role={runtimeLaunchState.status === 'error' ? 'alert' : 'status'}
        >
          <div className="flex items-center gap-2">
            {runtimeLaunchState.status === 'launching' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : null}
            <span className="min-w-0 flex-1">{runtimeLaunchState.message}</span>
            {runtimeLaunchState.status === 'error' ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setRuntimeLaunchRetry((value) => value + 1)}
              >
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {actionTray}
      {networkFilterContextMenu ? (
        <NetworkFilterContextMenu
          state={networkFilterContextMenu}
          onAddFilter={(token) =>
            setNetworkFilter((currentTokens) =>
              appendNetworkFilterToken(currentTokens, token),
            )
          }
          onClose={() => setNetworkFilterContextMenu(null)}
        />
      ) : null}

      <div
        className={clsx(
          'flex min-h-0 flex-1 overflow-hidden',
          standaloneLayout.content,
        )}
      >
        <aside
          style={
            {
              '--device-rail-width': `${deviceRailWidth}px`,
            } as CSSProperties
          }
          className={clsx(
            'border-line bg-bg-0 relative flex w-[var(--device-rail-width)] shrink-0 flex-col border-r',
            standaloneLayout.deviceRail,
          )}
        >
          <div
            onMouseDown={handleDeviceRailMouseDown}
            className={clsx(
              'hover:bg-acc/40 absolute top-0 right-[-2px] z-20 h-full w-1 cursor-col-resize transition-colors',
              isDraggingDeviceRail && 'bg-acc/50',
              standaloneLayout.deviceRailResizeHandle,
            )}
          />
          <div className="border-line flex h-[38px] shrink-0 items-center gap-2 border-b px-2">
            <Terminal className="text-ink-3 size-3.5" />
            <span className="text-ink-1 flex-1 text-xs font-semibold">Devices</span>
            <IconButton
              onClick={() => setIsManageDevicesOpen(true)}
              size="sm"
              icon={<Settings />}
              tooltip="Manage visible devices"
            />
          </div>
          <div
            className={clsx(
              'min-h-0 flex-1 overflow-y-auto p-1.5',
              standaloneLayout.deviceList,
            )}
          >
            {devicesErrorMessage ? (
              <div className="text-status-fail p-2 text-xs">{devicesErrorMessage}</div>
            ) : isLoadingDevices ? (
              <div className="text-ink-4 p-2 text-xs">Loading devices...</div>
            ) : allDevices.length === 0 ? (
              <div className="text-ink-4 p-2 text-xs">No devices</div>
            ) : orderedDevices.length === 0 ? (
              <div className="text-ink-4 p-2 text-xs">No visible devices. Use cog to add one.</div>
            ) : (
              <div className={clsx('mb-1.5', standaloneLayout.deviceGroup)}>
                <div className="text-ink-4 px-2 py-1 text-[9px] font-semibold tracking-wide uppercase">
                  Saved devices
                </div>
                {orderedDevices.map((device) => {
                  const selected =
                    device.id === deviceId && device.platform === platform;
                  const deviceKey = getPreviewDeviceKey(
                    device.platform,
                    device.id,
                  );
                  const previewActive =
                    activeSessionDeviceKeys.has(deviceKey) ||
                    (selectedPreviewDeviceKey === deviceKey &&
                      (isStarting || activeSessionDeviceReady));
                  return (
                    <button
                      key={device.id}
                      type="button"
                      onClick={() => handleSelectDevice(device)}
                      className={clsx(
                        'grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors',
                        standaloneLayout.deviceButton,
                        selected
                          ? 'bg-acc-soft shadow-[inset_2px_0_0_var(--color-acc)]'
                          : 'hover:bg-bg-2',
                      )}
                    >
                      <span
                        className={clsx(
                          'h-[7px] w-[7px] rounded-full',
                          device.state === 'booted'
                            ? 'bg-emerald-300 shadow-[0_0_7px_var(--color-status-done)]'
                            : 'bg-ink-4',
                        )}
                      />
                      <span className="min-w-0">
                        <span className="text-ink-1 block truncate text-[12px] font-medium">
                          {device.name}
                        </span>
                        <span className="text-ink-4 block truncate font-mono text-[10px]">
                          {device.osVersion ?? formatDeviceState(device.state)}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        {previewActive ? (
                          <span
                            aria-label="Preview active"
                            className="bg-status-done size-1.5 animate-pulse rounded-full shadow-[0_0_7px_var(--color-status-done)]"
                            title="Preview active"
                          />
                        ) : null}
                        <PlatformLogo platform={device.platform} />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <main
          className={clsx(
            'bg-bg-0 flex min-w-0 flex-1 flex-col',
            standaloneLayout.preview,
          )}
        >
          <div className="border-line-soft flex h-[38px] shrink-0 items-center gap-1 border-b px-3">
            <Button variant="ghost" size="sm" disabled={!isRunning}>
              Reload
            </Button>
            <Button variant="ghost" size="sm" icon={<Copy />} disabled={!frameUrl}>
              Screenshot
            </Button>
            <span className="bg-border mx-1 h-4 w-px" />
            <IconButton
              onClick={() => handleRotateButton('left')}
              disabled={!isRunning || isRotating}
              size="sm"
              icon={<RotateCcw />}
              tooltip="Rotate left"
            />
            <IconButton
              onClick={() => handleRotateButton('right')}
              disabled={!isRunning || isRotating}
              size="sm"
              icon={<RotateCw />}
              tooltip="Rotate right"
            />
            <div className="min-w-0 flex-1" />
            {isStandalone ? (
              <IconButton
                className={standaloneLayout.inspectorToggle}
                size="sm"
                icon={<PanelRight />}
                tooltip="Toggle inspector"
                aria-expanded={isStandaloneInspectorOpen}
                aria-controls="mobile-preview-inspector"
                onClick={() =>
                  setIsStandaloneInspectorOpen((value) => !value)
                }
              />
            ) : null}
            <span className="text-ink-4 font-mono text-[10px]">
              {previewMethodText ?? 'stream idle'}
              {previewFpsText ? ` · ${previewFpsText}` : ''}
            </span>
            <Dropdown
              trigger={<IconButton size="sm" icon={<MoreHorizontal />} tooltip="More" />}
              align="right"
              dropdownRef={mobileActionsMenuRef}
              className="min-w-64"
            >
              <div className="px-3 py-2">
                <div className="text-ink-4 mb-1 text-[10px] font-semibold tracking-wide uppercase">
                  Preview
                </div>
                <div className="grid gap-2">
                  <label className="grid gap-1">
                    <span className="text-ink-3 text-xs">FPS</span>
                    <Select
                      value={String(fps)}
                      options={FPS_OPTIONS}
                      onChange={(value) => setFps(Number(value))}
                      disabled={hasActiveSession}
                      size="sm"
                      className="w-full"
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-ink-3 text-xs">Quality</span>
                    <Select
                      value={quality}
                      options={QUALITY_OPTIONS}
                      onChange={(value) => setQuality(value as MobilePreviewQuality)}
                      disabled={hasActiveSession}
                      size="sm"
                      className="w-full"
                    />
                  </label>
                </div>
              </div>
              <DropdownDivider />
              <DropdownItem
                icon={showGestures ? <Check /> : <MousePointer2 />}
                onClick={() => setShowGestures(!showGestures)}
              >
                Show gestures
              </DropdownItem>
              <DropdownDivider />
              <DropdownItem icon={copiedDeviceId ? <Check /> : <Copy />} onClick={() => void handleCopyDeviceId()}>
                Copy Device UUID
              </DropdownItem>
              <DropdownItem icon={<Link />} onClick={handleShowDeeplinkAction}>
                Open Deeplink
              </DropdownItem>
              {platform === 'android' ? (
                <DropdownItem icon={<Route />} onClick={() => setActiveAction('port')}>
                  Forward Port
                </DropdownItem>
              ) : null}
              <DropdownItem icon={<Type />} onClick={() => setActiveAction('text-size')}>
                Text Size
              </DropdownItem>
            </Dropdown>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
          <div className="border-line-soft bg-bg-0 flex h-[50px] shrink-0 items-center justify-center gap-2 border-t">
            <Button variant="ghost" size="sm" onClick={handleHomeButton} disabled={!isRunning || isInputPreparing}>
              Home
            </Button>
            <Button variant="ghost" size="sm" onClick={handleBackButton} disabled={!isRunning || isInputPreparing}>
              Back
            </Button>
            <span className="bg-border mx-1 h-5 w-px" />
            <Button
              variant="ghost"
              size="sm"
              icon={<Keyboard />}
              onClick={handleShowKeyboardButton}
              disabled={!isRunning || isInputPreparing}
            >
              Keyboard
            </Button>
          </div>
          <div className="text-ink-4 border-line-soft shrink-0 border-t py-1.5 text-center text-[11px]">
            Click to tap · drag to swipe · hold to long-press · scroll to flick · type to send text · Esc → Back
          </div>
        </main>

        <aside
          id="mobile-preview-inspector"
          style={{ width: inspectorPaneWidth, maxWidth: '100%' }}
          className={clsx(
            'border-line bg-bg-1 relative flex shrink-0 flex-col border-l',
            standaloneLayout.inspector,
          )}
        >
          <div
            onMouseDown={handleInspectorPaneMouseDown}
            className={clsx(
              'hover:bg-acc/40 absolute top-0 left-[-2px] z-20 h-full w-1 cursor-col-resize transition-colors',
              isDraggingInspectorPane && 'bg-acc/50',
            )}
          />
          <div className="border-line flex h-[38px] shrink-0 items-center gap-2 border-b px-2.5">
            <div className="border-line bg-bg-0 flex rounded-md border p-0.5">
              {(
                [
                  ['setup', `Setup ${allSetupReady ? '✓' : `${readySetupSteps}/${setupSteps.length}`}`],
                  ['dev-server', 'Metro'],
                  ['devtools', 'DevTools'],
                  ['logs', `Logs ${nativeLogs.logs.length ? nativeLogs.logs.length : ''}`],
                  ['network', `Network ${networkStats.failed || ''}`],
                ] as const
              )
                .filter(([tab]) =>
                  isMobilePreviewPaneTabVisible({
                    tab,
                    networkEnabled: autoStartProxy,
                  }),
                )
                .map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={clsx(
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                    visibleActiveTab === tab
                      ? 'bg-bg-3 text-ink-1'
                      : 'text-ink-3 hover:text-ink-1',
                  )}
                >
                  {label}
                </button>
                ))}
            </div>
            <div className="min-w-0 flex-1" />
            {isStandalone ? (
              <IconButton
                className={standaloneLayout.inspectorClose}
                size="sm"
                icon={<X />}
                tooltip="Close inspector"
                onClick={() => setIsStandaloneInspectorOpen(false)}
              />
            ) : (
              <IconButton size="sm" icon={<X />} tooltip="Clear" />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{inspectorBody}</div>
        </aside>
      </div>
      {isManageDevicesOpen ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
          onMouseDown={() => setIsManageDevicesOpen(false)}
        >
          <div
            className="border-line bg-bg-1 flex h-[620px] max-h-[88vh] w-[880px] max-w-[94vw] flex-col overflow-hidden rounded-[14px] border shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_40px_90px_-24px_rgba(0,0,0,0.72)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="border-line-soft flex h-[58px] shrink-0 items-center gap-3 border-b px-[18px]">
              <span className="bg-acc-soft text-acc-ink flex size-[30px] items-center justify-center rounded-lg">
                <Settings className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-ink-0 text-[15px] font-semibold">
                    {isCreatingManagedDevice ? 'New device' : 'Manage devices'}
                  </span>
                  {!isCreatingManagedDevice ? (
                    <span className="text-ink-4 font-mono text-[11px]">
                      {allDevices.length} devices
                    </span>
                  ) : null}
                </div>
                <div className="text-ink-3 mt-0.5 text-xs">
                  {isCreatingManagedDevice
                    ? 'Choose the display first, then configure runtime and storage'
                    : 'Checked devices show in the device switcher'}
                </div>
              </div>
              {!isCreatingManagedDevice ? (
                <div className="text-ink-3 flex items-center gap-1.5 text-[11.5px]">
                  <span className="bg-acc text-bg-0 flex size-3.5 items-center justify-center rounded-[3px]">
                    <Check className="size-2.5" strokeWidth={3} />
                  </span>
                  {visibleDevices.length} in switcher
                </div>
              ) : null}
              <IconButton
                onClick={() => {
                  if (isCreatingManagedDevice) {
                    setIsCreateAndroidDeviceOpen(false);
                    setIsCreateIosDeviceOpen(false);
                  } else {
                    setIsManageDevicesOpen(false);
                  }
                }}
                size="sm"
                icon={<X />}
                tooltip={isCreatingManagedDevice ? 'Cancel' : 'Close'}
              />
            </div>
            {isCreatingManagedDevice ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-line-soft flex shrink-0 items-center gap-3 border-b px-[18px] py-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setIsCreateAndroidDeviceOpen(false);
                      setIsCreateIosDeviceOpen(false);
                    }}
                  >
                    Back
                  </Button>
                  <div className="min-w-0 flex-1" />
                  <div className="border-line bg-bg-0 flex rounded-md border p-0.5">
                    {(['android', 'ios'] as const).map((createPlatform) => (
                      <button
                        key={createPlatform}
                        type="button"
                        onClick={() => {
                          setManageCreatePlatform(createPlatform);
                          setIsCreateAndroidDeviceOpen(createPlatform === 'android');
                          setIsCreateIosDeviceOpen(createPlatform === 'ios');
                        }}
                        className={clsx(
                          'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                          manageCreatePlatform === createPlatform
                            ? 'bg-bg-3 text-ink-1'
                            : 'text-ink-3 hover:text-ink-1',
                        )}
                      >
                        {createPlatform === 'android' ? 'Android' : 'iOS'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 max-[760px]:flex-col">
                  <div className="min-w-0 flex-1 overflow-y-auto p-[22px]">
                    <div className="text-ink-0 text-[13px] font-semibold">
                      {manageCreatePlatform === 'android'
                        ? 'Device profile'
                        : 'Device type'}
                      <span className="text-ink-3 ml-2 text-[11.5px] font-normal">
                        {manageCreatePlatform === 'android'
                          ? `${androidManagement.profiles.data?.length ?? 0} options`
                          : `${iosDeviceTypes.length} options`}
                      </span>
                    </div>
                    <p className="text-ink-3 mt-1 mb-4 max-w-[440px] text-xs leading-relaxed">
                      The profile sets screen size, resolution and density. Pick the display where the app will actually run.
                    </p>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
                      {manageCreatePlatform === 'android'
                        ? (androidManagement.profiles.data ?? []).map((profile) => {
                            const selected = profile.id === androidDeviceProfileId;
                            const screen = profile.screen;
                            const aspect = screen
                              ? Math.min(screen.width, screen.height) /
                                Math.max(screen.width, screen.height)
                              : 0.46;
                            const isTablet = aspect > 0.62;
                            return (
                              <button
                                key={profile.id}
                                type="button"
                                onClick={() => setAndroidDeviceProfileId(profile.id)}
                                className={clsx(
                                  'relative flex min-h-[148px] flex-col items-center gap-2.5 rounded-[10px] border px-2.5 pt-3.5 pb-3 text-center transition-colors',
                                  selected
                                    ? 'border-acc-line bg-acc-soft'
                                    : 'border-line-soft bg-bg-0 hover:bg-bg-2',
                                )}
                              >
                                <span
                                  className={clsx(
                                    'absolute top-2 right-2 flex size-4 items-center justify-center rounded-full border',
                                    selected
                                      ? 'border-acc bg-acc text-bg-0'
                                      : 'border-line opacity-30',
                                  )}
                                >
                                  {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
                                </span>
                                <span
                                  className={clsx(
                                    'mt-2 flex items-center justify-center rounded-md border p-[4px]',
                                    selected ? 'border-acc-line shadow-[0_0_0_3px_var(--color-acc-soft)]' : 'border-line',
                                  )}
                                  style={{
                                    width: Math.max(26, Math.round(60 * aspect)),
                                    height: 60,
                                    borderRadius: isTablet ? 5 : 7,
                                  }}
                                >
                                  <span
                                    className={clsx(
                                      'block h-full w-full rounded-[3px]',
                                      selected ? 'bg-acc-soft' : 'bg-bg-3',
                                    )}
                                  />
                                </span>
                                <span className="text-ink-1 mt-1 line-clamp-2 text-xs font-semibold">
                                  {profile.name}
                                </span>
                                <span className="text-ink-4 font-mono text-[9.5px]">
                                  {formatAndroidScreenSpec(screen)}
                                </span>
                                <span className="text-ink-3 text-[9px] font-semibold tracking-wide uppercase">
                                  {isTablet ? 'Tablet' : 'Phone'}
                                </span>
                              </button>
                            );
                          })
                        : iosDeviceTypes.map((deviceType) => {
                            const selected = deviceType.id === iosDeviceTypeId;
                            const chrome = getIosDeviceChrome(deviceType);
                            return (
                              <button
                                key={deviceType.id}
                                type="button"
                                onClick={() => setIosDeviceTypeId(deviceType.id)}
                                className={clsx(
                                  'relative flex min-h-[148px] flex-col items-center gap-2.5 rounded-[10px] border px-2.5 pt-3.5 pb-3 text-center transition-colors',
                                  selected
                                    ? 'border-acc-line bg-acc-soft'
                                    : 'border-line-soft bg-bg-0 hover:bg-bg-2',
                                )}
                              >
                                <span
                                  className={clsx(
                                    'absolute top-2 right-2 flex size-4 items-center justify-center rounded-full border',
                                    selected
                                      ? 'border-acc bg-acc text-bg-0'
                                      : 'border-line opacity-30',
                                  )}
                                >
                                  {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
                                </span>
                                <span
                                  className={clsx(
                                    'mt-2 flex items-center justify-center rounded-md border p-[4px]',
                                    selected ? 'border-acc-line shadow-[0_0_0_3px_var(--color-acc-soft)]' : 'border-line',
                                  )}
                                  style={{
                                    width: Math.round(chrome.height * chrome.aspect),
                                    height: chrome.height,
                                    borderRadius: chrome.hasHomeButton ? 6 : 8,
                                  }}
                                >
                                  <span
                                    className={clsx(
                                      'relative block h-full w-full overflow-hidden rounded-[4px]',
                                      selected ? 'bg-acc-soft' : 'bg-bg-3',
                                    )}
                                  >
                                    {chrome.hasDynamicIsland ? (
                                      <span className="bg-bg-0/80 absolute top-[5px] left-1/2 h-[4px] w-[34%] -translate-x-1/2 rounded-full" />
                                    ) : null}
                                    {chrome.hasClassicNotch ? (
                                      <span className="bg-bg-0/80 absolute top-0 left-1/2 h-[7px] w-[42%] -translate-x-1/2 rounded-b-md" />
                                    ) : null}
                                    {chrome.hasHomeButton ? (
                                      <span className="border-line absolute bottom-[4px] left-1/2 size-[6px] -translate-x-1/2 rounded-full border" />
                                    ) : null}
                                    <span className="bg-line/70 absolute top-[14px] left-[-2px] h-[10px] w-[2px] rounded-l" />
                                    <span className="bg-line/70 absolute top-[18px] right-[-2px] h-[14px] w-[2px] rounded-r" />
                                  </span>
                                </span>
                                <span className="text-ink-1 mt-1 line-clamp-2 text-xs font-semibold">
                                  {deviceType.name}
                                </span>
                                <span className="text-ink-4 font-mono text-[9.5px]">
                                  {deviceType.screen
                                    ? `${deviceType.screen.width} x ${deviceType.screen.height}`
                                    : (deviceType.productFamily ?? 'iPhone')}
                                </span>
                                <span className="text-ink-3 text-[9px] font-semibold tracking-wide uppercase">
                                  Phone
                                </span>
                              </button>
                            );
                          })}
                    </div>
                  </div>
                  <div className="border-line-soft bg-bg-0 flex w-[340px] shrink-0 flex-col border-l max-[760px]:min-h-[320px] max-[760px]:w-full max-[760px]:border-t max-[760px]:border-l-0">
                    <div className="min-h-0 flex-1 overflow-y-auto p-5">
                      <div className="text-ink-4 mb-3 text-[10px] font-semibold tracking-wide uppercase">
                        Configuration
                      </div>
                      <label className="text-ink-3 mb-1.5 block text-[11px] font-medium">
                        Name <span className="text-ink-4 font-normal">optional</span>
                      </label>
                      <Input
                        value={manageCreatePlatform === 'android' ? androidDeviceName : iosDeviceName}
                        onChange={(event) => {
                          if (manageCreatePlatform === 'android') {
                            setAndroidDeviceName(event.target.value);
                          } else {
                            setIosDeviceName(event.target.value);
                          }
                        }}
                        placeholder={manageCreatePlatform === 'android' ? 'Pixel_8_API_35' : 'iPhone 16 Pro iOS 18.5'}
                        className="h-9 font-mono text-xs"
                      />
                      <div className="mt-4">
                        <label className="text-ink-3 mb-1.5 block text-[11px] font-medium">
                          {manageCreatePlatform === 'android' ? 'System image' : 'Runtime'}
                        </label>
                        {manageCreatePlatform === 'android' ? (
                          <Select
                            value={androidSystemImageId}
                            options={
                              androidSystemImageOptions.length > 0
                                ? androidSystemImageOptions
                                : [{ value: '', label: 'No system images' }]
                            }
                            onChange={setAndroidSystemImageId}
                            disabled={androidSystemImageOptions.length === 0}
                            size="sm"
                            className="w-full justify-between"
                          />
                        ) : (
                          <Select
                            value={iosRuntimeId}
                            options={
                              iosRuntimeOptions.length > 0
                                ? iosRuntimeOptions
                                : [{ value: '', label: 'No iOS runtimes' }]
                            }
                            onChange={setIosRuntimeId}
                            disabled={iosRuntimeOptions.length === 0}
                            size="sm"
                            className="w-full justify-between"
                          />
                        )}
                      </div>
                      {manageCreatePlatform === 'android' ? (
                        <>
                          <div className="mt-5 flex items-center gap-2">
                            <span className="text-ink-4 text-[10px] font-semibold tracking-wide uppercase">
                              Advanced
                            </span>
                            <span className="bg-line-soft h-px flex-1" />
                          </div>
                          <div className="mt-3 grid grid-cols-3 gap-2">
                            <Input value={androidRamMb} onChange={(event) => setAndroidRamMb(event.target.value)} inputMode="numeric" placeholder="RAM" className="h-9 text-xs" />
                            <Input value={androidVmHeapMb} onChange={(event) => setAndroidVmHeapMb(event.target.value)} inputMode="numeric" placeholder="Heap" className="h-9 text-xs" />
                            <Input value={androidStorageMb} onChange={(event) => setAndroidStorageMb(event.target.value)} inputMode="numeric" placeholder="Storage" className="h-9 text-xs" />
                          </div>
                          <label className="text-ink-2 mt-3 flex items-center gap-2 text-xs">
                            <input type="checkbox" checked={androidHwKeyboard} onChange={(event) => setAndroidHwKeyboard(event.currentTarget.checked)} className="accent-acc size-3.5" />
                            Hardware keyboard
                          </label>
                        </>
                      ) : null}
                      <div className="text-ink-4 mt-5 mb-2 text-[10px] font-semibold tracking-wide uppercase">
                        Summary
                      </div>
                      <div className="border-line-soft bg-bg-1 rounded-md border p-3 text-[11.5px]">
                        {(manageCreatePlatform === 'android'
                          ? [
                              ['Device', selectedAndroidProfile?.name ?? 'Unknown profile'],
                              ['Display', formatAndroidScreenSpec(selectedAndroidProfile?.screen ?? null)],
                              ['System image', selectedAndroidSystemImage ? `API ${selectedAndroidSystemImage.apiLevel} · ${formatAndroidImageTag(selectedAndroidSystemImage.tag)} · ${selectedAndroidSystemImage.abi}` : 'No image selected'],
                              ['Host arch', androidHostArch ?? 'unknown'],
                            ]
                          : [
                              ['Device', selectedIosDeviceType?.name ?? 'Unknown device type'],
                              ['Runtime', selectedIosRuntime?.name ?? 'No runtime selected'],
                            ]
                        ).map(([label, value]) => (
                          <div key={label} className="flex items-baseline gap-3 py-1">
                            <span className="text-ink-4 w-20 shrink-0">{label}</span>
                            <span className="text-ink-1 flex-1 text-right font-mono break-words">{value}</span>
                          </div>
                        ))}
                      </div>
                      {manageCreatePlatform === 'android' && androidImageCompatibilityWarning ? (
                        <div className="border-status-warn/30 bg-status-warn/10 text-status-warn mt-3 flex gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-snug">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          <span>{androidImageCompatibilityWarning}</span>
                        </div>
                      ) : null}
                      {manageCreatePlatform === 'android' && androidManagement.systemImages.data?.length === 0 ? (
                        <div className="border-line text-ink-3 mt-3 rounded-md border border-dashed p-2 text-[11px] leading-snug">
                          <div className="mb-2">No Android system images installed.</div>
                          <Button
                            size="sm"
                            loading={androidManagement.installSystemImage.isPending}
                            onClick={handleInstallSuggestedAndroidImage}
                          >
                            Install Android 35 image
                          </Button>
                          <div className="text-ink-4 mt-2">
                            Downloads are large. If licenses block install, run <code>sdkmanager --licenses</code> once.
                          </div>
                        </div>
                      ) : null}
                      {manageCreatePlatform === 'ios' && iosManagement.toolStatus.data?.missingTools.includes('xcrun') ? (
                        <div className="border-status-warn/30 bg-status-warn/10 text-status-warn mt-3 rounded-md border p-2 text-[11px] leading-snug">
                          Missing xcrun. Run <code>xcode-select --install</code>, then restart Jean-Claude.
                        </div>
                      ) : null}
                      {manageCreatePlatform === 'ios' && availableIosRuntimes.length === 0 ? (
                        <div className="border-line text-ink-3 mt-3 rounded-md border border-dashed p-2 text-[11px] leading-snug">
                          No available iOS runtimes. Install one from Xcode Settings &gt; Platforms.
                        </div>
                      ) : null}
                      {manageCreatePlatform === 'android' && androidManagementError ? (
                        <div className="text-status-fail mt-3 text-[11px] leading-snug">{cleanPreviewError(androidManagementError)}</div>
                      ) : null}
                      {manageCreatePlatform === 'ios' && iosManagementError ? (
                        <div className="text-status-fail mt-3 text-[11px] leading-snug">{cleanPreviewError(iosManagementError)}</div>
                      ) : null}
                    </div>
                    <div className="border-line-soft flex shrink-0 gap-2 border-t p-4">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setIsCreateAndroidDeviceOpen(false);
                          setIsCreateIosDeviceOpen(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <div className="flex-1" />
                      {manageCreatePlatform === 'android' ? (
                        <Button size="sm" variant="primary" loading={androidManagement.createDevice.isPending} disabled={!canCreateAndroidDevice || androidManagement.createDevice.isPending} onClick={handleCreateAndroidDevice}>
                          Create device
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" loading={iosManagement.createDevice.isPending} disabled={!canCreateIosDevice || iosManagement.createDevice.isPending} onClick={handleCreateIosDevice}>
                          Create device
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 max-[700px]:flex-col">
                <div className="border-line-soft bg-bg-0 flex w-[300px] shrink-0 flex-col border-r max-[700px]:h-[220px] max-[700px]:w-full max-[700px]:border-r-0 max-[700px]:border-b">
                  <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                    {(['android', 'ios'] as const).map((devicePlatform) => {
                      const platformDevices = managedDevicesByPlatform[devicePlatform];
                      if (platformDevices.length === 0) return null;
                      return (
                        <div key={devicePlatform} className="mb-1.5">
                          <div className="text-ink-4 px-1.5 py-2 text-[10px] font-semibold tracking-wide uppercase">
                            {devicePlatform === 'android' ? 'Android' : 'iOS'} · {platformDevices.length}
                          </div>
                          {platformDevices.map((device) => {
                            const selected = selectedManagedDevice?.id === device.id && selectedManagedDevice.platform === device.platform;
                            const visibleDeviceIds = visibleDeviceIdsByPlatform[device.platform];
                            const checked = visibleDeviceIds === null || visibleDeviceIds.includes(device.id);
                            return (
                              <button
                                key={`${device.platform}:${device.id}`}
                                type="button"
                                onClick={() => setManagedSelectedDeviceKey(`${device.platform}:${device.id}`)}
                                className={clsx(
                                  'mb-0.5 grid w-full grid-cols-[16px_8px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors',
                                  selected ? 'border-line bg-bg-3' : 'border-transparent hover:bg-bg-2',
                                )}
                              >
                                <span
                                  role="checkbox"
                                  aria-checked={checked}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setVisibleDeviceIdsByPlatform((current) => {
                                      const currentIds = current[device.platform] ?? managedDevicesByPlatform[device.platform].map((platformDevice) => platformDevice.id);
                                      return {
                                        ...current,
                                        [device.platform]: checked ? currentIds.filter((id) => id !== device.id) : [...new Set([...currentIds, device.id])],
                                      };
                                    });
                                  }}
                                  className={clsx(
                                    'flex size-4 items-center justify-center rounded-[3px] border',
                                    checked ? 'border-acc bg-acc text-bg-0' : 'border-line bg-bg-1',
                                  )}
                                >
                                  {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
                                </span>
                                <span className={clsx('size-[7px] rounded-full', device.state === 'booted' ? 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.7)]' : 'bg-ink-4')} />
                                <span className="min-w-0">
                                  <span className="text-ink-1 block truncate text-[12.5px] font-medium">{device.name}</span>
                                  <span className="text-ink-4 block truncate font-mono text-[10px]">{device.osVersion ?? formatDeviceState(device.state)}</span>
                                </span>
                                <PlatformLogo platform={device.platform} />
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                    {allDevices.length === 0 ? (
                      <div className="text-ink-4 p-3 text-xs">No devices yet.</div>
                    ) : null}
                  </div>
                  <div className="border-line-soft shrink-0 border-t p-2.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="w-full justify-center"
                      onClick={() => {
                        const nextPlatform = platform ?? 'android';
                        setManageCreatePlatform(nextPlatform);
                        setIsCreateAndroidDeviceOpen(nextPlatform === 'android');
                        setIsCreateIosDeviceOpen(nextPlatform === 'ios');
                      }}
                    >
                      New device
                    </Button>
                  </div>
                </div>
                {selectedManagedDevice ? (
                  <div className="min-w-0 flex-1 overflow-y-auto p-6">
                    <div className="mb-5 flex items-center gap-3.5">
                      <span className="border-line bg-bg-1 flex h-[54px] w-[25px] shrink-0 items-center justify-center rounded-lg border p-[3px]">
                        <span className="bg-bg-3 h-full w-full rounded-[4px]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5">
                          <span className="text-ink-0 truncate text-[17px] font-semibold">{selectedManagedDevice.name}</span>
                          <PlatformLogo platform={selectedManagedDevice.platform} />
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <span className={clsx('size-[7px] rounded-full', selectedManagedDevice.state === 'booted' ? 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.7)]' : 'bg-ink-4')} />
                          <span className="text-ink-4 font-mono text-[11px]">{formatDeviceState(selectedManagedDevice.state)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-ink-4 mb-2.5 text-[10px] font-semibold tracking-wide uppercase">Specification</div>
                    <div className="border-line-soft bg-bg-0 mb-5 rounded-md border px-3.5 py-1.5 text-[11.5px]">
                      {[
                        ['Handle', selectedManagedDevice.id],
                        ['OS', selectedManagedDevice.osVersion ?? (selectedManagedDevice.platform === 'android' ? 'Android' : 'iOS')],
                        ['State', formatDeviceState(selectedManagedDevice.state)],
                        ['Platform', selectedManagedDevice.platform === 'android' ? 'Android' : 'iOS'],
                      ].map(([label, value]) => (
                        <div key={label} className="border-line-soft flex items-baseline gap-3 border-b py-2 last:border-b-0">
                          <span className="text-ink-3 w-[70px] shrink-0">{label}</span>
                          <span className="text-ink-1 flex-1 text-right font-mono break-all">{value}</span>
                        </div>
                      ))}
                    </div>
                    {renamingIosDeviceId === selectedManagedDevice.id ? (
                      <div className="border-line-soft bg-bg-0 mb-4 flex flex-wrap items-center gap-2 rounded-md border p-2">
                        <Input value={iosRenameValue} onChange={(event) => setIosRenameValue(event.target.value)} className="h-8 min-w-44 flex-1 text-xs" />
                        <Button size="sm" variant="primary" loading={iosManagement.renameDevice.isPending} disabled={!iosRenameValue.trim() || iosManagement.renameDevice.isPending} onClick={() => handleRenameIosDevice(selectedManagedDevice.id)}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setRenamingIosDeviceId(null); setIosRenameValue(''); }}>Cancel</Button>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setVisibleDeviceIdsByPlatform((current) => {
                            const currentIds =
                              current[selectedManagedDevice.platform] ??
                              managedDevicesByPlatform[
                                selectedManagedDevice.platform
                              ].map((platformDevice) => platformDevice.id);
                            return {
                              ...current,
                              [selectedManagedDevice.platform]: [
                                ...new Set([...currentIds, selectedManagedDevice.id]),
                              ],
                            };
                          });
                          handleSelectDevice(selectedManagedDevice);
                          setIsManageDevicesOpen(false);
                        }}
                      >
                        Select device
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const visibleDeviceIds = visibleDeviceIdsByPlatform[selectedManagedDevice.platform];
                          const checked = visibleDeviceIds === null || visibleDeviceIds.includes(selectedManagedDevice.id);
                          setVisibleDeviceIdsByPlatform((current) => {
                            const currentIds = current[selectedManagedDevice.platform] ?? managedDevicesByPlatform[selectedManagedDevice.platform].map((platformDevice) => platformDevice.id);
                            return {
                              ...current,
                              [selectedManagedDevice.platform]: checked ? currentIds.filter((id) => id !== selectedManagedDevice.id) : [...new Set([...currentIds, selectedManagedDevice.id])],
                            };
                          });
                        }}
                      >
                        Toggle switcher
                      </Button>
                      {selectedManagedDevice.platform === 'ios' ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => { setRenamingIosDeviceId(selectedManagedDevice.id); setIosRenameValue(selectedManagedDevice.name); }}>Rename</Button>
                          <Button size="sm" variant="ghost" loading={iosManagement.eraseDevice.isPending && erasingIosDeviceId === selectedManagedDevice.id} onClick={() => handleEraseIosDevice(selectedManagedDevice.id)}>Erase</Button>
                          <Button size="sm" variant="ghost" loading={iosManagement.deleteDevice.isPending && deletingIosDeviceId === selectedManagedDevice.id} onClick={() => handleDeleteIosDevice(selectedManagedDevice.id)}>Delete</Button>
                        </>
                      ) : selectedManagedDevice.state === 'shutdown' ? (
                        <Button size="sm" variant="ghost" loading={androidManagement.deleteDevice.isPending && deletingAndroidDeviceId === selectedManagedDevice.id} onClick={() => handleDeleteAndroidDevice(selectedManagedDevice.id)}>Delete</Button>
                      ) : null}
                    </div>
                    {androidManagementError || iosManagementError ? (
                      <div className="text-status-fail mt-4 text-[11px] leading-snug">
                        {cleanPreviewError(androidManagementError ?? iosManagementError ?? '')}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-ink-4 flex flex-1 items-center justify-center text-xs">Select a device</div>
                )}
              </div>
            )}
            {!isCreatingManagedDevice ? (
              <div className="border-line flex h-12 shrink-0 items-center justify-end border-t px-4">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setIsManageDevicesOpen(false)}
                >
                  Done
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
