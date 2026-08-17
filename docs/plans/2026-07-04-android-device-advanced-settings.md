# Android Device Advanced Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Android device creation preview details and a small advanced settings surface in the mobile preview Manage Devices modal.

**Architecture:** Keep Android CLI work in `electron/services/mobile-preview-android-adapter.ts` and expose extra metadata through existing typed IPC/query flow. Keep first UI pass mostly read-only: selected profile + image summary, device dimensions when known, and exact system-image details. Add optional advanced AVD config only as explicit fields written after successful `avdmanager create avd`.

**Tech Stack:** Electron main process, TypeScript, React, TanStack Query hooks in `src/hooks/use-mobile-preview.ts`, shared types in `shared/mobile-simulator-types.ts`, Vitest.

---

### Task 1: Add Android Profile Metadata Parsing

**Files:**
- Modify: `shared/mobile-simulator-types.ts:59-63`
- Modify: `electron/services/mobile-preview-android-adapter.ts:554-563`
- Test: `electron/services/mobile-preview-android-adapter.test.ts:218-231`

**Step 1: Write failing parser test**

Update `parses avdmanager device profiles` to expect optional screen metadata. Include real-ish profile output plus future-proof lines if `avdmanager` ever exposes them:

```ts
expect(
  parseAndroidDeviceProfiles(`id: 30 or "pixel_8"
    Name: Pixel 8
    OEM : Google
    Screen: 1080 x 2400
    Density: 420
---------
id: 31 or "medium_phone"
    Name: Medium Phone
`),
).toEqual([
  {
    id: 'pixel_8',
    name: 'Pixel 8',
    manufacturer: 'Google',
    screen: { width: 1080, height: 2400, densityDpi: 420 },
  },
  {
    id: 'medium_phone',
    name: 'Medium Phone',
    manufacturer: null,
    screen: { width: 1080, height: 2400, densityDpi: 420 },
  },
]);
```

Expected initial fail: `screen` missing.

**Step 2: Run focused test**

Run: `pnpm vitest run electron/services/mobile-preview-android-adapter.test.ts -t "parses avdmanager device profiles"`

Expected: FAIL because `MobilePreviewAndroidDeviceProfile` has no `screen` and parser returns only id/name/manufacturer.

**Step 3: Extend shared type**

Change `MobilePreviewAndroidDeviceProfile`:

```ts
export type MobilePreviewAndroidDeviceProfile = {
  id: string;
  name: string;
  manufacturer: string | null;
  screen: {
    width: number;
    height: number;
    densityDpi: number | null;
  } | null;
};
```

**Step 4: Add curated fallback map**

Near Android constants in `mobile-preview-android-adapter.ts`, add only common profiles we can state confidently. Keep map small; unknown profiles return `null`.

```ts
const ANDROID_DEVICE_PROFILE_SPECS: Record<
  string,
  { width: number; height: number; densityDpi: number | null }
> = {
  pixel_8: { width: 1080, height: 2400, densityDpi: 420 },
  pixel_8_pro: { width: 1344, height: 2992, densityDpi: 560 },
  pixel_7: { width: 1080, height: 2400, densityDpi: 420 },
  pixel_7_pro: { width: 1440, height: 3120, densityDpi: 560 },
  pixel_tablet: { width: 1600, height: 2560, densityDpi: 320 },
  medium_phone: { width: 1080, height: 2400, densityDpi: 420 },
  small_phone: { width: 720, height: 1280, densityDpi: 320 },
};
```

**Step 5: Implement parser support**

In `parseAndroidDeviceProfiles`, parse optional `Screen:` and `Density:` lines, else fallback to `ANDROID_DEVICE_PROFILE_SPECS[id] ?? null`.

Implementation shape:

```ts
const screenMatch = entry.match(/Screen:\s*(\d+)\s*x\s*(\d+)/i);
const densityMatch = entry.match(/Density:\s*(\d+)/i);
const parsedScreen = screenMatch
  ? {
      width: Number(screenMatch[1]),
      height: Number(screenMatch[2]),
      densityDpi: densityMatch ? Number(densityMatch[1]) : null,
    }
  : null;
const screen = parsedScreen ?? ANDROID_DEVICE_PROFILE_SPECS[id] ?? null;
return [{ id, name, manufacturer, screen }];
```

**Step 6: Run focused test**

Run: `pnpm vitest run electron/services/mobile-preview-android-adapter.test.ts -t "parses avdmanager device profiles"`

Expected: PASS.

---

### Task 2: Show Create-Form Preview Summary

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx:1610-1626`
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx:3585-3628`

**Step 1: Add selected profile/image derived state**

Below `androidSystemImageOptions`, add memoized selections:

```ts
const selectedAndroidProfile = useMemo(
  () =>
    (androidManagement.profiles.data ?? []).find(
      (profile) => profile.id === androidDeviceProfileId,
    ) ?? null,
  [androidDeviceProfileId, androidManagement.profiles.data],
);
const selectedAndroidSystemImage = useMemo(
  () =>
    (androidManagement.systemImages.data ?? []).find(
      (image) => image.id === androidSystemImageId,
    ) ?? null,
  [androidSystemImageId, androidManagement.systemImages.data],
);
```

**Step 2: Add formatting helpers**

Near existing helper functions around `formatError`, add:

```ts
function formatAndroidScreenSpec(
  screen: { width: number; height: number; densityDpi: number | null } | null,
) {
  if (!screen) return 'Dimensions unknown';
  return `${screen.width} x ${screen.height}${
    screen.densityDpi ? ` @ ${screen.densityDpi} dpi` : ''
  }`;
}

function formatAndroidImageTag(tag: string) {
  return tag.replaceAll('_', ' ');
}
```

**Step 3: Render preview card**

Inside create form after system image `<Select />` and before create `<Button />`, add a compact summary card:

```tsx
<div className="grid gap-1 rounded-md border border-line bg-bg-0 p-2 text-[11px]">
  <div className="flex items-center justify-between gap-3">
    <span className="text-ink-4">Profile</span>
    <span className="text-ink-1 truncate text-right">
      {selectedAndroidProfile?.name ?? 'Unknown profile'}
    </span>
  </div>
  <div className="flex items-center justify-between gap-3">
    <span className="text-ink-4">Display</span>
    <span className="text-ink-1 truncate text-right font-mono">
      {formatAndroidScreenSpec(selectedAndroidProfile?.screen ?? null)}
    </span>
  </div>
  <div className="flex items-center justify-between gap-3">
    <span className="text-ink-4">System image</span>
    <span className="text-ink-1 truncate text-right">
      {selectedAndroidSystemImage
        ? `API ${selectedAndroidSystemImage.apiLevel} · ${formatAndroidImageTag(
            selectedAndroidSystemImage.tag,
          )} · ${selectedAndroidSystemImage.abi}`
        : 'No image selected'}
    </span>
  </div>
  <div className="flex items-center justify-between gap-3">
    <span className="text-ink-4">Host arch</span>
    <span className="text-ink-1 truncate text-right font-mono">
      {androidManagement.toolStatus.data?.hostArch ?? 'unknown'}
    </span>
  </div>
</div>
```

**Step 4: Run typecheck**

Run: `pnpm ts-check`

Expected: PASS.

---

### Task 3: Add Advanced Create Params Type

**Files:**
- Modify: `shared/mobile-simulator-types.ts:65-69`
- Modify: `electron/services/mobile-preview-android-adapter.test.ts:250-273`

**Step 1: Extend create params**

Add optional fields. Keep all optional to preserve existing callers.

```ts
export type MobilePreviewAndroidCreateDeviceParams = {
  name: string;
  deviceProfileId: string;
  systemImageId: string;
  ramMb?: number;
  vmHeapMb?: number;
  storageMb?: number;
  hwKeyboard?: boolean;
};
```

**Step 2: Write failing test for config write**

In adapter test, add a test after `creates Android AVD with avdmanager`:

```ts
it('writes optional Android AVD config values after create', async () => {
  runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

  await androidAdapter.createAndroidDevice({
    name: 'Pixel_8_API_35',
    deviceProfileId: 'pixel_8',
    systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
    ramMb: 4096,
    vmHeapMb: 512,
    storageMb: 8192,
    hwKeyboard: true,
  });

  expect(runCommandMock).toHaveBeenCalledWith(
    'avdmanager',
    expect.arrayContaining(['create', 'avd']),
    expect.any(Object),
  );
  // Replace with fs mock assertion in Task 4.
});
```

Expected initial fail: no implementation and no fs write mock yet. This test becomes complete in Task 4.

---

### Task 4: Write Advanced AVD Config Safely

**Files:**
- Modify: `electron/services/mobile-preview-android-adapter.ts:1-4`
- Modify: `electron/services/mobile-preview-android-adapter.ts:607-621`
- Modify: `electron/services/mobile-preview-android-adapter.ts:1170-1210`
- Test: `electron/services/mobile-preview-android-adapter.test.ts`

**Step 1: Mock fs write/read in test**

Add mocks for `node:fs/promises` only if not already present. Preserve existing `access`, `readdir`, `readFile` behavior through mock functions where needed by tests.

Prefer smaller approach: extract pure function first, test pure function rather than mocking filesystem.

**Step 2: Add pure config merge function**

In `mobile-preview-android-adapter.ts`, add exported helper near validation helpers:

```ts
export function mergeAndroidAvdConfig(
  currentConfig: string,
  values: {
    ramMb?: number;
    vmHeapMb?: number;
    storageMb?: number;
    hwKeyboard?: boolean;
  },
): string {
  const nextValues: Record<string, string> = {};
  if (values.ramMb !== undefined) nextValues['hw.ramSize'] = String(values.ramMb);
  if (values.vmHeapMb !== undefined) nextValues['vm.heapSize'] = String(values.vmHeapMb);
  if (values.storageMb !== undefined) nextValues['disk.dataPartition.size'] = `${values.storageMb}M`;
  if (values.hwKeyboard !== undefined) nextValues['hw.keyboard'] = values.hwKeyboard ? 'yes' : 'no';

  const seen = new Set<string>();
  const lines = currentConfig.split(/\r?\n/).map((line) => {
    const key = line.split('=')[0];
    if (!(key in nextValues)) return line;
    seen.add(key);
    return `${key}=${nextValues[key]}`;
  });
  for (const [key, value] of Object.entries(nextValues)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  return lines.filter(Boolean).join('\n') + '\n';
}
```

**Step 3: Add pure tests**

Import `mergeAndroidAvdConfig` in adapter test and assert:

```ts
expect(
  mergeAndroidAvdConfig('hw.ramSize=2048\nhw.keyboard=no\n', {
    ramMb: 4096,
    storageMb: 8192,
    hwKeyboard: true,
  }),
).toBe('hw.ramSize=4096\nhw.keyboard=yes\ndisk.dataPartition.size=8192M\n');
```

**Step 4: Validate numeric advanced values**

Add helper:

```ts
function assertOptionalAndroidInteger(
  name: string,
  value: number | undefined,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  assertAndroidInteger(name, value, min, max);
}
```

Use bounds:
- `ramMb`: 512 to 32768
- `vmHeapMb`: 64 to 4096
- `storageMb`: 1024 to 131072

**Step 5: Apply config after create**

After successful `runCommand(avdmanager, ['create', ...])`, if any advanced value exists:
- Read `${homedir()}/.android/avd/${params.name}.avd/config.ini`
- Merge values using `mergeAndroidAvdConfig`
- Write back with `writeFile`

Implementation:

```ts
async function writeAndroidAvdConfig(
  name: string,
  values: Pick<
    MobilePreviewAndroidCreateDeviceParams,
    'ramMb' | 'vmHeapMb' | 'storageMb' | 'hwKeyboard'
  >,
): Promise<void> {
  if (
    values.ramMb === undefined &&
    values.vmHeapMb === undefined &&
    values.storageMb === undefined &&
    values.hwKeyboard === undefined
  ) {
    return;
  }
  const configPath = join(homedir(), '.android', 'avd', `${name}.avd`, 'config.ini');
  const currentConfig = await readFile(configPath, 'utf8');
  await writeFile(configPath, mergeAndroidAvdConfig(currentConfig, values));
}
```

**Step 6: Run focused tests**

Run: `pnpm vitest run electron/services/mobile-preview-android-adapter.test.ts`

Expected: PASS.

---

### Task 5: Add Advanced UI Controls

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx:1300-1309`
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx:1709-1715`
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx:3585-3628`

**Step 1: Add state**

Near existing Android create state:

```ts
const [isAndroidAdvancedOpen, setIsAndroidAdvancedOpen] = useState(false);
const [androidRamMb, setAndroidRamMb] = useState('');
const [androidVmHeapMb, setAndroidVmHeapMb] = useState('');
const [androidStorageMb, setAndroidStorageMb] = useState('');
const [androidHwKeyboard, setAndroidHwKeyboard] = useState(true);
```

**Step 2: Add number parser helper**

Near helpers:

```ts
function parseOptionalPositiveInteger(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
}
```

**Step 3: Include params in create call**

In `handleCreateAndroidDevice`, pass parsed values:

```ts
ramMb: parseOptionalPositiveInteger(androidRamMb),
vmHeapMb: parseOptionalPositiveInteger(androidVmHeapMb),
storageMb: parseOptionalPositiveInteger(androidStorageMb),
hwKeyboard: androidHwKeyboard,
```

Also include new state values in callback dependencies.

**Step 4: Disable create on invalid advanced numbers**

Add derived booleans:

```ts
const androidAdvancedNumbersAreValid = [androidRamMb, androidVmHeapMb, androidStorageMb].every(
  (value) => parseOptionalPositiveInteger(value) !== Number.NaN,
);
```

Use robust implementation instead:

```ts
function isOptionalPositiveInteger(value: string) {
  const parsed = parseOptionalPositiveInteger(value);
  return parsed === undefined || Number.isInteger(parsed);
}
```

Then include in `canCreateAndroidDevice`.

**Step 5: Render advanced disclosure**

After preview summary card:

```tsx
<Button
  size="sm"
  variant="ghost"
  onClick={() => setIsAndroidAdvancedOpen((current) => !current)}
>
  {isAndroidAdvancedOpen ? 'Hide advanced settings' : 'Advanced settings'}
</Button>
{isAndroidAdvancedOpen ? (
  <div className="grid grid-cols-2 gap-2 rounded-md border border-line bg-bg-0 p-2">
    <Input value={androidRamMb} onChange={(event) => setAndroidRamMb(event.target.value)} placeholder="RAM MB" className="h-7 text-xs" />
    <Input value={androidVmHeapMb} onChange={(event) => setAndroidVmHeapMb(event.target.value)} placeholder="Heap MB" className="h-7 text-xs" />
    <Input value={androidStorageMb} onChange={(event) => setAndroidStorageMb(event.target.value)} placeholder="Storage MB" className="h-7 text-xs" />
    <label className="text-ink-3 flex items-center gap-2 text-[11px]">
      <input
        type="checkbox"
        checked={androidHwKeyboard}
        onChange={(event) => setAndroidHwKeyboard(event.currentTarget.checked)}
        className="accent-acc h-3.5 w-3.5"
      />
      Hardware keyboard
    </label>
  </div>
) : null}
```

**Step 6: Run typecheck**

Run: `pnpm ts-check`

Expected: PASS.

---

### Task 6: Polish Details and Error Copy

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx:3540-3565`
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx:3585-3628`

**Step 1: Add SDK tool path debug line**

In missing-tool guidance or preview card, show compact tool path info only when available:

```tsx
{androidManagement.toolStatus.data?.sdkRoot ? (
  <div className="text-ink-4 truncate font-mono text-[10px]">
    SDK: {androidManagement.toolStatus.data.sdkRoot}
  </div>
) : null}
```

**Step 2: Add compatibility hint**

If host is `arm64` and selected image ABI is `x86_64`, show warning. If host is `x64` and selected image ABI is `arm64-v8a`, show warning.

Helper:

```ts
function getAndroidImageCompatibilityWarning(hostArch: string | null | undefined, abi: string | null | undefined) {
  if (!hostArch || !abi) return null;
  if (hostArch === 'arm64' && abi === 'x86_64') return 'x86_64 images are slower on Apple Silicon.';
  if ((hostArch === 'x64' || hostArch === 'ia32') && abi === 'arm64-v8a') return 'arm64 images may not run on Intel hosts.';
  return null;
}
```

Render below preview card if non-null.

**Step 3: Run typecheck**

Run: `pnpm ts-check`

Expected: PASS.

---

### Task 7: Required Verification

**Files:**
- Verify whole repo; do not edit changelogs.

**Step 1: Install**

Run: `pnpm install`

Expected: PASS. Node engine warning is acceptable if current environment remains Node 24.

**Step 2: Tests**

Run: `pnpm test`

Expected: PASS, currently 1114 tests before this work.

**Step 3: Lint fix**

Run: `pnpm lint --fix`

Expected: PASS. Existing sort-import warnings may remain.

**Step 4: Typecheck**

Run: `pnpm ts-check`

Expected: PASS.

**Step 5: Final lint**

Run: `pnpm lint`

Expected: PASS with only non-fatal sort-import warnings if oxlint still reports them.

---

### Notes

- Do not add changelog entries unless explicitly requested.
- Do not commit unless user explicitly asks. If committing later, use conventional commits.
- Keep dimensions best-effort. Unknown profile dimensions should render `Dimensions unknown`, not block create.
- Keep advanced settings optional and small. Avoid exposing every AVD `config.ini` key.
