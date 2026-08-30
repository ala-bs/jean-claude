export type MobilePlatform = 'ios' | 'android';

export type MobilePreviewQuality = 'low' | 'balanced' | 'high' | 'very-high';
export type MobilePreviewTextSize = 'small' | 'normal' | 'large' | 'x-large';

export type MobileColorScheme = 'light' | 'dark';

export type MobileRotationDirection = 'left' | 'right';

export type MobilePreviewStatus =
  | 'idle'
  | 'checking-tools'
  | 'starting'
  | 'streaming'
  | 'stopped'
  | 'error';

export type MobilePreviewInputStatus = 'ready' | 'starting' | 'error';

export type MobilePreviewFrameFormat = 'h264' | 'mjpeg' | 'png' | 'raw-rgba';

export const MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT = 8;
export const MOBILE_PREVIEW_REPLAY_BYTE_LIMIT = 8 * 1024 * 1024;

export type MobilePreviewStreamStrategy =
  | 'coresimulator-framebuffer'
  | 'idb-h264-stream'
  | 'idb-rbga-stream'
  | 'idb-video-stream'
  | 'simctl-screenshot'
  | 'adb-screenrecord'
  | 'adb-screenshot'
  | 'scrcpy';

/**
 * `simulator` covers Android emulators (AVDs) and iOS simulators.
 * `physical` covers real hardware reachable over USB/Wi-Fi (adb serials,
 * CoreDevice/devicectl identifiers).
 */
export type MobilePreviewDeviceKind = 'simulator' | 'physical';

/**
 * Connection health for physical devices. Simulators are always `connected`
 * when present.
 * - `unauthorized`: adb pairing prompt not accepted on the handset
 * - `unavailable`: paired but not currently reachable (devicectl), or adb `offline`
 * - `untrusted`: iOS device not paired / Developer Mode disabled
 */
export type MobilePreviewDeviceConnection =
  | 'connected'
  | 'unauthorized'
  | 'unavailable'
  | 'untrusted';

export type MobilePreviewDevice = {
  id: string;
  name: string;
  platform: MobilePlatform;
  state: 'booted' | 'shutdown' | 'unknown';
  osVersion?: string;
  /** Defaults to `'simulator'` when absent (back-compat with older callers). */
  kind?: MobilePreviewDeviceKind;
  connection?: MobilePreviewDeviceConnection;
  /** Model marketing name, e.g. "iPhone 14 Pro" / "Pixel 7". Physical devices only. */
  model?: string;
  /** Reason the device cannot currently be used for preview. */
  unavailableReason?: string;
  /**
   * The transport-level identifier the platform CLI expects (adb serial for
   * Android, e.g. `emulator-5554`); falls back to `id` when absent.
   *
   * Booted Android emulators are surfaced under their AVD name so the rail
   * reads well, but `adb`/`react-native run-android --deviceId` need the
   * serial.
   */
  connectionId?: string;
};

export function isPhysicalMobilePreviewDevice(
  device: Pick<MobilePreviewDevice, 'kind'> | null | undefined,
): boolean {
  return device?.kind === 'physical';
}

export type MobilePreviewAndroidToolStatus = {
  hostArch: string;
  sdkRoot: string | null;
  adbPath: string | null;
  emulatorPath: string | null;
  avdmanagerPath: string | null;
  sdkmanagerPath: string | null;
  missingTools: Array<'adb' | 'emulator' | 'avdmanager' | 'sdkmanager'>;
};

export type MobilePreviewIosToolStatus = {
  xcrunPath: string | null;
  missingTools: Array<'xcrun'>;
};

export type MobilePreviewIosRuntime = {
  id: string;
  name: string;
  version: string | null;
  platform: string;
  available: boolean;
};

export type MobilePreviewIosDeviceType = {
  id: string;
  name: string;
  productFamily: string | null;
  screen: { width: number; height: number } | null;
};

export type MobilePreviewIosCreateDeviceParams = {
  name: string;
  deviceTypeId: string;
  runtimeId: string;
};

export type MobilePreviewIosRenameDeviceParams = {
  deviceId: string;
  name: string;
};

export type MobilePreviewAndroidSystemImage = {
  id: string;
  packagePath: string;
  apiLevel: number;
  tag: string;
  abi: string;
  installed: boolean;
};

export type MobilePreviewAndroidDeviceProfile = {
  id: string;
  name: string;
  manufacturer: string | null;
  screen: { width: number; height: number; densityDpi: number | null } | null;
};

export type MobilePreviewAndroidCreateDeviceParams = {
  name: string;
  deviceProfileId: string;
  systemImageId: string;
  ramMb?: number;
  vmHeapMb?: number;
  storageMb?: number;
  hwKeyboard?: boolean;
};

export type MobilePreviewAndroidInstallSystemImageParams = {
  systemImageId: string;
};

export type MobilePreviewSession = {
  id: string;
  taskId: string;
  platform: MobilePlatform;
  deviceId: string;
  status: MobilePreviewStatus;
  width: number | null;
  height: number | null;
  frameFormat: MobilePreviewFrameFormat;
  streamStrategy: MobilePreviewStreamStrategy;
  inputStatus: MobilePreviewInputStatus;
  error: string | null;
};

export type MobilePreviewStartParams = {
  taskId: string;
  projectPath: string;
  platform: MobilePlatform;
  deviceId: string;
  fps?: number;
  quality?: MobilePreviewQuality;
};

export type MobilePreviewListSessionsParams = {
  taskId: string;
};

/**
 * Which task a device is associated with, across all tasks.
 *
 * `isActive` means a preview session is live on the device right now; when it
 * is false the association is the remembered "last task that used this device".
 * There is no exclusivity — a device is simply attributed to its latest task.
 */
export type MobilePreviewDeviceAssignment = {
  platform: MobilePlatform;
  deviceId: string;
  taskId: string;
  isActive: boolean;
  status: MobilePreviewStatus | null;
  lastUsedAt: string | null;
};

export type MobilePreviewAttachSessionParams = {
  taskId: string;
  sessionId: string;
};

export type MobilePreviewDetachSessionParams = MobilePreviewAttachSessionParams;

export type MobilePreviewOpenDeeplinkParams = {
  platform: MobilePlatform;
  deviceId: string;
  url: string;
};

export type MobilePreviewOpenDevMenuParams = {
  platform: MobilePlatform;
  deviceId: string;
  metroPort: number;
};

export type MobilePreviewReloadExpoParams = {
  metroPort: number;
};

export type MobilePreviewExpoLaunchParams = {
  requestId: string;
  taskId: string;
  projectId: string;
  appPath: string;
  platform: MobilePlatform;
  deviceId: string;
  metroPort: number;
  /**
   * App URL scheme from project settings. Overrides scheme discovery from the
   * app config, which fails for dynamic `app.config.js` projects.
   */
  appScheme?: string | null;
};

export type MobilePreviewExpoLaunchResult = {
  url: string;
  runtime?: string;
  appId?: string | null;
};

export type MobilePreviewForwardPortParams = {
  platform: MobilePlatform;
  deviceId: string;
  hostPort: number;
  devicePort: number;
};

export type MobilePreviewSetTextSizeParams = {
  platform: MobilePlatform;
  deviceId: string;
  size: MobilePreviewTextSize;
};

export type MobilePreviewInputEvent =
  | { type: 'touchDown'; x: number; y: number }
  | { type: 'touchMove'; x: number; y: number }
  | { type: 'touchUp'; x: number; y: number }
  | { type: 'tap'; x: number; y: number }
  | { type: 'longPress'; x: number; y: number; durationMs: number }
  | {
      type: 'swipe';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      durationMs: number;
    }
  | { type: 'text'; text: string }
  | { type: 'key'; key: 'home' | 'back' | 'enter' | 'backspace' }
  | { type: 'showKeyboard' };

export type MobilePreviewFrameEvent = {
  sessionId: string;
  frameBase64: string;
  h264PacketType?: 'configuration' | 'data';
  keyframe?: boolean;
};

export type MobilePreviewSessionEvent = {
  session: MobilePreviewSession;
};

export type MobilePreviewNativeLogStatus = 'running' | 'stopped' | 'errored';

export type MobilePreviewNativeLogStream = 'stdout' | 'stderr' | 'system';

export type MobilePreviewNativeLogSession = {
  id: string;
  platform: MobilePlatform;
  deviceId: string;
  status: MobilePreviewNativeLogStatus;
  command: string;
  error: string | null;
  updatedAt: string;
};

export type MobilePreviewNativeLogStartParams = {
  platform: MobilePlatform;
  deviceId: string;
};

export type MobilePreviewNativeLogEvent = {
  sessionId: string;
  stream: MobilePreviewNativeLogStream;
  text: string;
  timestamp: string;
};

export type MobilePreviewNativeLogSessionEvent = {
  session: MobilePreviewNativeLogSession;
};

export type ReactNativeDevToolsPanel = 'console' | 'network' | 'components';

export type ReactNativeDevToolsTarget = {
  id: string;
  title: string;
  description: string | null;
  appId: string | null;
  deviceName: string | null;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl: string | null;
  nativePageReloads: boolean;
};

export type ReactNativeDevToolsResolveParams = {
  metroPort: number;
  panel?: ReactNativeDevToolsPanel;
};

export type ReactNativeDevToolsOpenParams = ReactNativeDevToolsResolveParams & {
  targetId?: string;
};

export type ReactNativeDevToolsEmbeddedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ReactNativeDevToolsEmbeddedOpenParams = {
  viewId: string;
  frontendUrl: string;
  bounds: ReactNativeDevToolsEmbeddedBounds;
};

export type ReactNativeDevToolsEmbeddedBoundsParams = {
  viewId: string;
  bounds: ReactNativeDevToolsEmbeddedBounds;
};

export type ReactNativeDevToolsEmbeddedVisibilityParams = {
  viewId: string;
  visible: boolean;
};

export type ReactNativeDevToolsEmbeddedCloseParams = {
  viewId: string;
};

export type ReactNativeDevToolsResolveResult = {
  metroBaseUrl: string;
  frontendUrl: string | null;
  targets: ReactNativeDevToolsTarget[];
  error: string | null;
};

export type MobilePreviewNetworkProxyStatus = 'running' | 'stopped' | 'errored';

export type MobilePreviewNetworkProxyMode =
  | 'manual'
  | 'android-emulator'
  | 'ios-simulator'
  // A physical iPhone routes through the Mac's LAN address, not its loopback,
  // and the Mac's own proxy settings are irrelevant to it.
  | 'ios-device';

export type MobilePreviewNetworkCaptureSource =
  | 'proxied'
  | 'mitm'
  | 'tunneled'
  | 'packet-only';

export type MobilePreviewNetworkRequest = {
  id: string;
  sessionId: string;
  captureSource: MobilePreviewNetworkCaptureSource;
  method: string;
  url: string;
  status: number | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodyPreview: string | null;
  responseBodyPreview: string | null;
  clientAddress: string | null;
  clientPort: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: string | null;
  tunnelOnly: boolean;
  decrypted: boolean;
};

export type MobilePreviewNetworkProxySession = {
  id: string;
  projectPath: string;
  appPath: string;
  platform: MobilePlatform;
  deviceId: string;
  status: MobilePreviewNetworkProxyStatus;
  mode: MobilePreviewNetworkProxyMode;
  port: number;
  proxyHost: string;
  proxyUrl: string;
  androidEmulatorProxyUrl: string;
  lanProxyUrls: string[];
  enableMitm: boolean;
  error: string | null;
  updatedAt: string;
};

export type MobilePreviewNetworkProxyStartParams = {
  projectPath: string;
  appPath: string;
  platform: MobilePlatform;
  deviceId: string;
  port?: number;
  autoConfigureDevice?: boolean;
  enableMitm?: boolean;
};

export type MobilePreviewNetworkProxyCertificateParams = {
  platform: MobilePlatform;
  deviceId: string;
};

export type MobilePreviewNetworkProxyCertificate = {
  platform: MobilePlatform;
  deviceId: string;
  certPath: string;
  installedAt: string;
  /**
   * `false` when the CA could not be pushed to the device automatically and the
   * user has to install it by hand (physical iOS). `message` then carries the
   * actionable instructions.
   */
  installed: boolean;
  message: string | null;
};

export type MobilePreviewAndroidAppTrustParams = {
  projectId: string;
  taskId: string;
  androidProjectPath: string;
};

export type MobilePreviewAndroidAppStatusParams = {
  projectId: string;
  taskId: string;
  androidProjectPath: string;
  deviceId: string;
};

export type MobilePreviewAndroidAppRestartParams = MobilePreviewAndroidAppStatusParams;

export type MobilePreviewAndroidAppRestartResult = {
  packageName: string;
  restartedAt: string;
};

export type MobilePreviewAndroidAppStatus = {
  appInstalled: boolean | null;
  packageName: string | null;
  trustConfigured: boolean;
};

export type MobilePreviewAndroidAppTrustResult = {
  appPath: string;
  nativeFiles: string[];
  message: string;
  changed: boolean;
  updatedAt: string;
};

export type MobilePreviewIosAppStatusParams = {
  appPath: string;
  deviceId: string;
  iosBundleId?: string | null;
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun' | null;
};

export type MobilePreviewIosAppRestartParams = MobilePreviewIosAppStatusParams;

export type MobilePreviewIosAppRequestParams = {
  projectId: string;
  taskId: string;
  appPath: string;
  deviceId: string;
};

export type MobilePreviewIosAppStatusRequestParams =
  MobilePreviewIosAppRequestParams & {
    requestId: string;
  };

export type MobilePreviewIosAppStatusCancelParams = Pick<
  MobilePreviewIosAppStatusRequestParams,
  'projectId' | 'taskId' | 'requestId'
>;

export type MobilePreviewIosAppStatus = {
  appInstalled: boolean | null;
  bundleId: string | null;
  nativeProjectExists: boolean;
};

export type MobilePreviewIosAppRestartResult = {
  bundleId: string;
  restartedAt: string;
};

export type MobilePreviewNetworkProxyEvent = {
  sessionId: string;
  request: MobilePreviewNetworkRequest;
};

export type MobilePreviewNetworkProxySessionEvent = {
  session: MobilePreviewNetworkProxySession;
};

export type MobilePreviewPacketCaptureStatus =
  | 'running'
  | 'setup-needed'
  | 'stopped'
  | 'errored';

export type MobilePreviewPacketCaptureSession = {
  id: string;
  platform: MobilePlatform;
  deviceId: string;
  status: MobilePreviewPacketCaptureStatus;
  command: string;
  error: string | null;
  updatedAt: string;
};

export type MobilePreviewPacketCaptureStartParams = {
  platform: MobilePlatform;
  deviceId: string;
  command?: string;
  args?: string[];
};

export type MobilePreviewPacketCaptureEvent = {
  sessionId: string;
  request: MobilePreviewNetworkRequest;
};

export type MobilePreviewPacketCaptureSessionEvent = {
  session: MobilePreviewPacketCaptureSession;
};
