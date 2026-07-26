# Android Device Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users create, delete, and launch Android emulator devices directly from Jean-Claude mobile preview without opening Android Studio.

**Architecture:** Add Android SDK/AVD management to existing mobile preview stack. Main process owns CLI execution and parsing; renderer calls typed IPC APIs and refreshes TanStack Query device lists. Keep first slice limited to installed SDKs/images plus optional image install trigger.

**Tech Stack:** Electron IPC, TypeScript, React, TanStack Query, existing `mobile-preview-process` command helpers, Android SDK CLI tools (`adb`, `emulator`, `avdmanager`, `sdkmanager`).

---

## Current State

- `electron/services/mobile-preview-android-adapter.ts` already lists Android devices from `adb devices -l` and installed AVDs from `emulator -list-avds`.
- Selecting shutdown AVD already starts emulator via `emulator -avd <name>` in `resolveAndroidDeviceId()`.
- Missing: SDK tool discovery beyond `emulator`, system image/device profile listing, AVD creation, AVD deletion, image install/setup UI.

## UX Target

- Android tab shows existing devices plus “Create device”.
- Create dialog fields:
  - Name
  - Device profile, default `pixel_8`
  - System image, default newest installed `google_apis` `arm64-v8a` on Apple Silicon
- If required tools missing, show setup card with exact missing tool and detected SDK path.
- If no system images installed, show image install action.
- After create/delete/install, refresh Android device query.

## Out Of Scope

- Installing full Android SDK from scratch.
- Accepting licenses interactively in-app.
- Editing advanced hardware config.
- Snapshot management.

---

### Task 1: Add Shared Android Device Management Types

**Files:**
- Modify: `shared/mobile-simulator-types.ts`

**Step 1: Write failing type/import test**

Add compile-only usage to existing test or new test if preferred:

```ts
import type {
  MobilePreviewAndroidCreateDeviceParams,
  MobilePreviewAndroidSystemImage,
} from '../../shared/mobile-simulator-types';

const image: MobilePreviewAndroidSystemImage = {
  id: 'system-images;android-35;google_apis;arm64-v8a',
  apiLevel: 35,
  packagePath: 'system-images;android-35;google_apis;arm64-v8a',
  tag: 'google_apis',
  abi: 'arm64-v8a',
  installed: true,
};

const params: MobilePreviewAndroidCreateDeviceParams = {
  name: 'Pixel_8_API_35',
  deviceProfileId: 'pixel_8',
  systemImageId: image.id,
};

expect(params.name).toBe('Pixel_8_API_35');
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- mobile-preview-android-adapter.test.ts`

Expected: FAIL with missing exported type names.

**Step 3: Add minimal types**

Append near `MobilePreviewDevice`:

```ts
export type MobilePreviewAndroidToolStatus = {
  sdkRoot: string | null;
  adbPath: string | null;
  emulatorPath: string | null;
  avdmanagerPath: string | null;
  sdkmanagerPath: string | null;
  missingTools: Array<'adb' | 'emulator' | 'avdmanager' | 'sdkmanager'>;
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
};

export type MobilePreviewAndroidCreateDeviceParams = {
  name: string;
  deviceProfileId: string;
  systemImageId: string;
};

export type MobilePreviewAndroidInstallSystemImageParams = {
  systemImageId: string;
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- mobile-preview-android-adapter.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/mobile-simulator-types.ts electron/services/mobile-preview-android-adapter.test.ts
git commit -m "feat: add android device management types"
```

---

### Task 2: Add Android SDK Tool Discovery Helpers

**Files:**
- Modify: `electron/services/mobile-preview-android-adapter.ts`
- Test: `electron/services/mobile-preview-android-adapter.test.ts`

**Step 1: Write failing tests**

Add tests for path detection with SDK env vars:

```ts
it('reports Android SDK tool status from PATH and SDK root', async () => {
  commandExistsMock.mockImplementation(async (command) => command === 'adb');

  const status = await androidAdapter.getAndroidToolStatus();

  expect(status.adbPath).toBe('adb');
  expect(status.missingTools).toContain('avdmanager');
  expect(status.missingTools).toContain('sdkmanager');
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- mobile-preview-android-adapter.test.ts`

Expected: FAIL because `getAndroidToolStatus` is not defined.

**Step 3: Extend adapter type and implement helpers**

Near `getEmulatorCommand()`, add generic resolver:

```ts
async function getSdkRoot(): Promise<string | null> {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
  ].filter((value): value is string => !!value);

  for (const sdkRoot of sdkRoots) {
    if (await fileExists(join(sdkRoot, 'platform-tools', 'adb'))) return sdkRoot;
    if (await fileExists(join(sdkRoot, 'emulator', 'emulator'))) return sdkRoot;
  }

  return null;
}

async function getAndroidSdkToolCommand(tool: 'adb' | 'emulator' | 'avdmanager' | 'sdkmanager') {
  if (await commandExists(tool)) return tool;

  const sdkRoot = await getSdkRoot();
  if (!sdkRoot) return null;

  const relativePath = tool === 'adb'
    ? ['platform-tools', 'adb']
    : tool === 'emulator'
      ? ['emulator', 'emulator']
      : ['cmdline-tools', 'latest', 'bin', tool];
  const path = join(sdkRoot, ...relativePath);

  return (await fileExists(path)) ? path : null;
}
```

Update `getEmulatorCommand()` to delegate:

```ts
async function getEmulatorCommand(): Promise<string | null> {
  return getAndroidSdkToolCommand('emulator');
}
```

Add adapter method:

```ts
async getAndroidToolStatus() {
  const [sdkRoot, adbPath, emulatorPath, avdmanagerPath, sdkmanagerPath] =
    await Promise.all([
      getSdkRoot(),
      getAndroidSdkToolCommand('adb'),
      getAndroidSdkToolCommand('emulator'),
      getAndroidSdkToolCommand('avdmanager'),
      getAndroidSdkToolCommand('sdkmanager'),
    ]);

  const missingTools = [
    !adbPath && 'adb',
    !emulatorPath && 'emulator',
    !avdmanagerPath && 'avdmanager',
    !sdkmanagerPath && 'sdkmanager',
  ].filter(Boolean) as Array<'adb' | 'emulator' | 'avdmanager' | 'sdkmanager'>;

  return { sdkRoot, adbPath, emulatorPath, avdmanagerPath, sdkmanagerPath, missingTools };
}
```

**Step 4: Run tests**

Run: `pnpm test -- mobile-preview-android-adapter.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/services/mobile-preview-android-adapter.ts electron/services/mobile-preview-android-adapter.test.ts
git commit -m "feat: detect android sdk tools"
```

---

### Task 3: Parse Android Profiles And System Images

**Files:**
- Modify: `electron/services/mobile-preview-android-adapter.ts`
- Test: `electron/services/mobile-preview-android-adapter.test.ts`

**Step 1: Write failing parser tests**

```ts
it('parses avdmanager device profiles', () => {
  expect(parseAndroidDeviceProfiles(`id: 30 or "pixel_8"
    Name: Pixel 8
    OEM : Google
---------
id: 31 or "medium_phone"
    Name: Medium Phone
`)).toEqual([
    { id: 'pixel_8', name: 'Pixel 8', manufacturer: 'Google' },
    { id: 'medium_phone', name: 'Medium Phone', manufacturer: null },
  ]);
});

it('parses installed sdkmanager system images', () => {
  expect(parseAndroidSystemImages(`system-images;android-35;google_apis;arm64-v8a | 9 | Google APIs ARM 64 v8a System Image | system-images/android-35/google_apis/arm64-v8a
`)).toEqual([
    {
      id: 'system-images;android-35;google_apis;arm64-v8a',
      packagePath: 'system-images;android-35;google_apis;arm64-v8a',
      apiLevel: 35,
      tag: 'google_apis',
      abi: 'arm64-v8a',
      installed: true,
    },
  ]);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- mobile-preview-android-adapter.test.ts`

Expected: FAIL with missing parser exports.

**Step 3: Add parsers and adapter methods**

Add exports:

```ts
export function parseAndroidDeviceProfiles(output: string): MobilePreviewAndroidDeviceProfile[] {
  return output.split(/-{5,}/).flatMap((entry) => {
    const id = entry.match(/id:\s*\d+\s+or\s+"([^"]+)"/)?.[1];
    const name = entry.match(/Name:\s*(.+)/)?.[1]?.trim();
    const manufacturer = entry.match(/OEM\s*:\s*(.+)/)?.[1]?.trim() ?? null;
    if (!id || !name) return [];
    return [{ id, name, manufacturer }];
  });
}

export function parseAndroidSystemImages(output: string): MobilePreviewAndroidSystemImage[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const packagePath = line.split('|')[0]?.trim();
    const match = packagePath?.match(/^system-images;android-(\d+);([^;]+);([^;]+)$/);
    if (!packagePath || !match) return [];
    return [{
      id: packagePath,
      packagePath,
      apiLevel: Number(match[1]),
      tag: match[2],
      abi: match[3],
      installed: true,
    }];
  }).sort((a, b) => b.apiLevel - a.apiLevel || a.tag.localeCompare(b.tag));
}
```

Add adapter methods:

```ts
async listAndroidDeviceProfiles() {
  const avdmanager = await getAndroidSdkToolCommand('avdmanager');
  if (!avdmanager) throw new Error('Missing Android SDK tool: avdmanager. Install Android SDK Command-line Tools.');
  const { stdout } = await runCommand(avdmanager, ['list', 'device']);
  return parseAndroidDeviceProfiles(stdout);
}

async listAndroidSystemImages() {
  const sdkmanager = await getAndroidSdkToolCommand('sdkmanager');
  if (!sdkmanager) throw new Error('Missing Android SDK tool: sdkmanager. Install Android SDK Command-line Tools.');
  const { stdout } = await runCommand(sdkmanager, ['--list_installed']);
  return parseAndroidSystemImages(stdout);
}
```

**Step 4: Run tests**

Run: `pnpm test -- mobile-preview-android-adapter.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/services/mobile-preview-android-adapter.ts electron/services/mobile-preview-android-adapter.test.ts
git commit -m "feat: list android avd inputs"
```

---

### Task 4: Add Create/Delete/Install Methods

**Files:**
- Modify: `electron/services/mobile-preview-android-adapter.ts`
- Test: `electron/services/mobile-preview-android-adapter.test.ts`

**Step 1: Write failing command tests**

```ts
it('creates Android AVD with avdmanager', async () => {
  runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

  await androidAdapter.createAndroidDevice({
    name: 'Pixel_8_API_35',
    deviceProfileId: 'pixel_8',
    systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
  });

  expect(runCommandMock).toHaveBeenCalledWith('avdmanager', [
    'create', 'avd',
    '--force',
    '--name', 'Pixel_8_API_35',
    '--device', 'pixel_8',
    '--package', 'system-images;android-35;google_apis;arm64-v8a',
  ], { input: 'no\n' });
});

it('deletes Android AVD by name', async () => {
  runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

  await androidAdapter.deleteAndroidDevice('Pixel_8_API_35');

  expect(runCommandMock).toHaveBeenCalledWith('avdmanager', [
    'delete', 'avd', '--name', 'Pixel_8_API_35',
  ]);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- mobile-preview-android-adapter.test.ts`

Expected: FAIL with missing methods or missing `input` support.

**Step 3: Add `runCommand` stdin support if needed**

Check `electron/services/mobile-preview-process.ts`. If `runCommand` lacks stdin option, extend minimally:

```ts
export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
) { /* write options.input to child.stdin then end */ }
```

Add/adjust tests in `electron/services/mobile-preview-process.test.ts`.

**Step 4: Implement adapter methods**

```ts
function assertAndroidAvdName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('Android device name can only contain letters, numbers, underscore, dot, and dash.');
  }
}

async createAndroidDevice(params: MobilePreviewAndroidCreateDeviceParams) {
  assertAndroidAvdName(params.name);
  const avdmanager = await getAndroidSdkToolCommand('avdmanager');
  if (!avdmanager) throw new Error('Missing Android SDK tool: avdmanager. Install Android SDK Command-line Tools.');

  await runCommand(avdmanager, [
    'create', 'avd',
    '--force',
    '--name', params.name,
    '--device', params.deviceProfileId,
    '--package', params.systemImageId,
  ], { input: 'no\n' });
}

async deleteAndroidDevice(name: string) {
  assertAndroidAvdName(name);
  const avdmanager = await getAndroidSdkToolCommand('avdmanager');
  if (!avdmanager) throw new Error('Missing Android SDK tool: avdmanager. Install Android SDK Command-line Tools.');

  await runCommand(avdmanager, ['delete', 'avd', '--name', name]);
}

async installAndroidSystemImage(params: MobilePreviewAndroidInstallSystemImageParams) {
  const sdkmanager = await getAndroidSdkToolCommand('sdkmanager');
  if (!sdkmanager) throw new Error('Missing Android SDK tool: sdkmanager. Install Android SDK Command-line Tools.');

  await runCommand(sdkmanager, [params.systemImageId]);
}
```

**Step 5: Run tests**

Run: `pnpm test -- mobile-preview-android-adapter.test.ts mobile-preview-process.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add electron/services/mobile-preview-android-adapter.ts electron/services/mobile-preview-android-adapter.test.ts electron/services/mobile-preview-process.ts electron/services/mobile-preview-process.test.ts
git commit -m "feat: manage android avds from cli"
```

---

### Task 5: Expose IPC And Renderer API

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/ipc/handlers.ts`

**Step 1: Write failing IPC type usage**

Add temporary call in hook test or typecheck-only area:

```ts
await api.mobilePreview.getAndroidToolStatus();
await api.mobilePreview.listAndroidSystemImages();
await api.mobilePreview.listAndroidDeviceProfiles();
await api.mobilePreview.createAndroidDevice({
  name: 'Pixel_8_API_35',
  deviceProfileId: 'pixel_8',
  systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
});
await api.mobilePreview.deleteAndroidDevice('Pixel_8_API_35');
```

**Step 2: Run typecheck to verify it fails**

Run: `pnpm ts-check`

Expected: FAIL with missing API methods.

**Step 3: Add API surface**

In `src/lib/api.ts` under `mobilePreview`:

```ts
getAndroidToolStatus: () => Promise<MobilePreviewAndroidToolStatus>;
listAndroidDeviceProfiles: () => Promise<MobilePreviewAndroidDeviceProfile[]>;
listAndroidSystemImages: () => Promise<MobilePreviewAndroidSystemImage[]>;
createAndroidDevice: (params: MobilePreviewAndroidCreateDeviceParams) => Promise<void>;
deleteAndroidDevice: (name: string) => Promise<void>;
installAndroidSystemImage: (params: MobilePreviewAndroidInstallSystemImageParams) => Promise<void>;
```

In `electron/preload.ts` under `mobilePreview`:

```ts
getAndroidToolStatus: () => ipcRenderer.invoke('mobilePreview:getAndroidToolStatus'),
listAndroidDeviceProfiles: () => ipcRenderer.invoke('mobilePreview:listAndroidDeviceProfiles'),
listAndroidSystemImages: () => ipcRenderer.invoke('mobilePreview:listAndroidSystemImages'),
createAndroidDevice: (params) => ipcRenderer.invoke('mobilePreview:createAndroidDevice', params),
deleteAndroidDevice: (name) => ipcRenderer.invoke('mobilePreview:deleteAndroidDevice', name),
installAndroidSystemImage: (params) => ipcRenderer.invoke('mobilePreview:installAndroidSystemImage', params),
```

In `electron/ipc/handlers.ts` near existing mobilePreview handlers:

```ts
ipcMain.handle('mobilePreview:getAndroidToolStatus', () =>
  mobilePreviewService.getAndroidToolStatus(),
);
ipcMain.handle('mobilePreview:listAndroidDeviceProfiles', () =>
  mobilePreviewService.listAndroidDeviceProfiles(),
);
ipcMain.handle('mobilePreview:listAndroidSystemImages', () =>
  mobilePreviewService.listAndroidSystemImages(),
);
ipcMain.handle('mobilePreview:createAndroidDevice', (_, params) =>
  mobilePreviewService.createAndroidDevice(params),
);
ipcMain.handle('mobilePreview:deleteAndroidDevice', (_, name: string) =>
  mobilePreviewService.deleteAndroidDevice(name),
);
ipcMain.handle('mobilePreview:installAndroidSystemImage', (_, params) =>
  mobilePreviewService.installAndroidSystemImage(params),
);
```

Also add delegating methods to `electron/services/mobile-preview-service.ts` and its adapter interface.

**Step 4: Run typecheck**

Run: `pnpm ts-check`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/api.ts electron/preload.ts electron/ipc/handlers.ts electron/services/mobile-preview-service.ts
git commit -m "feat: expose android device management api"
```

---

### Task 6: Add React Hooks For Android Management

**Files:**
- Modify: `src/hooks/use-mobile-preview.ts`

**Step 1: Add hooks**

```ts
export function useAndroidDeviceManagement() {
  const queryClient = useQueryClient();

  const toolStatus = useQuery({
    queryKey: ['mobile-preview-android-tool-status'],
    queryFn: () => api.mobilePreview.getAndroidToolStatus(),
  });
  const profiles = useQuery({
    queryKey: ['mobile-preview-android-device-profiles'],
    queryFn: () => api.mobilePreview.listAndroidDeviceProfiles(),
  });
  const systemImages = useQuery({
    queryKey: ['mobile-preview-android-system-images'],
    queryFn: () => api.mobilePreview.listAndroidSystemImages(),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['mobile-preview-devices', 'android'] });
    void queryClient.invalidateQueries({ queryKey: ['mobile-preview-android-system-images'] });
  };

  const createDevice = useMutation({
    mutationFn: api.mobilePreview.createAndroidDevice,
    onSuccess: invalidate,
  });
  const deleteDevice = useMutation({
    mutationFn: api.mobilePreview.deleteAndroidDevice,
    onSuccess: invalidate,
  });
  const installSystemImage = useMutation({
    mutationFn: api.mobilePreview.installAndroidSystemImage,
    onSuccess: invalidate,
  });

  return { toolStatus, profiles, systemImages, createDevice, deleteDevice, installSystemImage };
}
```

**Step 2: Run typecheck**

Run: `pnpm ts-check`
Expected: FAIL if `useQueryClient` import missing.

**Step 3: Fix imports**

Change first import:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
```

**Step 4: Run typecheck**

Run: `pnpm ts-check`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/hooks/use-mobile-preview.ts
git commit -m "feat: add android management hooks"
```

---

### Task 7: Add Create Device UI In Mobile Preview Pane

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`

**Step 1: Locate device selector area**

Search in file for `useMobilePreviewDevices`, `deviceId`, and device `<Select>` rendering.

**Step 2: Add local state**

Inside pane component:

```ts
const [isCreateAndroidDeviceOpen, setIsCreateAndroidDeviceOpen] = useState(false);
const [androidDeviceName, setAndroidDeviceName] = useState('Pixel_8_API_35');
const [androidDeviceProfileId, setAndroidDeviceProfileId] = useState('pixel_8');
const [androidSystemImageId, setAndroidSystemImageId] = useState('');
const androidManagement = useAndroidDeviceManagement();
```

Use effect to default image:

```ts
useEffect(() => {
  if (androidSystemImageId) return;
  const firstImage = androidManagement.systemImages.data?.[0];
  if (firstImage) setAndroidSystemImageId(firstImage.id);
}, [androidManagement.systemImages.data, androidSystemImageId]);
```

**Step 3: Add Android-only management block near device selector**

```tsx
{platform === 'android' ? (
  <div className="border-border-subtle bg-bg-1 rounded-md border p-2">
    {androidManagement.toolStatus.data?.missingTools.length ? (
      <div className="text-text-muted text-xs">
        Missing Android tools: {androidManagement.toolStatus.data.missingTools.join(', ')}.
        Install Android SDK Command-line Tools and Platform Tools.
      </div>
    ) : null}
    <Button size="sm" onClick={() => setIsCreateAndroidDeviceOpen(true)}>
      Create device
    </Button>
  </div>
) : null}
```

**Step 4: Add compact create dialog/panel**

Reuse existing modal/dialog pattern in this file if present; otherwise inline panel is acceptable:

```tsx
{isCreateAndroidDeviceOpen ? (
  <div className="border-border-subtle bg-bg-0 rounded-md border p-3">
    <Input value={androidDeviceName} onChange={(event) => setAndroidDeviceName(event.target.value)} />
    <Select value={androidDeviceProfileId} onChange={(event) => setAndroidDeviceProfileId(event.target.value)}>
      {(androidManagement.profiles.data ?? []).map((profile) => (
        <option key={profile.id} value={profile.id}>{profile.name}</option>
      ))}
    </Select>
    <Select value={androidSystemImageId} onChange={(event) => setAndroidSystemImageId(event.target.value)}>
      {(androidManagement.systemImages.data ?? []).map((image) => (
        <option key={image.id} value={image.id}>API {image.apiLevel} · {image.tag} · {image.abi}</option>
      ))}
    </Select>
    <Button
      size="sm"
      disabled={!androidDeviceName || !androidDeviceProfileId || !androidSystemImageId || androidManagement.createDevice.isPending}
      onClick={() => androidManagement.createDevice.mutateAsync({
        name: androidDeviceName,
        deviceProfileId: androidDeviceProfileId,
        systemImageId: androidSystemImageId,
      }).then(() => setIsCreateAndroidDeviceOpen(false))}
    >
      Create
    </Button>
  </div>
) : null}
```

**Step 5: Add delete for shutdown AVDs only**

In device row/dropdown, show delete when:

```ts
platform === 'android' && device.state === 'shutdown'
```

Call:

```ts
void androidManagement.deleteDevice.mutateAsync(device.id);
```

**Step 6: Run typecheck**

Run: `pnpm ts-check`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/features/task/ui-task-panel/mobile-preview-pane/index.tsx
git commit -m "feat: add android device creation UI"
```

---

### Task 8: Add Missing Image Install UI

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`

**Step 1: Add suggested image helper**

```ts
function getSuggestedAndroidSystemImageId() {
  const abi = navigator.platform.includes('Mac') ? 'arm64-v8a' : 'x86_64';
  return `system-images;android-35;google_apis;${abi}`;
}
```

**Step 2: Show install action when image list empty**

```tsx
{platform === 'android' && androidManagement.systemImages.data?.length === 0 ? (
  <Button
    size="sm"
    disabled={androidManagement.installSystemImage.isPending}
    onClick={() => androidManagement.installSystemImage.mutateAsync({
      systemImageId: getSuggestedAndroidSystemImageId(),
    })}
  >
    Install Android 35 image
  </Button>
) : null}
```

**Step 3: Add warning copy**

Text:

```tsx
<p className="text-text-muted text-xs">
  Downloads are large. If licenses are not accepted, run `sdkmanager --licenses` once in terminal.
</p>
```

**Step 4: Run typecheck**

Run: `pnpm ts-check`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/features/task/ui-task-panel/mobile-preview-pane/index.tsx
git commit -m "feat: install android system image from preview"
```

---

### Task 9: Verification

**Files:**
- No code changes unless failures found.

**Step 1: Install deps**

Run: `pnpm install`
Expected: completes without lockfile drift unless package metadata changed.

**Step 2: Run tests**

Run: `pnpm test`
Expected: PASS.

**Step 3: Auto-fix lint**

Run: `pnpm lint --fix`
Expected: completes; review any modified files.

**Step 4: Typecheck**

Run: `pnpm ts-check`
Expected: PASS.

**Step 5: Final lint**

Run: `pnpm lint`
Expected: PASS.

**Step 6: Manual smoke test**

Run Jean-Claude preview build per normal workflow; do not use `pnpm dev`.

Manual checks:
- Open task detail mobile preview.
- Select Android.
- Existing AVDs appear.
- Create Android device using installed image.
- Device appears as shutdown.
- Start preview; emulator boots and stream begins.
- Stop preview.
- Delete shutdown AVD.

**Step 7: Commit fixes**

```bash
git add <fixed files>
git commit -m "fix: stabilize android device management"
```

---

## Known Risks

- `sdkmanager --licenses` may block image installs. UI should tell user exact terminal command instead of hanging.
- `avdmanager create avd` can prompt about custom hardware profile; pass `no\n` via stdin.
- `cmdline-tools/latest` may not exist on older SDKs. If needed, expand resolver to `cmdline-tools/*/bin` in follow-up.
- Physical Android devices must not show delete action; only shutdown AVD names from `emulator -list-avds` are safe.

## Root Cause

- Current mobile preview only consumes already-created Android devices. Device lifecycle is delegated to Android Studio/SDK tools because no Jean-Claude IPC/API/UI wraps `avdmanager` or `sdkmanager` yet.
