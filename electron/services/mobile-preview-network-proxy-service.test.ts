import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  rememberPhysicalIosDevices,
  resetKnownPhysicalIosDevicesForTests,
} from './mobile-preview-ios-devicectl';
import { createMobilePreviewNetworkProxyService } from './mobile-preview-network-proxy-service';

const PHYSICAL_IOS_DEVICE_ID = 'D0C5D914-1111-2222-3333-444455556666';

/**
 * A CoreDevice identifier is UUID-shaped exactly like a CoreSimulator UDID, so
 * the only way the service can tell them apart is the devicectl registry.
 */
function registerPhysicalIosDevice(id = PHYSICAL_IOS_DEVICE_ID) {
  rememberPhysicalIosDevices({
    devices: [
      {
        id,
        name: "Patrick's iPhone",
        platform: 'ios',
        state: 'booted',
        kind: 'physical',
      },
    ],
    listingSucceeded: true,
  });
}

const servers: http.Server[] = [];
const services: Array<ReturnType<typeof createMobilePreviewNetworkProxyService>> =
  [];

function createService(
  ...args: Parameters<typeof createMobilePreviewNetworkProxyService>
) {
  const service = createMobilePreviewNetworkProxyService(...args);
  services.push(service);
  return service;
}

function listen(server: http.Server) {
  servers.push(server);
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Missing server address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stopAll()));
  await Promise.all(servers.splice(0).map(closeServer));
  resetKnownPhysicalIosDevicesForTests();
});

describe('mobile preview network proxy service', () => {
  it('throws when preparing Android app trust without native android project', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'jc-proxy-app-trust-'));
    const service = createService();

    await expect(
      service.prepareAndroidAppTrust({
        projectPath: tempDir,
        androidProjectPath: 'android',
      }),
    ).rejects.toThrow('No native Android project found at configured path');
  });

  it('writes native Android debug trust files when android project exists', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'jc-proxy-native-trust-'));
    await fs.mkdir(path.join(tempDir, 'android'), { recursive: true });
    const service = createService();

    const result = await service.prepareAndroidAppTrust({
      projectPath: tempDir,
      androidProjectPath: 'android',
    });

    const xmlPath = path.join(
      tempDir,
      'android',
      'app',
      'src',
      'debug',
      'res',
      'xml',
      'network_security_config.xml',
    );
    const manifestPath = path.join(
      tempDir,
      'android',
      'app',
      'src',
      'debug',
      'AndroidManifest.xml',
    );
    expect(result.nativeFiles).toEqual([xmlPath, manifestPath]);
    await expect(fs.access(xmlPath)).resolves.toBeUndefined();
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
    await expect(fs.readFile(xmlPath, 'utf8')).resolves.toContain(
      '<certificates src="user" />',
    );
  });

  it('patches existing Android debug manifest app trust attributes', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(
      path.join(tempRoot, 'jc-proxy-manifest-trust-'),
    );
    const manifestPath = path.join(
      tempDir,
      'android',
      'app',
      'src',
      'debug',
      'AndroidManifest.xml',
    );
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      [
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        '    <application android:label="@string/app_name" />',
        '</manifest>',
      ].join('\n'),
    );
    const service = createService();

    await service.prepareAndroidAppTrust({
      projectPath: tempDir,
      androidProjectPath: 'android',
    });

    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toContain(
      'android:networkSecurityConfig="@xml/network_security_config"',
    );
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toContain(
      'android:usesCleartextTraffic="true"',
    );
  });

  it('returns unknown app install status for unresolved Android AVD names before boot completes', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'jc-proxy-avd-resolve-'));
    const androidProjectPath = path.join(tempDir, 'android');
    const gradlePath = path.join(androidProjectPath, 'app', 'build.gradle');
    await fs.mkdir(path.dirname(gradlePath), { recursive: true });
    await fs.writeFile(gradlePath, 'android { applicationId "com.example.app" }');

    let booted = false;
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      const commandText = `${command} ${args.join(' ')}`;
      if (commandText === 'adb devices -l') {
        return {
          stdout: booted
            ? 'List of devices attached\nemulator-5554 device model:Medium_Phone\n'
            : 'List of devices attached\n',
          stderr: '',
        };
      }
      if (commandText === 'adb -s emulator-5554 emu avd name') {
        return { stdout: 'Medium_Phone\nOK\n', stderr: '' };
      }
      if (
        commandText ===
        'adb -s emulator-5554 shell pm list packages com.example.app'
      ) {
        return { stdout: 'package:com.example.app\n', stderr: '' };
      }
      expect(commandText).not.toBe(
        'adb -s Medium_Phone shell pm list packages com.example.app',
      );
      throw new Error(`Unexpected command: ${commandText}`);
    });
    const service = createService({ runCommandImpl: runCommandImpl as never });
    const params = {
      projectPath: tempDir,
      androidProjectPath: 'android',
      deviceId: 'Medium_Phone',
    };

    await expect(service.getAndroidAppStatus(params)).resolves.toMatchObject({
      appInstalled: null,
      packageName: 'com.example.app',
    });
    booted = true;

    await expect(service.getAndroidAppStatus(params)).resolves.toMatchObject({
      appInstalled: true,
      packageName: 'com.example.app',
    });
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'pm',
      'list',
      'packages',
      'com.example.app',
    ]);
  });

  it('surfaces the actionable reason for an unauthorized physical Android device', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(
      path.join(tempRoot, 'jc-proxy-unauthorized-'),
    );
    const gradlePath = path.join(tempDir, 'android', 'app', 'build.gradle');
    await fs.mkdir(path.dirname(gradlePath), { recursive: true });
    await fs.writeFile(gradlePath, 'android { applicationId "com.example.app" }');

    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      const commandText = `${command} ${args.join(' ')}`;
      if (commandText === 'adb devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D unauthorized usb:1-2\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${commandText}`);
    });
    const service = createService({ runCommandImpl: runCommandImpl as never });
    const params = {
      projectPath: tempDir,
      androidProjectPath: 'android',
      deviceId: '1A2B3C4D',
    };

    await expect(service.getAndroidAppStatus(params)).rejects.toThrow(
      'Accept the USB debugging prompt on the device.',
    );
    await expect(service.restartAndroidApp(params)).rejects.toThrow(
      'Accept the USB debugging prompt on the device.',
    );
  });

  it('forwards HTTP requests and emits captured request data', async () => {
    const target = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'text/plain' });
        response.end(`ok:${request.method}:${request.url}:${body}`);
      });
    });
    const targetPort = await listen(target);
    const service = createService();
    const captured: string[] = [];
    service.onRequest((event) => {
      captured.push(
        `${event.request.captureSource}:${event.request.method}:${event.request.status}:${event.request.responseBodyPreview}`,
      );
    });
    const session = await service.start({
      projectPath: '/project',
      appPath: '.',
      platform: 'ios',
      deviceId: 'ios-1',
      port: 0,
      autoConfigureDevice: false,
    });
    expect(session.lanProxyUrls).toEqual([]);

    const result = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: session.port,
          method: 'POST',
          path: `http://127.0.0.1:${targetPort}/api?a=1`,
          headers: { 'content-type': 'text/plain' },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          response.on('end', () => resolve(body));
        },
      );
      request.on('error', reject);
      request.end('hello');
    });

    expect(result).toBe('ok:POST:/api?a=1:hello');
    expect(captured).toEqual(['proxied:POST:201:ok:POST:/api?a=1:hello']);
  });

  it('reuses ephemeral port sessions with matching start parameters', async () => {
    const service = createService();
    const params = {
      projectPath: '/project',
      appPath: '.',
      platform: 'ios' as const,
      deviceId: 'ios-1',
      port: 0,
      autoConfigureDevice: false,
    };

    const firstSession = await service.start(params);
    const secondSession = await service.start(params);

    expect(secondSession.id).toBe(firstSession.id);
    expect(secondSession.port).toBe(firstSession.port);
  });

  it('emits tunneled capture source for CONNECT tunnels', async () => {
    const target = http.createServer((_request, response) => {
      response.end('ok');
    });
    const targetPort = await listen(target);
    const service = createService();
    const captured: string[] = [];
    service.onRequest((event) => {
      captured.push(
        `${event.request.captureSource}:${event.request.method}:${event.request.status}:${event.request.tunnelOnly}:${event.request.decrypted}`,
      );
    });
    const session = await service.start({
      projectPath: '/project',
      appPath: '.',
      platform: 'ios',
      deviceId: 'ios-1',
      port: 0,
      autoConfigureDevice: false,
    });

    const statusCode = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: session.port,
          method: 'CONNECT',
          path: `127.0.0.1:${targetPort}`,
        });
        request.on('connect', (response, socket) => {
          socket.end();
          resolve(response.statusCode);
        });
        request.on('error', reject);
        request.end();
      },
    );

    expect(statusCode).toBe(200);
    expect(captured).toEqual(['tunneled:CONNECT:200:true:false']);
  });

  it('marks MITM CONNECT tunnel events as tunneled without decrypted request metadata', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'jc-proxy-mitm-'));
    const service = createService({ caDirectory: tempDir });
    const captured: string[] = [];
    service.onRequest((event) => {
      captured.push(
        `${event.request.captureSource}:${event.request.method}:${event.request.tunnelOnly}:${event.request.decrypted}`,
      );
    });

    try {
      const session = await service.start({
        projectPath: '/project',
        appPath: '.',
        platform: 'ios',
        deviceId: 'ios-1',
        port: 0,
        enableMitm: true,
        autoConfigureDevice: false,
      });

      await new Promise<void>((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: session.port,
          method: 'CONNECT',
          path: 'localhost:1',
        });
        request.on('connect', (_response, socket) => {
          const tlsSocket = tls.connect({
            socket,
            servername: 'localhost',
            rejectUnauthorized: false,
          });
          tlsSocket.setEncoding('utf8');
          tlsSocket.on('secureConnect', () => tlsSocket.end());
          tlsSocket.on('data', () => undefined);
          tlsSocket.on('end', resolve);
          tlsSocket.on('error', reject);
        });
        request.on('error', reject);
        request.end();
      });

      expect(captured).toContain('tunneled:CONNECT:true:false');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('sets and clears Android emulator proxy', async () => {
    const runCommandImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const service = createService({
      runCommandImpl,
    });

    const session = await service.start({
      projectPath: '/project',
      appPath: '.',
      platform: 'android',
      deviceId: 'android-1',
      port: 0,
    });

    expect(session.mode).toBe('android-emulator');
    expect(session.proxyHost).toBe('10.0.2.2');
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'android-1',
      'shell',
      'settings',
      'put',
      'global',
      'http_proxy',
      `10.0.2.2:${session.port}`,
    ]);

    await service.stop(session.id);

    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'android-1',
      'shell',
      'settings',
      'put',
      'global',
      'http_proxy',
      ':0',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'android-1',
      'shell',
      'settings',
      'delete',
      'global',
      'global_http_proxy_host',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'android-1',
      'shell',
      'settings',
      'delete',
      'global',
      'global_http_proxy_port',
    ]);
  });

  it('attempts every Android proxy cleanup command when one fails', async () => {
    const runCommandImpl = vi.fn(async (_command: string, args: string[]) => {
      if (args.join(' ').endsWith('put global http_proxy :0')) {
        throw new Error('adb cleanup failed');
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({ runCommandImpl });

    const session = await service.start({
      projectPath: '/project',
      appPath: '.',
      platform: 'android',
      deviceId: 'android-1',
      port: 0,
    });

    await service.stop(session.id);

    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'android-1',
      'shell',
      'settings',
      'delete',
      'global',
      'global_http_proxy_host',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'android-1',
      'shell',
      'settings',
      'delete',
      'global',
      'global_http_proxy_port',
    ]);
  });

  it('resolves Android AVD names to adb serials when setting emulator proxy', async () => {
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_arm64 model:Medium_Phone device:emu64a transport_id:1\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 emu avd name'
      ) {
        return { stdout: 'Medium_Phone\nOK\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') ===
          '-s emulator-5554 shell readlink -f /system/etc/security/cacerts'
      ) {
        return { stdout: '/apex/com.android.conscrypt/cacerts\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell getprop sys.boot_completed'
      ) {
        return { stdout: '1\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({ runCommandImpl });

    const session = await service.start({
      projectPath: '/project',
      appPath: '.',
      platform: 'android',
      deviceId: 'Medium_Phone',
      port: 0,
    });

    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'settings',
      'put',
      'global',
      'http_proxy',
      `10.0.2.2:${session.port}`,
    ]);

    await service.stop(session.id);

    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'settings',
      'put',
      'global',
      'http_proxy',
      ':0',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'settings',
      'delete',
      'global',
      'global_http_proxy_host',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'settings',
      'delete',
      'global',
      'global_http_proxy_port',
    ]);
  });

  it('sets and restores macOS proxy for iOS simulator routing', async () => {
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'route') {
        return { stdout: '   interface: en0\n', stderr: '' };
      }
      if (command === 'networksetup') {
        if (args[0] === '-listallhardwareports') {
          return {
            stdout: [
              'Hardware Port: Wi-Fi',
              'Device: en0',
              'Ethernet Address: aa:bb:cc:dd:ee:ff',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === '-getwebproxy') {
          return {
            stdout: ['Enabled: No', 'Server:', 'Port: 0'].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === '-getsecurewebproxy') {
          return {
            stdout: ['Enabled: Yes', 'Server: old.proxy', 'Port: 8080'].join(
              '\n',
            ),
            stderr: '',
          };
        }
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({ runCommandImpl });

    const session = await service.start({
      projectPath: '/project',
      appPath: '.',
      platform: 'ios',
      deviceId: 'ios-1',
      port: 0,
    });

    expect(session.mode).toBe('ios-simulator');
    expect(session.proxyHost).toBe('127.0.0.1');
    expect(runCommandImpl).toHaveBeenCalledWith('networksetup', [
      '-setwebproxy',
      'Wi-Fi',
      '127.0.0.1',
      String(session.port),
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('networksetup', [
      '-setsecurewebproxy',
      'Wi-Fi',
      '127.0.0.1',
      String(session.port),
    ]);

    await service.stop(session.id);

    expect(runCommandImpl).toHaveBeenCalledWith('networksetup', [
      '-setwebproxystate',
      'Wi-Fi',
      'off',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('networksetup', [
      '-setsecurewebproxy',
      'Wi-Fi',
      'old.proxy',
      '8080',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('networksetup', [
      '-setsecurewebproxystate',
      'Wi-Fi',
      'on',
    ]);
  });

  it('shows a VPN-specific error when macOS default route is utun', async () => {
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'route') {
        return { stdout: '   interface: utun4\n', stderr: '' };
      }
      if (command === 'networksetup' && args[0] === '-listallhardwareports') {
        return {
          stdout: [
            'Hardware Port: Wi-Fi',
            'Device: en0',
            'Ethernet Address: aa:bb:cc:dd:ee:ff',
          ].join('\n'),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({ runCommandImpl });

    await expect(
      service.start({
        projectPath: '/project',
        appPath: '.',
        platform: 'ios',
        deviceId: 'ios-1',
        port: 0,
      }),
    ).rejects.toThrow(
      'Network proxy capture is not available while a VPN is controlling macOS routing',
    );
  });

  it('restores macOS proxy when iOS simulator setup fails midway', async () => {
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'route') {
        return { stdout: '   interface: en0\n', stderr: '' };
      }
      if (command === 'networksetup') {
        if (args[0] === '-listallhardwareports') {
          return {
            stdout: [
              'Hardware Port: Wi-Fi',
              'Device: en0',
              'Ethernet Address: aa:bb:cc:dd:ee:ff',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === '-getwebproxy') {
          return {
            stdout: ['Enabled: No', 'Server:', 'Port: 0'].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === '-getsecurewebproxy') {
          return {
            stdout: ['Enabled: Yes', 'Server: old.proxy', 'Port: 8080'].join(
              '\n',
            ),
            stderr: '',
          };
        }
        if (args[0] === '-setsecurewebproxy' && args[2] === '127.0.0.1') {
          throw new Error('networksetup failed');
        }
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({ runCommandImpl });

    await expect(
      service.start({
        projectPath: '/project',
        appPath: '.',
        platform: 'ios',
        deviceId: 'ios-1',
        port: 0,
      }),
    ).rejects.toThrow('networksetup failed');

    expect(runCommandImpl).toHaveBeenCalledWith('networksetup', [
      '-setwebproxystate',
      'Wi-Fi',
      'off',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('networksetup', [
      '-setsecurewebproxy',
      'Wi-Fi',
      'old.proxy',
      '8080',
    ]);
    expect(runCommandImpl).toHaveBeenCalledWith('networksetup', [
      '-setsecurewebproxystate',
      'Wi-Fi',
      'on',
    ]);
  });

  it('reuses active iOS simulator proxy instead of starting another', async () => {
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'route') {
        return { stdout: '   interface: en0\n', stderr: '' };
      }
      if (command === 'networksetup') {
        if (args[0] === '-listallhardwareports') {
          return {
            stdout: [
              'Hardware Port: Wi-Fi',
              'Device: en0',
              'Ethernet Address: aa:bb:cc:dd:ee:ff',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === '-getwebproxy' || args[0] === '-getsecurewebproxy') {
          return {
            stdout: ['Enabled: No', 'Server:', 'Port: 0'].join('\n'),
            stderr: '',
          };
        }
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({ runCommandImpl });

    const first = await service.start({
      projectPath: '/project-a',
      appPath: '.',
      platform: 'ios',
      deviceId: 'ios-1',
      port: 0,
    });

    const second = await service.start({
      projectPath: '/project-b',
      appPath: '.',
      platform: 'ios',
      deviceId: 'ios-1',
      port: 0,
    });

    expect(second.id).toBe(first.id);
  });

  it('reuses active iOS simulator proxy across projects and apps', async () => {
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'route') {
        return { stdout: '   interface: en0\n', stderr: '' };
      }
      if (command === 'networksetup') {
        if (args[0] === '-listallhardwareports') {
          return {
            stdout: [
              'Hardware Port: Wi-Fi',
              'Device: en0',
              'Ethernet Address: aa:bb:cc:dd:ee:ff',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === '-getwebproxy' || args[0] === '-getsecurewebproxy') {
          return {
            stdout: ['Enabled: No', 'Server:', 'Port: 0'].join('\n'),
            stderr: '',
          };
        }
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({ runCommandImpl });

    const first = await service.start({
      projectPath: '/project-a',
      appPath: 'apps/mobile',
      platform: 'ios',
      deviceId: 'ios-1',
      port: 0,
    });
    const second = await service.start({
      projectPath: '/project-b',
      appPath: 'packages/app',
      platform: 'ios',
      deviceId: 'ios-2',
      port: 0,
    });

    expect(second.id).toBe(first.id);
    expect(
      runCommandImpl.mock.calls.filter(
        ([command, args]) =>
          command === 'networksetup' && args[0] === '-setwebproxy',
      ),
    ).toHaveLength(1);
  });

  it('generates and installs iOS simulator CA certificate', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'jc-proxy-ca-'));
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'openssl') {
        await fs.writeFile(args[args.indexOf('-out') + 1], 'cert');
        await fs.writeFile(args[args.indexOf('-keyout') + 1], 'key');
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({
      runCommandImpl,
      caDirectory: tempDir,
    });

    try {
      const result = await service.installCertificate({
        platform: 'ios',
        deviceId: 'ios-1',
      });

      expect(result.certPath).toBe(
        path.join(tempDir, 'jean-claude-mobile-preview-ca.pem'),
      );
      expect(runCommandImpl).toHaveBeenCalledWith(
        'openssl',
        expect.arrayContaining(['req', '-x509', '-out', result.certPath]),
      );
      expect(runCommandImpl).toHaveBeenLastCalledWith('xcrun', [
        'simctl',
        'keychain',
        'ios-1',
        'add-root-cert',
        result.certPath,
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('opens Android user CA install flow after generating certificate', async () => {
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'jc-proxy-ca-'));
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'openssl') {
        await fs.writeFile(args[args.indexOf('-out') + 1], 'cert');
        await fs.writeFile(args[args.indexOf('-keyout') + 1], 'key');
      }
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device product:sdk_gphone64_arm64 model:Medium_Phone device:emu64a\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 emu avd name'
      ) {
        return { stdout: 'Medium_Phone\nOK\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({
      runCommandImpl,
      caDirectory: tempDir,
    });

    try {
      const result = await service.installCertificate({
        platform: 'android',
        deviceId: 'Medium_Phone',
      });

      expect(result.certPath).toBe(
        path.join(tempDir, 'jean-claude-mobile-preview-ca.pem'),
      );
      expect(runCommandImpl).toHaveBeenCalledWith(
        'openssl',
        expect.arrayContaining(['req', '-x509', '-out', result.certPath]),
      );
      expect(runCommandImpl).toHaveBeenCalledWith('adb', ['devices', '-l']);
      expect(runCommandImpl).toHaveBeenCalledWith('adb', [
        '-s',
        'emulator-5554',
        'push',
        result.certPath,
        '/sdcard/Download/jean-claude-mobile-preview-ca.crt',
      ]);
      expect(runCommandImpl).toHaveBeenCalledWith('adb', [
        '-s',
        'emulator-5554',
        'shell',
        'am',
        'start',
        '-a',
        'com.android.credentials.INSTALL',
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns manual install guidance instead of running simctl for physical iOS', async () => {
    registerPhysicalIosDevice();
    const tempRoot = os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'jc-proxy-ca-'));
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'openssl') {
        await fs.writeFile(args[args.indexOf('-out') + 1], 'cert');
        await fs.writeFile(args[args.indexOf('-keyout') + 1], 'key');
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({ runCommandImpl, caDirectory: tempDir });

    try {
      const result = await service.installCertificate({
        platform: 'ios',
        deviceId: PHYSICAL_IOS_DEVICE_ID,
      });

      expect(result.installed).toBe(false);
      expect(result.certPath).toBe(
        path.join(tempDir, 'jean-claude-mobile-preview-ca.pem'),
      );
      expect(result.message).toContain(
        "can't be installed automatically on a physical iOS device",
      );
      expect(result.message).toContain('VPN & Device Management');
      expect(result.message).toContain('Certificate Trust Settings');
      expect(result.message).toContain(result.certPath);
      expect(runCommandImpl).not.toHaveBeenCalledWith(
        'xcrun',
        expect.anything(),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('advertises the Mac LAN address for a physical iOS proxy session', async () => {
    registerPhysicalIosDevice();
    const runCommandImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const service = createService({
      runCommandImpl,
      getLanAddressImpl: () => '192.168.1.42',
    });

    const session = await service.start({
      projectPath: '/project',
      appPath: '.',
      platform: 'ios',
      deviceId: PHYSICAL_IOS_DEVICE_ID,
      port: 0,
    });

    expect(session.mode).toBe('ios-device');
    expect(session.proxyHost).toBe('192.168.1.42');
    // The Mac's own proxy settings are irrelevant to a real handset.
    expect(runCommandImpl).not.toHaveBeenCalledWith(
      'networksetup',
      expect.anything(),
    );
  });

  it('fails with actionable guidance when a physical iOS device has no LAN route', async () => {
    registerPhysicalIosDevice();
    const service = createService({
      runCommandImpl: vi.fn(async () => ({ stdout: '', stderr: '' })),
      getLanAddressImpl: () => null,
    });

    await expect(
      service.start({
        projectPath: '/project',
        appPath: '.',
        platform: 'ios',
        deviceId: PHYSICAL_IOS_DEVICE_ID,
        port: 0,
      }),
    ).rejects.toThrow('No LAN address found for this Mac');
  });

  it('keeps loopback routing for a simulator whose id looks like a CoreDevice id', async () => {
    // Same UUID shape as a physical device, but not in the devicectl registry.
    const runCommandImpl = vi.fn(async (command: string, args: string[]) => {
      if (command === 'route') {
        return { stdout: '   interface: en0\n', stderr: '' };
      }
      if (command === 'networksetup') {
        if (args[0] === '-listallhardwareports') {
          return {
            stdout: ['Hardware Port: Wi-Fi', 'Device: en0'].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === '-getwebproxy' || args[0] === '-getsecurewebproxy') {
          return {
            stdout: ['Enabled: No', 'Server:', 'Port: 0'].join('\n'),
            stderr: '',
          };
        }
      }
      return { stdout: '', stderr: '' };
    });
    const service = createService({
      runCommandImpl,
      getLanAddressImpl: () => '192.168.1.42',
    });

    const session = await service.start({
      projectPath: '/project',
      appPath: '.',
      platform: 'ios',
      deviceId: PHYSICAL_IOS_DEVICE_ID,
      port: 0,
    });

    expect(session.mode).toBe('ios-simulator');
    expect(session.proxyHost).toBe('127.0.0.1');
  });
});
