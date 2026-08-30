import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { app } from 'electron';

import type {
  MobilePreviewAndroidAppStatus,
  MobilePreviewAndroidAppTrustResult,
  MobilePreviewNetworkProxyCertificate,
  MobilePreviewNetworkProxyCertificateParams,
  MobilePreviewNetworkProxyEvent,
  MobilePreviewNetworkProxySession,
  MobilePreviewNetworkProxySessionEvent,
  MobilePreviewNetworkProxyStartParams,
  MobilePreviewNetworkRequest,
} from '@shared/mobile-simulator-types';

import {
  type MobilePreviewLifecycle,
  registerBeforeQuitCleanup,
} from './mobile-preview-lifecycle';
import { dbg } from '../lib/debug';
import { getLanAddress } from './mobile-preview-lan-address';
import { isKnownPhysicalIosDevice } from './mobile-preview-ios-devicectl';
import { runCommand } from './mobile-preview-process';

const DEFAULT_PROXY_PORT = 9099;
const ANDROID_DEVICE_RESOLUTION_CACHE_TTL_MS = 5_000;
const PREVIEW_BYTES_LIMIT = 32 * 1024;
const DEFAULT_CA_DIR = path.join(
  os.homedir(),
  '.config',
  'jean-claude',
  'mobile-preview-ca',
);
const ANDROID_NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <debug-overrides>
        <trust-anchors>
            <certificates src="user" />
            <certificates src="system" />
        </trust-anchors>
    </debug-overrides>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="user" />
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;
const ANDROID_DEBUG_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:networkSecurityConfig="@xml/network_security_config"
        android:usesCleartextTraffic="true" />
</manifest>
`;

type MacProxySettings = {
  enabled: boolean;
  server: string;
  port: string;
};

type ConfiguredMacProxy = {
  serviceName: string;
  web: MacProxySettings;
  secureWeb: MacProxySettings;
};

type AdbDevice = {
  id: string;
  state: string;
};

type NetworkProxyServiceOptions = {
  runCommandImpl?: typeof runCommand;
  getLanAddressImpl?: typeof getLanAddress;
  createServer?: typeof http.createServer;
  connectSocket?: typeof net.connect;
  caDirectory?: string;
  lifecycle?: MobilePreviewLifecycle;
  logger?: Pick<typeof console, 'error'>;
};

type PrepareAndroidAppTrustParams = {
  projectPath: string;
  androidProjectPath: string;
};

type GetAndroidAppStatusParams = PrepareAndroidAppTrustParams & {
  deviceId: string;
};

function nowIso() {
  return new Date().toISOString();
}

function headersToRecord(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  Object.entries(headers).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      result[key] =
        key.toLowerCase() === 'set-cookie'
          ? value.join('\n')
          : value.join(', ');
    } else if (typeof value === 'string') {
      result[key] = value;
    }
  });
  return result;
}

function outgoingHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const next = { ...headers };
  delete next['proxy-connection'];
  delete next['proxy-authorization'];
  return next;
}

function appendPreview(chunks: Buffer[], chunk: Buffer) {
  const currentSize = chunks.reduce((total, item) => total + item.length, 0);
  if (currentSize >= PREVIEW_BYTES_LIMIT) return;
  chunks.push(chunk.subarray(0, PREVIEW_BYTES_LIMIT - currentSize));
}

function previewText(chunks: Buffer[]) {
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString('utf8');
}

function safeHostFileName(host: string) {
  return host.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 180);
}

function parseConnectTarget(target: string | undefined): {
  host: string;
  port: number;
} {
  if (!target) {
    throw new Error('CONNECT request is missing target host');
  }

  const parsed = new URL(`https://${target}`);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port || '443');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CONNECT port: ${parsed.port}`);
  }

  const isIpAddress = net.isIP(host) !== 0;
  const isDnsName =
    host.length <= 253 &&
    host
      .split('.')
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
      );
  if (!isIpAddress && !isDnsName) {
    throw new Error(`Invalid CONNECT host: ${host}`);
  }

  return { host, port };
}

function getSubjectAltName(host: string) {
  return net.isIP(host) === 0 ? `DNS:${host}` : `IP:${host}`;
}

function getSocketPeer(socket: {
  remoteAddress?: string;
  remotePort?: number;
}): {
  clientAddress: string | null;
  clientPort: number | null;
} {
  return {
    clientAddress: socket.remoteAddress ?? null,
    clientPort: socket.remotePort ?? null,
  };
}

function parseDefaultNetworkInterface(output: string) {
  return output.match(/^\s*interface:\s*(\S+)/m)?.[1] ?? null;
}

function isVpnMacNetworkInterface(networkInterface: string) {
  return /^utun\d+$/i.test(networkInterface);
}

function parseAdbDevices(output: string): AdbDevice[] {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    line.trim().startsWith('List of devices attached'),
  );
  if (headerIndex === -1) return [];

  return lines.slice(headerIndex + 1).flatMap((line) => {
    const [id, state] = line.trim().split(/\s+/);
    return id && state ? [{ id, state }] : [];
  });
}

function parseAdbAvdName(output: string) {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && line !== 'OK') ?? null
  );
}

function parseHardwareServiceForInterface(output: string, networkInterface: string) {
  const blocks = output.split(/\n\s*\n/);
  for (const block of blocks) {
    const device = block.match(/^\s*Device:\s*(\S+)/m)?.[1];
    if (device !== networkInterface) continue;

    return block.match(/^\s*Hardware Port:\s*(.+)$/m)?.[1]?.trim() ?? null;
  }
  return null;
}

function parseNetworkProxySettings(output: string): MacProxySettings {
  const enabledText = output.match(/^\s*Enabled:\s*(.+)$/im)?.[1]?.trim() ?? '';
  return {
    enabled: /^(yes|on|1)$/i.test(enabledText),
    server: output.match(/^\s*Server:\s*(.*)$/im)?.[1]?.trim() ?? '',
    port: output.match(/^\s*Port:\s*(.*)$/im)?.[1]?.trim() ?? '',
  };
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveProjectRelativePath({
  projectPath,
  relativePath,
}: {
  projectPath: string;
  relativePath: string;
}) {
  const root = path.resolve(projectPath);
  const resolvedPath = path.resolve(root, relativePath || '.');
  const relative = path.relative(root, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Android project path must stay inside the project.');
  }
  return resolvedPath;
}

function ensureManifestApplicationAttribute({
  manifest,
  name,
  value,
}: {
  manifest: string;
  name: string;
  value: string;
}) {
  const applicationTag = manifest.match(/<application\b[^>]*>/);
  if (!applicationTag) {
    throw new Error('AndroidManifest.xml is missing an <application> tag.');
  }

  const currentTag = applicationTag[0];
  const attributePattern = new RegExp(`\\s${name}=("[^"]*"|'[^']*')`);
  const nextTag = attributePattern.test(currentTag)
    ? currentTag.replace(attributePattern, ` ${name}="${value}"`)
    : currentTag.replace(/\s*\/?>$/, `\n        ${name}="${value}"$&`);
  return manifest.replace(currentTag, nextTag);
}

function patchAndroidDebugManifest(manifest: string) {
  let nextManifest = manifest;
  if (!/\sxmlns:android=/.test(nextManifest)) {
    nextManifest = nextManifest.replace(
      /<manifest\b/,
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"',
    );
  }
  nextManifest = ensureManifestApplicationAttribute({
    manifest: nextManifest,
    name: 'android:networkSecurityConfig',
    value: '@xml/network_security_config',
  });
  return ensureManifestApplicationAttribute({
    manifest: nextManifest,
    name: 'android:usesCleartextTraffic',
    value: 'true',
  });
}

async function readFileIfExists(filePath: string) {
  if (!(await pathExists(filePath))) return null;
  return fs.readFile(filePath, 'utf8');
}

function hasAndroidTrustXml(xml: string | null) {
  return !!xml && /<certificates\s+src=("user"|'user')\s*\/?\s*>/.test(xml);
}

function hasAndroidTrustManifest(manifest: string | null) {
  return (
    !!manifest &&
    /android:networkSecurityConfig=("@xml\/network_security_config"|'@xml\/network_security_config')/.test(
      manifest,
    )
  );
}

async function getAndroidTrustFileStatus(absoluteAndroidProjectPath: string) {
  const xmlPath = path.join(
    absoluteAndroidProjectPath,
    'app',
    'src',
    'debug',
    'res',
    'xml',
    'network_security_config.xml',
  );
  const manifestPath = path.join(
    absoluteAndroidProjectPath,
    'app',
    'src',
    'debug',
    'AndroidManifest.xml',
  );
  const [xml, manifest] = await Promise.all([
    readFileIfExists(xmlPath),
    readFileIfExists(manifestPath),
  ]);

  return {
    xmlPath,
    manifestPath,
    xml,
    manifest,
    trustConfigured:
      hasAndroidTrustXml(xml) && hasAndroidTrustManifest(manifest),
  };
}

async function parseAndroidPackageName(absoluteAndroidProjectPath: string) {
  const gradleCandidates = [
    path.join(absoluteAndroidProjectPath, 'app', 'build.gradle'),
    path.join(absoluteAndroidProjectPath, 'app', 'build.gradle.kts'),
  ];
  for (const filePath of gradleCandidates) {
    const content = await readFileIfExists(filePath);
    const applicationId = content?.match(/applicationId\s*[=(]?\s*["']([^"']+)["']/)?.[1];
    if (applicationId) return applicationId;
    const namespace = content?.match(/namespace\s*[=(]?\s*["']([^"']+)["']/)?.[1];
    if (namespace) return namespace;
  }

  const manifest = await readFileIfExists(
    path.join(absoluteAndroidProjectPath, 'app', 'src', 'main', 'AndroidManifest.xml'),
  );
  return manifest?.match(/<manifest\b[^>]*\spackage="([^"]+)"/)?.[1] ?? null;
}

function summarizeCommandOutput(output: string) {
  return output.trim().replace(/\s+/g, ' ').slice(0, 300) || '(empty)';
}

/**
 * A physical iPhone is not the Mac: `127.0.0.1` is the phone's own loopback and
 * `10.0.2.2` is an emulator-only alias, so it can only reach the proxy through
 * the Mac's LAN address.
 *
 * Device kind is resolved with {@link isKnownPhysicalIosDevice} and never from
 * the id format — CoreDevice identifiers and CoreSimulator UDIDs are both
 * UUID-shaped.
 */
function resolveProxyMode({
  platform,
  deviceId,
  autoConfigureDevice,
}: Pick<
  MobilePreviewNetworkProxyStartParams,
  'platform' | 'deviceId' | 'autoConfigureDevice'
>): MobilePreviewNetworkProxySession['mode'] {
  if (autoConfigureDevice === false) return 'manual';
  if (platform === 'android') return 'android-emulator';
  return isKnownPhysicalIosDevice(deviceId) ? 'ios-device' : 'ios-simulator';
}

function resolveProxyHost({
  mode,
  getLanAddressImpl,
}: {
  mode: MobilePreviewNetworkProxySession['mode'];
  getLanAddressImpl: typeof getLanAddress;
}): string {
  if (mode === 'android-emulator') return '10.0.2.2';
  if (mode !== 'ios-device') return '127.0.0.1';
  const lanAddress = getLanAddressImpl();
  if (!lanAddress) {
    throw new Error(
      'No LAN address found for this Mac, so a physical iOS device cannot reach the network proxy. Connect the Mac to Wi-Fi or Ethernet (not just a VPN tunnel) and try again.',
    );
  }
  return lanAddress;
}

/**
 * `xcrun simctl keychain add-root-cert` only resolves CoreSimulator UDIDs, and
 * there is no devicectl equivalent for real hardware, so the CA has to be
 * installed and trusted by hand on the device.
 */
function physicalIosCertificateMessage(certPath: string) {
  return `The proxy certificate can't be installed automatically on a physical iOS device. Copy ${certPath} to the device (AirDrop or email), install the profile in Settings > General > VPN & Device Management, then enable full trust in Settings > General > About > Certificate Trust Settings.`;
}

function createSession({
  params,
  port,
  mode,
  proxyHost,
}: {
  params: MobilePreviewNetworkProxyStartParams;
  port: number;
  mode: MobilePreviewNetworkProxySession['mode'];
  proxyHost: string;
}): MobilePreviewNetworkProxySession {
  return {
    id: crypto.randomUUID(),
    projectPath: params.projectPath,
    appPath: params.appPath,
    platform: params.platform,
    deviceId: params.deviceId,
    status: 'running',
    mode,
    port,
    proxyHost,
    proxyUrl: `http://127.0.0.1:${port}`,
    androidEmulatorProxyUrl: `http://10.0.2.2:${port}`,
    lanProxyUrls: [],
    enableMitm: params.enableMitm ?? false,
    error: null,
    updatedAt: nowIso(),
  };
}

function updateSession(
  session: MobilePreviewNetworkProxySession,
  patch: Partial<MobilePreviewNetworkProxySession>,
): MobilePreviewNetworkProxySession {
  return {
    ...session,
    ...patch,
    updatedAt: nowIso(),
  };
}

export function createMobilePreviewNetworkProxyService({
  runCommandImpl = runCommand,
  getLanAddressImpl = getLanAddress,
  createServer = http.createServer,
  connectSocket = net.connect,
  caDirectory = DEFAULT_CA_DIR,
  lifecycle,
  logger = console,
}: NetworkProxyServiceOptions = {}) {
  const sessions = new Map<
    string,
    {
      session: MobilePreviewNetworkProxySession;
      server: http.Server;
      requestedPort: number;
      configuredAndroidProxy: boolean;
      configuredAndroidAdbSerial: string | null;
      configuredAndroidAdbSerials: Set<string>;
      configuredMacProxy: ConfiguredMacProxy | null;
      sockets: Set<Duplex>;
    }
  >();
  const sessionListeners = new Set<
    (event: MobilePreviewNetworkProxySessionEvent) => void
  >();
  const requestListeners = new Set<
    (event: MobilePreviewNetworkProxyEvent) => void
  >();
  const androidDeviceResolutionCache = new Map<
    string,
    { adbSerial: string; expiresAt: number }
  >();

  function emitSession(session: MobilePreviewNetworkProxySession) {
    sessionListeners.forEach((listener) => listener({ session }));
  }

  function emitRequest(
    sessionId: string,
    request: Omit<MobilePreviewNetworkRequest, 'sessionId'>,
  ) {
    requestListeners.forEach((listener) =>
      listener({ sessionId, request: { ...request, sessionId } }),
    );
  }

  function findSession(params: MobilePreviewNetworkProxyStartParams) {
    const requestedPort = params.port ?? DEFAULT_PROXY_PORT;
    const mode = resolveProxyMode(params);
    return Array.from(sessions.values()).find(
      (entry) =>
        entry.session.projectPath === params.projectPath &&
        entry.session.appPath === params.appPath &&
        entry.session.platform === params.platform &&
        entry.session.deviceId === params.deviceId &&
        entry.requestedPort === requestedPort &&
        entry.session.mode === mode &&
        entry.session.enableMitm === (params.enableMitm ?? false),
    );
  }

  function findSharedSession(params: MobilePreviewNetworkProxyStartParams) {
    const requestedPort = params.port ?? DEFAULT_PROXY_PORT;
    return Array.from(sessions.values()).find(
      (entry) =>
        entry.requestedPort === requestedPort &&
        entry.session.enableMitm === (params.enableMitm ?? false),
    );
  }

  async function clearAndroidProxy(adbSerial: string) {
    dbg.mobilePreview('network-proxy android clear proxy device=%s', adbSerial);
    await Promise.allSettled([
      runCommandImpl('adb', [
        '-s',
        adbSerial,
        'shell',
        'settings',
        'put',
        'global',
        'http_proxy',
        ':0',
      ]),
      runCommandImpl('adb', [
        '-s',
        adbSerial,
        'shell',
        'settings',
        'delete',
        'global',
        'global_http_proxy_host',
      ]),
      runCommandImpl('adb', [
        '-s',
        adbSerial,
        'shell',
        'settings',
        'delete',
        'global',
        'global_http_proxy_port',
      ]),
    ]);
  }

  async function configureAndroidProxy(deviceId: string, port: number) {
    const adbSerial = await resolveAndroidProxyAdbSerial(deviceId);
    await runCommandImpl('adb', [
      '-s',
      adbSerial,
      'shell',
      'settings',
      'put',
      'global',
      'http_proxy',
      `10.0.2.2:${port}`,
    ]);
    dbg.mobilePreview(
      'network-proxy android proxy configured device=%s proxy=10.0.2.2:%d',
      adbSerial,
      port,
    );
    return adbSerial;
  }

  async function resolveAndroidProxyAdbSerial(
    deviceIdOrAvdName: string,
  ): Promise<string>;
  async function resolveAndroidProxyAdbSerial(
    deviceIdOrAvdName: string,
    options: { allowUnresolved: false },
  ): Promise<string | null>;
  async function resolveAndroidProxyAdbSerial(
    deviceIdOrAvdName: string,
    options: { allowUnresolved?: boolean } = {},
  ): Promise<string | null> {
    const cached = androidDeviceResolutionCache.get(deviceIdOrAvdName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.adbSerial;
    }

    const { stdout } = await runCommandImpl('adb', ['devices', '-l']);
    const devices = parseAdbDevices(stdout);
    dbg.mobilePreview(
      'network-proxy android adb devices=%o',
      devices.map((device) => `${device.id}:${device.state}`),
    );
    if (devices.some((device) => device.id === deviceIdOrAvdName)) {
      androidDeviceResolutionCache.set(deviceIdOrAvdName, {
        adbSerial: deviceIdOrAvdName,
        expiresAt: Date.now() + ANDROID_DEVICE_RESOLUTION_CACHE_TTL_MS,
      });
      return deviceIdOrAvdName;
    }

    for (const device of devices) {
      if (!device.id.startsWith('emulator-') || device.state !== 'device') {
        continue;
      }

      try {
        const { stdout: avdOutput } = await runCommandImpl('adb', [
          '-s',
          device.id,
          'emu',
          'avd',
          'name',
        ]);
        if (parseAdbAvdName(avdOutput) === deviceIdOrAvdName) {
          androidDeviceResolutionCache.set(deviceIdOrAvdName, {
            adbSerial: device.id,
            expiresAt: Date.now() + ANDROID_DEVICE_RESOLUTION_CACHE_TTL_MS,
          });
          dbg.mobilePreview(
            'network-proxy android resolved avd=%s serial=%s',
            deviceIdOrAvdName,
            device.id,
          );
          return device.id;
        }
      } catch {
        // Some Android devices do not answer emulator console commands.
      }
    }

    dbg.mobilePreview(
      'network-proxy android using unresolved device id=%s',
      deviceIdOrAvdName,
    );
    return options.allowUnresolved === false ? null : deviceIdOrAvdName;
  }

  /**
   * `adb devices -l` also lists devices that cannot accept shell commands
   * (`unauthorized`, `offline`, ...). Those serials resolve fine, so without
   * this guard `pm list packages` / `am force-stop` would surface raw adb text
   * instead of the actionable reason install and launch already report.
   */
  async function assertAndroidDeviceUsable(adbSerial: string): Promise<void> {
    const { stdout } = await runCommandImpl('adb', ['devices', '-l']);
    const device = parseAdbDevices(stdout).find(
      (candidate) => candidate.id === adbSerial,
    );
    if (!device || device.state === 'device') return;
    if (device.state === 'unauthorized' || device.state === 'authorizing') {
      throw new Error('Accept the USB debugging prompt on the device.');
    }
    if (device.state === 'offline') {
      throw new Error(
        'Device is offline — reconnect the cable or re-enable USB debugging.',
      );
    }
    throw new Error(
      `Device is in "${device.state}" state and cannot be used for preview.`,
    );
  }

  async function prepareAndroidAppTrust(
    params: PrepareAndroidAppTrustParams,
  ): Promise<MobilePreviewAndroidAppTrustResult> {
    const absoluteAndroidProjectPath = resolveProjectRelativePath({
      projectPath: params.projectPath,
      relativePath: params.androidProjectPath,
    });
    dbg.mobilePreview(
      'network-proxy android app-trust start project=%s androidProjectPath=%s absolute=%s',
      params.projectPath,
      params.androidProjectPath,
      absoluteAndroidProjectPath,
    );
    const nativeFiles: string[] = [];
    if (!(await pathExists(absoluteAndroidProjectPath))) {
      dbg.mobilePreview(
        'network-proxy android app-trust missing path=%s',
        absoluteAndroidProjectPath,
      );
      throw new Error(
        'No native Android project found at configured path. Set the Android project folder, then prepare app trust.',
      );
    }

    const trustStatus = await getAndroidTrustFileStatus(
      absoluteAndroidProjectPath,
    );
    const { xmlPath, manifestPath } = trustStatus;
    let changed = false;
    await fs.mkdir(path.dirname(xmlPath), { recursive: true });
    if (!hasAndroidTrustXml(trustStatus.xml)) {
      await fs.writeFile(xmlPath, ANDROID_NETWORK_SECURITY_CONFIG);
      changed = true;
      dbg.mobilePreview('network-proxy android app-trust wrote xml=%s', xmlPath);
      nativeFiles.push(xmlPath);
    }

    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    if (trustStatus.manifest !== null) {
      const nextManifest = patchAndroidDebugManifest(trustStatus.manifest);
      if (nextManifest !== trustStatus.manifest) {
        await fs.writeFile(manifestPath, nextManifest);
        changed = true;
        nativeFiles.push(manifestPath);
      }
      dbg.mobilePreview(
        'network-proxy android app-trust patched manifest=%s',
        manifestPath,
      );
    } else {
      await fs.writeFile(manifestPath, ANDROID_DEBUG_MANIFEST);
      changed = true;
      nativeFiles.push(manifestPath);
      dbg.mobilePreview(
        'network-proxy android app-trust created manifest=%s',
        manifestPath,
      );
    }

    return {
      appPath: absoluteAndroidProjectPath,
      nativeFiles,
      message:
        changed
          ? 'Android debug trust files updated. Rebuild and reinstall the debug app before decrypting HTTPS.'
          : 'Android debug trust files already configured.',
      changed,
      updatedAt: nowIso(),
    };
  }

  async function getAndroidAppStatus(
    params: GetAndroidAppStatusParams,
  ): Promise<MobilePreviewAndroidAppStatus> {
    const absoluteAndroidProjectPath = resolveProjectRelativePath({
      projectPath: params.projectPath,
      relativePath: params.androidProjectPath,
    });
    if (!(await pathExists(absoluteAndroidProjectPath))) {
      throw new Error('No native Android project found at configured path.');
    }

    const [trustStatus, packageName] = await Promise.all([
      getAndroidTrustFileStatus(absoluteAndroidProjectPath),
      parseAndroidPackageName(absoluteAndroidProjectPath),
    ]);

    if (!packageName) {
      return {
        appInstalled: null,
        packageName: null,
        trustConfigured: trustStatus.trustConfigured,
      };
    }

    const adbSerial = await resolveAndroidProxyAdbSerial(params.deviceId, {
      allowUnresolved: false,
    });
    if (!adbSerial) {
      return {
        appInstalled: null,
        packageName,
        trustConfigured: trustStatus.trustConfigured,
      };
    }
    await assertAndroidDeviceUsable(adbSerial);
    const { stdout } = await runCommandImpl('adb', [
      '-s',
      adbSerial,
      'shell',
      'pm',
      'list',
      'packages',
      packageName,
    ]);

    return {
      appInstalled: stdout
        .split(/\r?\n/)
        .some((line) => line.trim() === `package:${packageName}`),
      packageName,
      trustConfigured: trustStatus.trustConfigured,
    };
  }

  async function restartAndroidApp(
    params: GetAndroidAppStatusParams,
  ): Promise<{ packageName: string; restartedAt: string }> {
    const absoluteAndroidProjectPath = resolveProjectRelativePath({
      projectPath: params.projectPath,
      relativePath: params.androidProjectPath,
    });
    if (!(await pathExists(absoluteAndroidProjectPath))) {
      throw new Error('No native Android project found at configured path.');
    }

    const packageName = await parseAndroidPackageName(absoluteAndroidProjectPath);
    if (!packageName) {
      throw new Error('Unable to detect Android package id.');
    }

    const adbSerial = await resolveAndroidProxyAdbSerial(params.deviceId);
    await assertAndroidDeviceUsable(adbSerial);
    dbg.mobilePreview(
      'network-proxy android app restart device=%s package=%s',
      adbSerial,
      packageName,
    );
    await runCommandImpl('adb', [
      '-s',
      adbSerial,
      'shell',
      'am',
      'force-stop',
      packageName,
    ]);
    await runCommandImpl('adb', [
      '-s',
      adbSerial,
      'shell',
      'monkey',
      '-p',
      packageName,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);

    return { packageName, restartedAt: nowIso() };
  }

  async function installAndroidUserCertificate({
    deviceId,
    certPath,
  }: {
    deviceId: string;
    certPath: string;
  }) {
    const adbSerial = await resolveAndroidProxyAdbSerial(deviceId);
    const remoteCertPath = '/sdcard/Download/jean-claude-mobile-preview-ca.crt';
    dbg.mobilePreview(
      'network-proxy android user-cert install start inputDevice=%s resolvedDevice=%s cert=%s remote=%s',
      deviceId,
      adbSerial,
      certPath,
      remoteCertPath,
    );

    const pushResult = await runCommandImpl('adb', [
      '-s',
      adbSerial,
      'push',
      certPath,
      remoteCertPath,
    ]);
    dbg.mobilePreview(
      'network-proxy android user-cert pushed for settings output=%s',
      summarizeCommandOutput(`${pushResult.stdout}\n${pushResult.stderr}`),
    );

    await runCommandImpl('adb', [
      '-s',
      adbSerial,
      'shell',
      'am',
      'start',
      '-a',
      'com.android.credentials.INSTALL',
    ]);
    dbg.mobilePreview(
      'network-proxy android settings cert install opened device=%s remote=%s',
      adbSerial,
      remoteCertPath,
    );
  }

  async function configureMacProxy(port: number): Promise<ConfiguredMacProxy> {
    const { stdout: routeOutput } = await runCommandImpl('route', [
      '-n',
      'get',
      'default',
    ]);
    const networkInterface = parseDefaultNetworkInterface(routeOutput);
    if (!networkInterface) {
      throw new Error('Unable to detect active macOS network interface.');
    }

    const { stdout: hardwareOutput } = await runCommandImpl('networksetup', [
      '-listallhardwareports',
    ]);
    const serviceName = parseHardwareServiceForInterface(
      hardwareOutput,
      networkInterface,
    );
    if (!serviceName) {
      if (isVpnMacNetworkInterface(networkInterface)) {
        throw new Error(
          'Network proxy capture is not available while a VPN is controlling macOS routing. Disconnect the VPN, then start network capture again.',
        );
      }
      throw new Error(
        `Unable to map macOS interface ${networkInterface} to a network service.`,
      );
    }

    const [{ stdout: webOutput }, { stdout: secureWebOutput }] =
      await Promise.all([
        runCommandImpl('networksetup', ['-getwebproxy', serviceName]),
        runCommandImpl('networksetup', ['-getsecurewebproxy', serviceName]),
      ]);
    const previous = {
      serviceName,
      web: parseNetworkProxySettings(webOutput),
      secureWeb: parseNetworkProxySettings(secureWebOutput),
    };

    try {
      await runCommandImpl('networksetup', [
        '-setwebproxy',
        serviceName,
        '127.0.0.1',
        String(port),
      ]);
      await runCommandImpl('networksetup', [
        '-setsecurewebproxy',
        serviceName,
        '127.0.0.1',
        String(port),
      ]);
      await runCommandImpl('networksetup', [
        '-setwebproxystate',
        serviceName,
        'on',
      ]);
      await runCommandImpl('networksetup', [
        '-setsecurewebproxystate',
        serviceName,
        'on',
      ]);
    } catch (error) {
      await restoreMacProxy(previous).catch(() => undefined);
      throw error;
    }

    return previous;
  }

  async function restoreMacProxy(previous: ConfiguredMacProxy) {
    if (previous.web.server && previous.web.port) {
      await runCommandImpl('networksetup', [
        '-setwebproxy',
        previous.serviceName,
        previous.web.server,
        previous.web.port,
      ]);
    }
    await runCommandImpl('networksetup', [
      '-setwebproxystate',
      previous.serviceName,
      previous.web.enabled ? 'on' : 'off',
    ]);

    if (previous.secureWeb.server && previous.secureWeb.port) {
      await runCommandImpl('networksetup', [
        '-setsecurewebproxy',
        previous.serviceName,
        previous.secureWeb.server,
        previous.secureWeb.port,
      ]);
    }
    await runCommandImpl('networksetup', [
      '-setsecurewebproxystate',
      previous.serviceName,
      previous.secureWeb.enabled ? 'on' : 'off',
    ]);
  }

  async function ensureCaCertificate(): Promise<{
    certPath: string;
    keyPath: string;
  }> {
    await fs.mkdir(caDirectory, { recursive: true, mode: 0o700 });
    const certPath = path.join(
      caDirectory,
      'jean-claude-mobile-preview-ca.pem',
    );
    const keyPath = path.join(caDirectory, 'jean-claude-mobile-preview-ca.key');
    const configPath = path.join(caDirectory, 'openssl.cnf');

    try {
      await fs.access(certPath);
      await fs.access(keyPath);
      return { certPath, keyPath };
    } catch {
      // Generate below.
    }

    await fs.writeFile(
      configPath,
      [
        '[req]',
        'distinguished_name = dn',
        'x509_extensions = v3_ca',
        'prompt = no',
        '',
        '[dn]',
        'CN = Jean-Claude Mobile Preview Proxy CA',
        '',
        '[v3_ca]',
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always,issuer',
        'basicConstraints = critical,CA:true',
        'keyUsage = critical,keyCertSign,cRLSign',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    await runCommandImpl('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '3650',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-config',
      configPath,
    ]);
    await fs.chmod(keyPath, 0o600);
    await fs.chmod(certPath, 0o644);
    return { certPath, keyPath };
  }

  async function ensureHostCertificate(host: string): Promise<{
    certPath: string;
    keyPath: string;
  }> {
    const { certPath: caCertPath, keyPath: caKeyPath } =
      await ensureCaCertificate();
    const certDir = path.join(caDirectory, 'hosts');
    await fs.mkdir(certDir, { recursive: true, mode: 0o700 });
    const safeHost = safeHostFileName(host);
    const certPath = path.join(certDir, `${safeHost}.pem`);
    const keyPath = path.join(certDir, `${safeHost}.key`);
    const csrPath = path.join(certDir, `${safeHost}.csr`);
    const configPath = path.join(certDir, `${safeHost}.cnf`);

    try {
      await fs.access(certPath);
      await fs.access(keyPath);
      return { certPath, keyPath };
    } catch {
      // Generate below.
    }

    await fs.writeFile(
      configPath,
      [
        '[req]',
        'distinguished_name = dn',
        'req_extensions = v3_req',
        'prompt = no',
        '',
        '[dn]',
        `CN = ${host}`,
        '',
        '[v3_req]',
        'basicConstraints = CA:FALSE',
        'keyUsage = digitalSignature,keyEncipherment',
        'extendedKeyUsage = serverAuth',
        `subjectAltName = ${getSubjectAltName(host)}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    await runCommandImpl('openssl', ['genrsa', '-out', keyPath, '2048']);
    await runCommandImpl('openssl', [
      'req',
      '-new',
      '-key',
      keyPath,
      '-out',
      csrPath,
      '-config',
      configPath,
    ]);
    await runCommandImpl('openssl', [
      'x509',
      '-req',
      '-in',
      csrPath,
      '-CA',
      caCertPath,
      '-CAkey',
      caKeyPath,
      '-CAcreateserial',
      '-out',
      certPath,
      '-days',
      '825',
      '-sha256',
      '-extensions',
      'v3_req',
      '-extfile',
      configPath,
    ]);
    await fs.chmod(keyPath, 0o600);
    await fs.chmod(certPath, 0o644);
    return { certPath, keyPath };
  }

  function forwardRequest({
    sessionId,
    clientRequest,
    clientResponse,
    targetUrl,
    decrypted,
  }: {
    sessionId: string;
    clientRequest: http.IncomingMessage;
    clientResponse: http.ServerResponse;
    targetUrl: string;
    decrypted: boolean;
  }) {
    const startedAtMs = Date.now();
    const startedAt = nowIso();
    const requestBodyChunks: Buffer[] = [];
    const responseBodyChunks: Buffer[] = [];
    const requestId = crypto.randomUUID();
    const clientPeer = getSocketPeer(clientRequest.socket);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      clientResponse.writeHead(400);
      clientResponse.end('Proxy requires absolute HTTP URL');
      emitRequest(sessionId, {
        id: requestId,
        method: clientRequest.method ?? 'GET',
        url: targetUrl,
        status: 400,
        requestHeaders: headersToRecord(clientRequest.headers),
        responseHeaders: {},
        requestBodyPreview: null,
        responseBodyPreview: 'Proxy requires absolute HTTP URL',
        ...clientPeer,
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - startedAtMs,
        error: 'Proxy requires absolute HTTP URL',
        tunnelOnly: false,
        decrypted,
        captureSource: decrypted ? 'mitm' : 'proxied',
      });
      return;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      clientResponse.writeHead(400);
      clientResponse.end('Unsupported proxy URL protocol');
      emitRequest(sessionId, {
        id: requestId,
        method: clientRequest.method ?? 'GET',
        url: targetUrl,
        status: 400,
        requestHeaders: headersToRecord(clientRequest.headers),
        responseHeaders: {},
        requestBodyPreview: null,
        responseBodyPreview: 'Unsupported proxy URL protocol',
        ...clientPeer,
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - startedAtMs,
        error: 'Unsupported proxy URL protocol',
        tunnelOnly: false,
        decrypted,
        captureSource: decrypted ? 'mitm' : 'proxied',
      });
      return;
    }

    const requestImpl = parsedUrl.protocol === 'https:' ? https : http;
    const proxyRequest = requestImpl.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        method: clientRequest.method,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: outgoingHeaders(clientRequest.headers),
      },
      (proxyResponse) => {
        clientResponse.writeHead(
          proxyResponse.statusCode ?? 502,
          proxyResponse.headers,
        );

        proxyResponse.on('data', (chunk: Buffer) => {
          appendPreview(responseBodyChunks, chunk);
          clientResponse.write(chunk);
        });
        proxyResponse.on('end', () => {
          clientResponse.end();
          emitRequest(sessionId, {
            id: requestId,
            method: clientRequest.method ?? 'GET',
            url: targetUrl,
            status: proxyResponse.statusCode ?? null,
            requestHeaders: headersToRecord(clientRequest.headers),
            responseHeaders: headersToRecord(proxyResponse.headers),
            requestBodyPreview: previewText(requestBodyChunks),
            responseBodyPreview: previewText(responseBodyChunks),
            ...clientPeer,
            startedAt,
            endedAt: nowIso(),
            durationMs: Date.now() - startedAtMs,
            error: null,
            tunnelOnly: false,
            decrypted,
            // CONNECT tunnel events stay "tunneled"; decrypted HTTPS requests
            // forwarded from the MITM HTTP server are captured as "mitm".
            captureSource: decrypted ? 'mitm' : 'proxied',
          });
        });
      },
    );

    proxyRequest.on('error', (error) => {
      clientResponse.writeHead(502);
      clientResponse.end(error.message);
      emitRequest(sessionId, {
        id: requestId,
        method: clientRequest.method ?? 'GET',
        url: targetUrl,
        status: 502,
        requestHeaders: headersToRecord(clientRequest.headers),
        responseHeaders: {},
        requestBodyPreview: previewText(requestBodyChunks),
        responseBodyPreview: error.message,
        ...clientPeer,
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - startedAtMs,
        error: error.message,
        tunnelOnly: false,
        decrypted,
        captureSource: decrypted ? 'mitm' : 'proxied',
      });
    });

    clientRequest.on('data', (chunk: Buffer) => {
      appendPreview(requestBodyChunks, chunk);
      proxyRequest.write(chunk);
    });
    clientRequest.on('end', () => {
      proxyRequest.end();
    });
  }

  function createProxyServer(
    getSession: () => MobilePreviewNetworkProxySession,
    trackSocket: (socket: Duplex) => void,
  ) {
    const server = createServer((clientRequest, clientResponse) => {
      forwardRequest({
        sessionId: getSession().id,
        clientRequest,
        clientResponse,
        targetUrl: clientRequest.url ?? '',
        decrypted: false,
      });
    });

    async function handleMitmConnect({
      request,
      clientSocket,
      host,
      port,
      head,
      startedAt,
      startedAtMs,
      requestId,
      clientPeer,
    }: {
      request: http.IncomingMessage;
      clientSocket: Duplex;
      host: string;
      port: number;
      head: Buffer;
      startedAt: string;
      startedAtMs: number;
      requestId: string;
      clientPeer: ReturnType<typeof getSocketPeer>;
    }) {
      const { certPath, keyPath } = await ensureHostCertificate(host);
      const secureContext = tls.createSecureContext({
        cert: await fs.readFile(certPath),
        key: await fs.readFile(keyPath),
      });
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        secureContext,
      });
      if (head.length > 0) tlsSocket.unshift(head);
      const mitmServer = http.createServer((mitmRequest, mitmResponse) => {
        forwardRequest({
          sessionId: getSession().id,
          clientRequest: mitmRequest,
          clientResponse: mitmResponse,
          targetUrl: `https://${host}:${port}${mitmRequest.url ?? '/'}`,
          decrypted: true,
        });
      });

      tlsSocket.once('secure', () => {
        mitmServer.emit('connection', tlsSocket);
        emitRequest(getSession().id, {
          id: requestId,
          method: 'CONNECT',
          url: `https://${request.url ?? ''}`,
          status: 200,
          requestHeaders: headersToRecord(request.headers),
          responseHeaders: {},
          requestBodyPreview: null,
          responseBodyPreview: null,
          ...clientPeer,
          startedAt,
          endedAt: nowIso(),
          durationMs: Date.now() - startedAtMs,
          error: null,
          tunnelOnly: true,
          decrypted: false,
          captureSource: 'tunneled',
        });
      });
      tlsSocket.once('error', (error) => {
        emitRequest(getSession().id, {
          id: requestId,
          method: 'CONNECT',
          url: `https://${request.url ?? ''}`,
          status: 502,
          requestHeaders: headersToRecord(request.headers),
          responseHeaders: {},
          requestBodyPreview: null,
          responseBodyPreview: null,
          ...clientPeer,
          startedAt,
          endedAt: nowIso(),
          durationMs: Date.now() - startedAtMs,
          error: error.message,
          tunnelOnly: true,
          decrypted: false,
          captureSource: 'tunneled',
        });
        tlsSocket.destroy();
      });
    }

    server.on('connect', (request, clientSocket, head) => {
      const startedAtMs = Date.now();
      const startedAt = nowIso();
      const requestId = crypto.randomUUID();
      const session = getSession();
      const clientPeer = getSocketPeer(clientSocket as net.Socket);
      trackSocket(clientSocket);

      let target: { host: string; port: number };
      try {
        target = parseConnectTarget(request.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        emitRequest(session.id, {
          id: requestId,
          method: 'CONNECT',
          url: `https://${request.url ?? ''}`,
          status: 400,
          requestHeaders: headersToRecord(request.headers),
          responseHeaders: {},
          requestBodyPreview: null,
          responseBodyPreview: null,
          ...clientPeer,
          startedAt,
          endedAt: nowIso(),
          durationMs: Date.now() - startedAtMs,
          error: message,
          tunnelOnly: true,
          decrypted: false,
          captureSource: 'tunneled',
        });
        return;
      }

      if (session.enableMitm) {
        void handleMitmConnect({
          request,
          clientSocket,
          host: target.host,
          port: target.port,
          head,
          startedAt,
          startedAtMs,
          requestId,
          clientPeer,
        }).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          dbg.mobilePreview(
            'network-proxy mitm setup failed target=%s:%d message=%s',
            target.host,
            target.port,
            message,
          );
          clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          emitRequest(getSession().id, {
            id: requestId,
            method: 'CONNECT',
            url: `https://${request.url ?? ''}`,
            status: 502,
            requestHeaders: headersToRecord(request.headers),
            responseHeaders: {},
            requestBodyPreview: null,
            responseBodyPreview: null,
            ...clientPeer,
            startedAt,
            endedAt: nowIso(),
            durationMs: Date.now() - startedAtMs,
            error: message,
            tunnelOnly: true,
            decrypted: false,
            captureSource: 'tunneled',
          });
        });
        return;
      }

      const targetSocket = connectSocket(target.port, target.host);
      trackSocket(targetSocket);

      targetSocket.on('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) targetSocket.write(head);
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
        emitRequest(session.id, {
          id: requestId,
          method: 'CONNECT',
          url: `https://${request.url ?? ''}`,
          status: 200,
          requestHeaders: headersToRecord(request.headers),
          responseHeaders: {},
          requestBodyPreview: null,
          responseBodyPreview: null,
          ...clientPeer,
          startedAt,
          endedAt: nowIso(),
          durationMs: Date.now() - startedAtMs,
          error: null,
          tunnelOnly: true,
          decrypted: false,
          captureSource: 'tunneled',
        });
      });
      targetSocket.on('error', (error) => {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        emitRequest(session.id, {
          id: requestId,
          method: 'CONNECT',
          url: `https://${request.url ?? ''}`,
          status: 502,
          requestHeaders: headersToRecord(request.headers),
          responseHeaders: {},
          requestBodyPreview: null,
          responseBodyPreview: null,
          ...clientPeer,
          startedAt,
          endedAt: nowIso(),
          durationMs: Date.now() - startedAtMs,
          error: error.message,
          tunnelOnly: true,
          decrypted: false,
          captureSource: 'tunneled',
        });
      });
    });

    return server;
  }

  const service = {
    onSession(
      listener: (event: MobilePreviewNetworkProxySessionEvent) => void,
    ) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },

    onRequest(listener: (event: MobilePreviewNetworkProxyEvent) => void) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },

    async start(
      params: MobilePreviewNetworkProxyStartParams,
    ): Promise<MobilePreviewNetworkProxySession> {
      dbg.mobilePreview('network-proxy start params=%o', {
        projectPath: params.projectPath,
        appPath: params.appPath,
        platform: params.platform,
        deviceId: params.deviceId,
        port: params.port,
        autoConfigureDevice: params.autoConfigureDevice,
        enableMitm: params.enableMitm,
      });
      const existing = findSession(params);
      if (existing) {
        dbg.mobilePreview(
          'network-proxy reuse session=%s mode=%s port=%d mitm=%s',
          existing.session.id,
          existing.session.mode,
          existing.session.port,
          existing.session.enableMitm,
        );
        return existing.session;
      }

      const requestedPort = params.port ?? DEFAULT_PROXY_PORT;
      const mode = resolveProxyMode(params);
      const shouldConfigureAndroid = mode === 'android-emulator';
      // Only a simulator borrows the Mac's own proxy settings; a physical
      // iPhone has its own Wi-Fi proxy configuration and pointing the Mac at
      // the proxy would do nothing for it.
      const shouldConfigureIos = mode === 'ios-simulator';
      // Resolved before the server binds so a missing LAN address fails fast
      // instead of leaving a listener behind.
      const proxyHost = resolveProxyHost({ mode, getLanAddressImpl });
      const shared = findSharedSession(params);
      if (shared) {
        if (shouldConfigureAndroid) {
          const adbSerial = await configureAndroidProxy(
            params.deviceId,
            shared.session.port,
          );
          shared.configuredAndroidProxy = true;
          shared.configuredAndroidAdbSerial ??= adbSerial;
          shared.configuredAndroidAdbSerials.add(adbSerial);
        }
        if (shouldConfigureIos && !shared.configuredMacProxy) {
          shared.configuredMacProxy = await configureMacProxy(shared.session.port);
        }
        Object.assign(shared.session, {
          projectPath: params.projectPath,
          appPath: params.appPath,
          platform: params.platform,
          deviceId: params.deviceId,
          mode,
          proxyHost,
          updatedAt: nowIso(),
        });
        emitSession(shared.session);
        dbg.mobilePreview(
          'network-proxy reuse shared session=%s mode=%s port=%d mitm=%s',
          shared.session.id,
          shared.session.mode,
          shared.session.port,
          shared.session.enableMitm,
        );
        return shared.session;
      }
      if (
        shouldConfigureIos &&
        Array.from(sessions.values()).some((entry) => entry.configuredMacProxy)
      ) {
        throw new Error(
          'An iOS simulator proxy session is already active. Stop it before starting another.',
        );
      }
      let session: MobilePreviewNetworkProxySession | null = null;
      let configuredMacProxy: ConfiguredMacProxy | null = null;
      let configuredAndroidAdbSerial: string | null = null;
      const sockets = new Set<Duplex>();
      const trackSocket = (socket: Duplex) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      };
      const server = createProxyServer(() => {
        if (!session) {
          throw new Error('Network proxy session is not ready');
        }
        return session;
      }, trackSocket);
      server.on('connection', trackSocket);

      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, '127.0.0.1', () => {
          server.off('error', reject);
          const address = server.address();
          resolve(
            typeof address === 'object' && address
              ? address.port
              : requestedPort,
          );
        });
      });

      session = createSession({
        params,
        port,
        mode,
        proxyHost,
      });

      if (shouldConfigureAndroid) {
        try {
          configuredAndroidAdbSerial = await configureAndroidProxy(
            params.deviceId,
            port,
          );
        } catch (error) {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
          throw error;
        }
      }
      if (shouldConfigureIos) {
        try {
          configuredMacProxy = await configureMacProxy(port);
        } catch (error) {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
          throw error;
        }
      }

      sessions.set(session.id, {
        session,
        server,
        requestedPort,
        configuredAndroidProxy: shouldConfigureAndroid,
        configuredAndroidAdbSerial,
        configuredAndroidAdbSerials: new Set(
          configuredAndroidAdbSerial ? [configuredAndroidAdbSerial] : [],
        ),
        configuredMacProxy,
        sockets,
      });
      dbg.mobilePreview(
        'network-proxy session started id=%s mode=%s port=%d mitm=%s androidDevice=%s',
        session.id,
        session.mode,
        session.port,
        session.enableMitm,
        configuredAndroidAdbSerial ?? '(none)',
      );
      emitSession(session);
      return session;
    },

    async installCertificate(
      params: MobilePreviewNetworkProxyCertificateParams,
    ): Promise<MobilePreviewNetworkProxyCertificate> {
      const { certPath } = await ensureCaCertificate();
      dbg.mobilePreview(
        'network-proxy install certificate platform=%s device=%s cert=%s',
        params.platform,
        params.deviceId,
        certPath,
      );
      if (params.platform === 'ios' && isKnownPhysicalIosDevice(params.deviceId)) {
        // No simctl (or devicectl) equivalent exists for real hardware, so this
        // is guidance rather than an error — the rest of setup still works.
        dbg.mobilePreview(
          'network-proxy ios physical cert manual device=%s cert=%s',
          params.deviceId,
          certPath,
        );
        return {
          platform: params.platform,
          deviceId: params.deviceId,
          certPath,
          installedAt: nowIso(),
          installed: false,
          message: physicalIosCertificateMessage(certPath),
        };
      }
      if (params.platform === 'ios') {
        await runCommandImpl('xcrun', [
          'simctl',
          'keychain',
          params.deviceId,
          'add-root-cert',
          certPath,
        ]);
        dbg.mobilePreview(
          'network-proxy ios root cert installed device=%s cert=%s',
          params.deviceId,
          certPath,
        );
      } else {
        await installAndroidUserCertificate({
          deviceId: params.deviceId,
          certPath,
        });
      }
      return {
        platform: params.platform,
        deviceId: params.deviceId,
        certPath,
        installedAt: nowIso(),
        installed: true,
        message: null,
      };
    },

    prepareAndroidAppTrust,
    getAndroidAppStatus,
    restartAndroidApp,

    async stop(sessionId: string): Promise<void> {
      const existing = sessions.get(sessionId);
      if (!existing) return;

      sessions.delete(sessionId);
      if (existing.configuredAndroidProxy) {
        await Promise.all(
          Array.from(existing.configuredAndroidAdbSerials).map((adbSerial) =>
            clearAndroidProxy(adbSerial).catch(() => undefined),
          ),
        );
      }
      if (existing.configuredMacProxy) {
        await restoreMacProxy(existing.configuredMacProxy).catch(
          () => undefined,
        );
      }
      existing.sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => {
        existing.server.close(() => resolve());
      });
      emitSession(
        updateSession(existing.session, {
          status: 'stopped',
          error: null,
        }),
      );
    },

    async stopAll(): Promise<void> {
      await Promise.all(
        Array.from(sessions.keys()).map((id) => service.stop(id)),
      );
    },
  };

  if (lifecycle) {
    registerBeforeQuitCleanup({
      cleanup: service.stopAll,
      lifecycle,
      logger,
    });
  }

  return service;
}

export const mobilePreviewNetworkProxyService =
  createMobilePreviewNetworkProxyService({
    lifecycle: app
      ? {
          onBeforeQuit: (callback) => app.on('before-quit', callback),
        }
      : undefined,
  });
