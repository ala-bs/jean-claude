# iOS Simulator Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users create, delete, erase, rename, and boot iOS simulators directly from Jean-Claude mobile preview without opening Xcode.

**Architecture:** Extend existing iOS mobile preview adapter with `simctl` management APIs. Main process owns `xcrun simctl` execution/parsing; renderer uses typed IPC plus TanStack Query hooks. Keep runtime installation out of app; show setup guidance when Xcode or installed iOS runtimes are missing.

**Tech Stack:** Electron IPC, TypeScript, React, TanStack Query, existing `mobile-preview-ios-idb-adapter`, `xcrun simctl`.

---

## Current State

- iOS preview already lists simulators via `xcrun simctl list devices --json` in `electron/services/mobile-preview-ios-idb-adapter.ts`.
- Selecting shutdown iOS simulators already boots them before preview starts.
- Existing iOS adapter already streams via CoreSimulator/idb/simctl and handles input, deeplinks, text size, appearance.
- Missing: runtime list, device type list, simulator creation, deletion, erase, rename, and setup state for missing runtimes.

## UX Target

- iOS tab shows existing simulators plus “Create simulator”.
- Create dialog fields:
  - Name, default from selected device type/runtime, e.g. `iPhone 16 Pro iOS 18.5`
  - Device type, default newest available iPhone type
  - Runtime, default newest available iOS runtime
- Per-simulator actions:
  - Delete shutdown simulator
  - Erase content/settings
  - Rename simulator
- Missing setup states:
  - No `xcrun`: show Xcode Command Line Tools install guidance
  - No iOS runtimes: show Xcode Settings > Platforms guidance
  - No iPhone device types: show Xcode install/update guidance
- After create/delete/erase/rename, refresh iOS device query.

## Out Of Scope

- Downloading iOS runtimes from inside app.
- Managing Xcode versions or `xcode-select` switching.
- Watch/tvOS/visionOS simulator management.
- Pairing watches.
- Snapshot management.

---

### Task 1: Add Shared iOS Simulator Management Types

**Files:**
- Modify: `shared/mobile-simulator-types.ts`
- Test: `electron/services/mobile-preview-ios-idb-adapter.test.ts`

**Step 1: Write failing type/import test**

Add compile-time usage near existing iOS adapter tests:

```ts
import type {
  MobilePreviewIosCreateDeviceParams,
  MobilePreviewIosDeviceType,
  MobilePreviewIosRuntime,
  MobilePreviewIosToolStatus,
} from '../../shared/mobile-simulator-types';

it('uses iOS simulator management types', () => {
  const status: MobilePreviewIosToolStatus = {
    xcrunPath: 'xcrun',
    missingTools: [],
  };
  const runtime: MobilePreviewIosRuntime = {
    id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
    name: 'iOS 18.5',
    version: '18.5',
    platform: 'iOS',
    available: true,
  };
  const deviceType: MobilePreviewIosDeviceType = {
    id: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
    name: 'iPhone 16 Pro',
    productFamily: 'iPhone',
  };
  const params: MobilePreviewIosCreateDeviceParams = {
    name: 'iPhone 16 Pro iOS 18.5',
    deviceTypeId: deviceType.id,
    runtimeId: runtime.id,
  };

  expect(status.xcrunPath).toBe('xcrun');
  expect(params.runtimeId).toBe(runtime.id);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- mobile-preview-ios-idb-adapter.test.ts`

Expected: FAIL with missing exported type names.

**Step 3: Add minimal types**

Append near Android management types:

```ts
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
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- mobile-preview-ios-idb-adapter.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/mobile-simulator-types.ts electron/services/mobile-preview-ios-idb-adapter.test.ts
git commit -m "feat: add ios simulator management types"
```

---

### Task 2: Parse iOS Runtimes And Device Types

**Files:**
- Modify: `electron/services/mobile-preview-ios-idb-adapter.ts`
- Test: `electron/services/mobile-preview-ios-idb-adapter.test.ts`

**Step 1: Write failing parser tests**

Add tests for `parseSimctlRuntimes` and `parseSimctlDeviceTypes`:

```ts
it('parses available iOS runtimes', () => {
  expect(
    parseSimctlRuntimes(`{
      "runtimes": [{
        "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
        "name": "iOS 18.5",
        "version": "18.5",
        "platform": "iOS",
        "isAvailable": true
      }, {
        "identifier": "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
        "name": "watchOS 11.0",
        "platform": "watchOS",
        "isAvailable": true
      }]
    }`),
  ).toEqual([
    {
      id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
      name: 'iOS 18.5',
      version: '18.5',
      platform: 'iOS',
      available: true,
    },
  ]);
});

it('parses iPhone simulator device types', () => {
  expect(
    parseSimctlDeviceTypes(`{
      "devicetypes": [{
        "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
        "name": "iPhone 16 Pro",
        "productFamily": "iPhone"
      }, {
        "identifier": "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4",
        "name": "iPad Pro 13-inch (M4)",
        "productFamily": "iPad"
      }]
    }`),
  ).toEqual([
    {
      id: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
      name: 'iPhone 16 Pro',
      productFamily: 'iPhone',
    },
  ]);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- mobile-preview-ios-idb-adapter.test.ts`

Expected: FAIL because parser exports do not exist.

**Step 3: Implement parsers**

Add parser functions near `parseSimctlDevices`:

```ts
export function parseSimctlRuntimes(json: string): MobilePreviewIosRuntime[] {
  const parsed = JSON.parse(json) as { runtimes?: unknown };
  const runtimes = Array.isArray(parsed.runtimes) ? parsed.runtimes : [];

  return runtimes
    .filter((runtime): runtime is Record<string, unknown> =>
      !!runtime && typeof runtime === 'object',
    )
    .filter((runtime) => runtime.platform === 'iOS')
    .map((runtime) => ({
      id: typeof runtime.identifier === 'string' ? runtime.identifier : '',
      name: typeof runtime.name === 'string' ? runtime.name : '',
      version: typeof runtime.version === 'string' ? runtime.version : null,
      platform: 'iOS',
      available: runtime.isAvailable === true,
    }))
    .filter((runtime) => runtime.id && runtime.name)
    .sort((a, b) => (b.version ?? b.name).localeCompare(a.version ?? a.name, undefined, { numeric: true }));
}

export function parseSimctlDeviceTypes(json: string): MobilePreviewIosDeviceType[] {
  const parsed = JSON.parse(json) as { devicetypes?: unknown };
  const deviceTypes = Array.isArray(parsed.devicetypes) ? parsed.devicetypes : [];

  return deviceTypes
    .filter((deviceType): deviceType is Record<string, unknown> =>
      !!deviceType && typeof deviceType === 'object',
    )
    .map((deviceType) => ({
      id: typeof deviceType.identifier === 'string' ? deviceType.identifier : '',
      name: typeof deviceType.name === 'string' ? deviceType.name : '',
      productFamily:
        typeof deviceType.productFamily === 'string'
          ? deviceType.productFamily
          : null,
    }))
    .filter(
      (deviceType) =>
        deviceType.id &&
        deviceType.name &&
        deviceType.productFamily === 'iPhone',
    );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- mobile-preview-ios-idb-adapter.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/services/mobile-preview-ios-idb-adapter.ts electron/services/mobile-preview-ios-idb-adapter.test.ts
git commit -m "feat: parse ios simulator catalogs"
```

---

### Task 3: Add iOS Adapter Management Methods

**Files:**
- Modify: `electron/services/mobile-preview-ios-idb-adapter.ts`
- Modify: `electron/services/mobile-preview-service.ts`
- Test: `electron/services/mobile-preview-ios-idb-adapter.test.ts`

**Step 1: Write failing adapter tests**

Mock `runCommand` and assert commands:

```ts
it('creates iOS simulator with simctl', async () => {
  await iosAdapter.createIosDevice({
    name: 'iPhone 16 Pro iOS 18.5',
    deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
    runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
  });

  expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
    'simctl',
    'create',
    'iPhone 16 Pro iOS 18.5',
    'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
    'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
  ]);
});

it('deletes erases and renames iOS simulators', async () => {
  await iosAdapter.deleteIosDevice('UDID-1');
  await iosAdapter.eraseIosDevice('UDID-1');
  await iosAdapter.renameIosDevice({ deviceId: 'UDID-1', name: 'Work iPhone' });

  expect(runCommandMock).toHaveBeenCalledWith('xcrun', ['simctl', 'delete', 'UDID-1']);
  expect(runCommandMock).toHaveBeenCalledWith('xcrun', ['simctl', 'erase', 'UDID-1']);
  expect(runCommandMock).toHaveBeenCalledWith('xcrun', ['simctl', 'rename', 'UDID-1', 'Work iPhone']);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- mobile-preview-ios-idb-adapter.test.ts`

Expected: FAIL because methods do not exist.

**Step 3: Implement minimal adapter methods**

Add methods to iOS adapter export:

```ts
async getIosToolStatus(): Promise<MobilePreviewIosToolStatus> {
  const xcrunPath = (await commandExists('xcrun')) ? 'xcrun' : null;
  return { xcrunPath, missingTools: xcrunPath ? [] : ['xcrun'] };
},

async listIosRuntimes(): Promise<MobilePreviewIosRuntime[]> {
  await assertXcrunAvailable();
  const { stdout } = await runCommand('xcrun', ['simctl', 'list', 'runtimes', '--json']);
  return parseSimctlRuntimes(stdout);
},

async listIosDeviceTypes(): Promise<MobilePreviewIosDeviceType[]> {
  await assertXcrunAvailable();
  const { stdout } = await runCommand('xcrun', ['simctl', 'list', 'devicetypes', '--json']);
  return parseSimctlDeviceTypes(stdout);
},

async createIosDevice(params: MobilePreviewIosCreateDeviceParams): Promise<void> {
  assertSafeSimctlValue(params.name, 'iOS simulator name');
  assertSafeSimctlValue(params.deviceTypeId, 'iOS device type');
  assertSafeSimctlValue(params.runtimeId, 'iOS runtime');
  await runCommand('xcrun', ['simctl', 'create', params.name, params.deviceTypeId, params.runtimeId]);
},

async deleteIosDevice(deviceId: string): Promise<void> {
  assertSafeSimctlValue(deviceId, 'iOS simulator id');
  await runCommand('xcrun', ['simctl', 'delete', deviceId]);
},

async eraseIosDevice(deviceId: string): Promise<void> {
  assertSafeSimctlValue(deviceId, 'iOS simulator id');
  await runCommand('xcrun', ['simctl', 'erase', deviceId]);
},

async renameIosDevice(params: MobilePreviewIosRenameDeviceParams): Promise<void> {
  assertSafeSimctlValue(params.deviceId, 'iOS simulator id');
  assertSafeSimctlValue(params.name, 'iOS simulator name');
  await runCommand('xcrun', ['simctl', 'rename', params.deviceId, params.name]);
},
```

Add validation helper:

```ts
function assertSafeSimctlValue(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
  if (value.startsWith('-')) throw new Error(`Invalid ${label}.`);
}
```

Extend `MobilePreviewAdapter` in `electron/services/mobile-preview-service.ts` with optional iOS methods and add service wrappers matching Android wrappers.

**Step 4: Run test to verify it passes**

Run: `pnpm test -- mobile-preview-ios-idb-adapter.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/services/mobile-preview-ios-idb-adapter.ts electron/services/mobile-preview-service.ts electron/services/mobile-preview-ios-idb-adapter.test.ts
git commit -m "feat: manage ios simulators in adapter"
```

---

### Task 4: Add IPC And Renderer Hook

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `src/hooks/use-mobile-preview.ts`

**Step 1: Add API contract**

Extend `api.mobilePreview` types with:

```ts
getIosToolStatus: () => Promise<MobilePreviewIosToolStatus>;
listIosRuntimes: () => Promise<MobilePreviewIosRuntime[]>;
listIosDeviceTypes: () => Promise<MobilePreviewIosDeviceType[]>;
createIosDevice: (params: MobilePreviewIosCreateDeviceParams) => Promise<void>;
deleteIosDevice: (deviceId: string) => Promise<void>;
eraseIosDevice: (deviceId: string) => Promise<void>;
renameIosDevice: (params: MobilePreviewIosRenameDeviceParams) => Promise<void>;
```

**Step 2: Wire preload and IPC**

Add channels beside Android mobile preview channels:

```ts
mobilePreview:getIosToolStatus
mobilePreview:listIosRuntimes
mobilePreview:listIosDeviceTypes
mobilePreview:createIosDevice
mobilePreview:deleteIosDevice
mobilePreview:eraseIosDevice
mobilePreview:renameIosDevice
```

**Step 3: Add hook**

Add `useIosDeviceManagement(enabled = true)` mirroring Android hook:

```ts
export function useIosDeviceManagement(enabled = true) {
  const queryClient = useQueryClient();

  const toolStatus = useQuery({
    queryKey: ['mobile-preview-ios-tool-status'],
    queryFn: () => api.mobilePreview.getIosToolStatus(),
    enabled,
  });
  const runtimes = useQuery({
    queryKey: ['mobile-preview-ios-runtimes'],
    queryFn: () => api.mobilePreview.listIosRuntimes(),
    enabled,
  });
  const deviceTypes = useQuery({
    queryKey: ['mobile-preview-ios-device-types'],
    queryFn: () => api.mobilePreview.listIosDeviceTypes(),
    enabled,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ['mobile-preview-devices', 'ios'],
    });
  }, [queryClient]);

  const createDevice = useMutation({ mutationFn: api.mobilePreview.createIosDevice, onSuccess: invalidate });
  const deleteDevice = useMutation({ mutationFn: api.mobilePreview.deleteIosDevice, onSuccess: invalidate });
  const eraseDevice = useMutation({ mutationFn: api.mobilePreview.eraseIosDevice, onSuccess: invalidate });
  const renameDevice = useMutation({ mutationFn: api.mobilePreview.renameIosDevice, onSuccess: invalidate });

  return { toolStatus, runtimes, deviceTypes, createDevice, deleteDevice, eraseDevice, renameDevice };
}
```

**Step 4: Run targeted checks**

Run: `pnpm ts-check`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/api.ts electron/preload.ts electron/ipc/handlers.ts src/hooks/use-mobile-preview.ts
git commit -m "feat: expose ios simulator management ipc"
```

---

### Task 5: Add iOS UI In Mobile Preview Pane

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`

**Step 1: Import hook and types**

Add `useIosDeviceManagement` beside `useAndroidDeviceManagement`.

**Step 2: Add local UI state**

Add state near Android create state:

```ts
const [isCreateIosDeviceOpen, setIsCreateIosDeviceOpen] = useState(false);
const [iosDeviceName, setIosDeviceName] = useState('');
const [iosDeviceTypeId, setIosDeviceTypeId] = useState('');
const [iosRuntimeId, setIosRuntimeId] = useState('');
const [renamingIosDevice, setRenamingIosDevice] = useState<MobilePreviewDevice | null>(null);
const [iosRenameValue, setIosRenameValue] = useState('');
const [deletingIosDeviceId, setDeletingIosDeviceId] = useState<string | null>(null);
const [erasingIosDeviceId, setErasingIosDeviceId] = useState<string | null>(null);
```

**Step 3: Build options and defaults**

Use newest available runtime and first iPhone type:

```ts
const iosManagement = useIosDeviceManagement(platform === 'ios');
const availableIosRuntimes = (iosManagement.runtimes.data ?? []).filter((runtime) => runtime.available);
const iosRuntimeOptions = availableIosRuntimes.map((runtime) => ({ value: runtime.id, label: runtime.name }));
const iosDeviceTypeOptions = (iosManagement.deviceTypes.data ?? []).map((deviceType) => ({ value: deviceType.id, label: deviceType.name }));
```

When options load, set default runtime/device type and suggested name.

**Step 4: Add handlers**

Add handlers:

```ts
const handleCreateIosDevice = useCallback(async () => {
  const name = iosDeviceName.trim();
  if (!name || !iosDeviceTypeId || !iosRuntimeId) return;
  await iosManagement.createDevice.mutateAsync({ name, deviceTypeId: iosDeviceTypeId, runtimeId: iosRuntimeId });
  setDeviceId(name);
  setIsCreateIosDeviceOpen(false);
}, [iosDeviceName, iosDeviceTypeId, iosRuntimeId, iosManagement.createDevice, setDeviceId]);

async function handleDeleteIosDevice(deviceId: string) { ... }
async function handleEraseIosDevice(deviceId: string) { ... }
async function handleRenameIosDevice() { ... }
```

**Step 5: Render iOS manager UI**

In iOS device section, add:

- “Create simulator” button, disabled when no runtime/device type.
- Setup guidance card when `xcrun` missing.
- Setup guidance card when runtime list empty.
- Device action menu items: `Rename`, `Erase`, `Delete`.
- Rename inline modal/dropdown using existing `Input`/`Button` patterns.

Keep visual language identical to Android device manager section.

**Step 6: Run targeted checks**

Run: `pnpm ts-check`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/features/task/ui-task-panel/mobile-preview-pane/index.tsx
git commit -m "feat: add ios simulator manager ui"
```

---

### Task 6: Verification

**Files:**
- No code changes expected.

**Step 1: Install dependencies**

Run: `pnpm install`

Expected: completes without lockfile surprises unless dependencies already changed.

**Step 2: Run tests**

Run: `pnpm test`

Expected: PASS.

**Step 3: Auto-fix lint**

Run: `pnpm lint --fix`

Expected: completes; review changed files.

**Step 4: Run TypeScript checks**

Run: `pnpm ts-check`

Expected: PASS.

**Step 5: Run final lint**

Run: `pnpm lint`

Expected: PASS.

**Step 6: Manual smoke test**

On macOS with Xcode installed:

- Open task detail mobile preview pane.
- Select iOS tab.
- Create simulator with default values.
- Confirm simulator appears in list.
- Select it and start preview.
- Rename it; confirm list updates.
- Erase it while shutdown; confirm action succeeds.
- Delete it; confirm list updates.

**Step 7: Commit final fixes if any**

```bash
git add <changed-files>
git commit -m "fix: polish ios simulator manager"
```

---

## Risk Notes

- `simctl rename` availability depends on installed Xcode. If unsupported, fallback can delete/create only after explicit user approval, not first pass.
- `simctl erase` can fail for booted devices depending Xcode state. UI should show error and leave device list intact.
- Created simulator UDID comes from `simctl create` stdout. First pass can refresh list and select by name; safer future improvement selects by returned UDID.
