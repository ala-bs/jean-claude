import { ChevronDown, Download, HardDrive, Loader2, Settings2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MobileBuildArtifact, MobileBuildStoreListParams } from '@shared/mobile-build-store';
import type { MobilePlatform, MobilePreviewDevice } from '@shared/mobile-simulator-types';
import { Button } from '@/common/ui/button';
import { Dropdown, DropdownDivider, DropdownItem } from '@/common/ui/dropdown';
import { Modal } from '@/common/ui/modal';
import { api } from '@/lib/api';

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BuildStore({
  projectPath,
  platform,
  device,
  refreshToken = 0,
}: {
  projectPath: string;
  platform: MobilePlatform;
  device: MobilePreviewDevice | null;
  refreshToken?: number;
}) {
  const dropdownRef = useRef<{ toggle: () => void } | null>(null);
  const [artifacts, setArtifacts] = useState<MobileBuildArtifact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const listParams = useMemo(() => ({ platform, projectPath }), [platform, projectPath]);
  const listRequestRef = useRef(0);
  const refresh = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    const requestParams = listParams;
    const isCurrent = () => requestId === listRequestRef.current;
    setLoading(true);
    try {
      const nextArtifacts = await api.mobileBuildStore.list(requestParams);
      if (!isCurrent()) return;
      setArtifacts(nextArtifacts);
      setError(null);
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [listParams]);

  const handleOpen = useCallback(() => void refresh(), [refresh]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    if (refreshToken === 0) return;
    queueMicrotask(() => void refresh());
  }, [refresh, refreshToken]);

  const install = async (artifact: MobileBuildArtifact) => {
    if (!device) return;
    dropdownRef.current?.toggle();
    setBusy(artifact.id);
    setError(null);
    try {
      await api.mobileBuildStore.install({ artifactId: artifact.id, device });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const openManager = () => {
    dropdownRef.current?.toggle();
    setManagerOpen(true);
  };

  return (
    <>
      <Dropdown
      align="right"
      className="w-[360px]"
      dropdownRef={dropdownRef}
      onOpen={handleOpen}
      trigger={
        <Button
          size="sm"
          variant="secondary"
          className="!rounded-l-none !border-l-0"
          aria-label="Open Build Store"
          icon={<ChevronDown />}
        />
      }
      >
      <div className="text-ink-3 flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium uppercase tracking-wide">
        <HardDrive className="size-3.5" aria-hidden />
        Build Store
      </div>
      {loading ? (
        <div className="text-ink-3 flex items-center gap-2 px-3 py-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading builds…
        </div>
      ) : artifacts.length === 0 ? (
        <p className="text-ink-3 px-3 py-2 text-xs">No stored {platform} builds yet.</p>
      ) : (
        artifacts.map((artifact) => (
          <DropdownItem
            key={artifact.id}
            icon={<Download />}
            disabled={!device || (platform === 'ios' && device.kind === 'physical') || busy !== null}
            onClick={() => void install(artifact)}
          >
            <span className="flex min-w-0 flex-col text-left">
              <span className="truncate">
                {artifact.name ?? (artifact.artifactKind === 'apk' ? 'Android APK' : 'iOS Simulator App')} · {formatBytes(artifact.sizeBytes)}
              </span>
              <span className="text-ink-3 truncate text-[10px]">
                {new Date(artifact.createdAt).toLocaleString()}
              </span>
            </span>
          </DropdownItem>
        ))
      )}
      <DropdownDivider />
      <DropdownItem icon={<Settings2 />} onClick={openManager}>
        Manage Build Store
      </DropdownItem>
      {error && <p className="px-3 py-2 text-xs break-words text-red-500">{error}</p>}
      </Dropdown>
      <Modal isOpen={managerOpen} onClose={() => setManagerOpen(false)} title="Manage Build Store" size="lg">
        <BuildStoreManager
          input={listParams}
          initialArtifacts={artifacts}
          refreshToken={refreshToken}
          onClose={() => setManagerOpen(false)}
        />
      </Modal>
    </>
  );
}

function BuildStoreManager({
  input,
  initialArtifacts,
  refreshToken,
  onClose,
}: {
  input: MobileBuildStoreListParams;
  initialArtifacts: MobileBuildArtifact[];
  refreshToken: number;
  onClose: () => void;
}) {
  const [artifacts, setArtifacts] = useState<MobileBuildArtifact[]>(initialArtifacts);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const listParams = useMemo(
    () => ({ platform: input.platform, projectPath: input.projectPath }),
    [input.platform, input.projectPath],
  );
  const listRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    const requestParams = listParams;
    const isCurrent = () => requestId === listRequestRef.current;
    setLoading(true);
    try {
      const nextArtifacts = await api.mobileBuildStore.list(requestParams);
      if (!isCurrent()) return;
      setArtifacts(nextArtifacts);
      setError(null);
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [listParams]);

  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  useEffect(() => {
    if (refreshToken === 0) return;
    queueMicrotask(() => void refresh());
  }, [refresh, refreshToken]);

  const remove = async (artifact: MobileBuildArtifact) => {
    if (!window.confirm(`Delete stored build from ${new Date(artifact.createdAt).toLocaleString()}?`)) return;
    setBusy(artifact.id);
    setError(null);
    try {
      await api.mobileBuildStore.delete({ artifactId: artifact.id });
      setArtifacts((current) => current.filter((item) => item.id !== artifact.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const rename = async (artifact: MobileBuildArtifact, draft: string) => {
    const name = draft.trim();
    if (!name || name === artifact.name) return;
    setBusy(artifact.id);
    setError(null);
    try {
      await api.mobileBuildStore.rename({ artifactId: artifact.id, name });
      setArtifacts((current) => current.map((item) => item.id === artifact.id ? { ...item, name } : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="max-h-[55vh] overflow-y-auto p-4">
        {loading ? (
          <div className="text-ink-3 flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading builds…
          </div>
        ) : artifacts.length === 0 ? (
          <p className="text-ink-3 text-sm">No stored builds for this app.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {artifacts.map((artifact) => (
              <div key={artifact.id} className="bg-bg-1 flex items-center gap-2 rounded-md px-3 py-2">
                <div className="min-w-0 flex-1">
                  <input
                    value={nameDrafts[artifact.id] ?? artifact.name ?? ''}
                    placeholder={artifact.artifactKind === 'apk' ? 'Android APK' : 'iOS Simulator App'}
                    onChange={(event) => setNameDrafts((current) => ({ ...current, [artifact.id]: event.target.value }))}
                    onBlur={(event) => void rename(artifact, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    className="bg-bg-0 text-ink-1 w-full rounded border border-glass-border px-1.5 py-0.5 text-xs outline-none"
                    maxLength={120}
                    aria-label="Build name"
                  />
                  <p className="text-ink-3 truncate text-[10px]">{new Date(artifact.createdAt).toLocaleString()}</p>
                </div>
                <button
                  type="button"
                  aria-label="Delete stored build"
                  className="text-ink-3 hover:text-red-400 shrink-0 rounded p-1"
                  disabled={busy !== null}
                  onClick={() => void remove(artifact)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="mt-2 text-xs break-words text-red-500">{error}</p>}
      </div>
      <div className="border-glass-border flex justify-end gap-2 border-t px-4 py-3">
        <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
