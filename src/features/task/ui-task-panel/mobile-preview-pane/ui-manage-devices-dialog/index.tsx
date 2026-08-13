import { AlertTriangle, Check, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import { Button } from '@/common/ui/button';
import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';
import { Select } from '@/common/ui/select';

import type {
  useAndroidDeviceManagement,
  useIosDeviceManagement,
} from '@/hooks/use-mobile-preview';
import type { useMobilePreviewDeviceSelection } from '@/stores/navigation';

import type {
  MobilePlatform,
  MobilePreviewDevice,
} from '@shared/mobile-simulator-types';

import { PlatformLogo } from '../ui-common';
import { cleanPreviewError, formatError } from '../utils-preview-error';
import {
  formatAndroidImageTag,
  formatAndroidScreenSpec,
  formatDeviceState,
  getAndroidImageCompatibilityWarning,
  getIosDeviceChrome,
  getOptionalPositiveInteger,
  getPreferredAndroidSystemImage,
  getSuggestedAndroidSystemImageId,
  getSuggestedIosDeviceName,
  isOptionalPositiveInteger,
} from '../utils-device-setup';

export function ManageDevicesDialog({
  platform,
  deviceId,
  allDevices,
  visibleDevices,
  androidManagement,
  iosManagement,
  visibleDeviceIdsByPlatform,
  setVisibleDeviceIdsByPlatform,
  isCreateIosDeviceOpen,
  setIsCreateIosDeviceOpen,
  onSelectPreviewDevice,
  onClose,
}: {
  platform: MobilePlatform;
  deviceId: string;
  allDevices: MobilePreviewDevice[];
  visibleDevices: MobilePreviewDevice[];
  androidManagement: ReturnType<typeof useAndroidDeviceManagement>;
  iosManagement: ReturnType<typeof useIosDeviceManagement>;
  visibleDeviceIdsByPlatform: ReturnType<
    typeof useMobilePreviewDeviceSelection
  >['visibleDeviceIdsByPlatform'];
  setVisibleDeviceIdsByPlatform: ReturnType<
    typeof useMobilePreviewDeviceSelection
  >['setVisibleDeviceIdsByPlatform'];
  isCreateIosDeviceOpen: boolean;
  setIsCreateIosDeviceOpen: (open: boolean) => void;
  onSelectPreviewDevice: (device: {
    platform: MobilePlatform;
    deviceId: string;
  }) => void;
  onClose: () => void;
}) {
  const [isCreateAndroidDeviceOpen, setIsCreateAndroidDeviceOpen] =
    useState(false);
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
  const suggestedIosDeviceNameRef = useRef('');

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
    function handleManageDevicesEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (isCreatingManagedDevice) {
        setIsCreateAndroidDeviceOpen(false);
        setIsCreateIosDeviceOpen(false);
      } else {
        onClose();
      }
    }

    window.addEventListener('keydown', handleManageDevicesEscape, true);
    return () =>
      window.removeEventListener('keydown', handleManageDevicesEscape, true);
  }, [isCreatingManagedDevice, onClose, setIsCreateIosDeviceOpen]);

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
            ...(current.android ??
              managedDevicesByPlatform.android.map((device) => device.id)),
            trimmedAndroidDeviceName,
          ]),
        ],
      }));
      onSelectPreviewDevice({
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
    androidRamMb,
    androidStorageMb,
    androidSystemImageId,
    androidVmHeapMb,
    canCreateAndroidDevice,
    managedDevicesByPlatform.android,
    onSelectPreviewDevice,
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
        android: (
          current.android ??
          managedDevicesByPlatform.android.map((device) => device.id)
        ).filter((id) => id !== name),
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
              ...(current.ios ??
                managedDevicesByPlatform.ios.map((device) => device.id)),
              createdDeviceId,
            ]),
          ],
        }));
        onSelectPreviewDevice({ platform: 'ios', deviceId: createdDeviceId });
      }
      setIsCreateIosDeviceOpen(false);
    } catch {
      // Mutation error is rendered from React Query state.
    }
  }, [
    canCreateIosDevice,
    iosDeviceTypeId,
    iosManagement.createDevice,
    iosRuntimeId,
    managedDevicesByPlatform.ios,
    onSelectPreviewDevice,
    setIsCreateIosDeviceOpen,
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
        ios: (
          current.ios ?? managedDevicesByPlatform.ios.map((device) => device.id)
        ).filter((id) => id !== deviceIdToDelete),
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

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
      onMouseDown={onClose}
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
                onClose();
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
                      onSelectPreviewDevice({
                        platform: selectedManagedDevice.platform,
                        deviceId: selectedManagedDevice.id,
                      });
                      onClose();
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
              onClick={onClose}
            >
              Done
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
