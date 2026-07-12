import {
  Check,
  Download,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useState } from 'react';

import type { AgentBackendType } from '@shared/agent-backend-types';
import type {
  DiscoveredMcpGroup,
  DiscoveredMcpVariant,
  GlobalMcpServer,
  McpTransportType,
} from '@shared/global-mcp-types';
import {
  useCreateGlobalMcpServer,
  useDisableGlobalMcpServer,
  useDiscoverMcpEntries,
  useEnableGlobalMcpServer,
  useGlobalMcpServers,
  useImportMcpEntry,
  useUninstallGlobalMcpServer,
  useUpdateGlobalMcpServer,
} from '@/hooks/use-global-mcp';
import { Button } from '@/common/ui/button';
import { backendSupportsTransport } from '@/lib/global-mcp-support';
import {
  parsePastedArguments,
  parsePastedEnvironment,
} from '@/lib/global-mcp-input';

const ALL_BACKENDS: { id: AgentBackendType; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'vibe', label: 'Vibe' },
];

const TRANSPORT_TYPES: { id: McpTransportType; label: string }[] = [
  { id: 'stdio', label: 'stdio' },
  { id: 'http', label: 'HTTP' },
  { id: 'sse', label: 'SSE' },
];

export function GlobalMcpSettings() {
  const { data: servers, isLoading, error: serversError, refetch: refetchServers } = useGlobalMcpServers();
  const createServer = useCreateGlobalMcpServer();
  const updateServer = useUpdateGlobalMcpServer();
  const uninstallServer = useUninstallGlobalMcpServer();
  const enableServer = useEnableGlobalMcpServer();
  const disableServer = useDisableGlobalMcpServer();
  const {
    data: discovered,
    refetch: discoverEntries,
    isFetching: isDiscovering,
    error: discoveryError,
  } = useDiscoverMcpEntries();
  const importEntry = useImportMcpEntry();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const selectedServer = servers?.find((s) => s.id === selectedId);

  const handleCreate = useCallback(() => {
    setSelectedId(null);
    setIsCreating(true);
    setShowDiscover(false);
  }, []);

  const handleDiscover = useCallback(async () => {
    setShowDiscover(true);
    setIsCreating(false);
    setSelectedId(null);
    await discoverEntries();
  }, [discoverEntries]);

  const handleSelect = useCallback((id: string) => {
    setIsCreating(false);
    setShowDiscover(false);
    setSelectedId(id);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedId(null);
    setIsCreating(false);
    setShowDiscover(false);
  }, []);

  if (isLoading) {
    return <p className="text-ink-3" role="status" aria-live="polite">Loading...</p>;
  }

  if (serversError) {
    return (
      <div className="space-y-2">
        <p className="text-status-error text-sm" role="alert">{serversError.message}</p>
        <Button size="sm" variant="secondary" onClick={() => void refetchServers()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-ink-2 mb-1 text-xs font-semibold uppercase tracking-wider">
          Global MCP Servers
        </h3>
        <p className="text-ink-3 mb-4 text-xs">
          Manage MCP servers across all agent backends. Separate from
          per-project worktree templates above.
        </p>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleCreate} size="sm" icon={<Plus size={14} />}>
          Add Server
        </Button>
        <Button
          onClick={handleDiscover}
          size="sm"
          variant="secondary"
          icon={<Search size={14} />}
        >
          Discover
        </Button>
      </div>
      {operationError && <p className="text-status-error text-xs" role="alert">{operationError}</p>}

      {/* Server list */}
      {servers && servers.length > 0 && (
        <div className="space-y-1">
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              isSelected={selectedId === server.id}
              isMutating={
                enableServer.isPending ||
                disableServer.isPending ||
                updateServer.isPending ||
                uninstallServer.isPending
              }
              onSelect={() => handleSelect(server.id)}
              onToggle={async (backend, enabled) => {
                try {
                  setOperationError(null);
                  if (enabled) await disableServer.mutateAsync({ id: server.id, backends: [backend] });
                  else await enableServer.mutateAsync({ id: server.id, backends: [backend] });
                } catch (error) {
                  setOperationError(error instanceof Error ? error.message : 'Backend update failed');
                }
              }}
              onUninstall={async () => {
                if (!window.confirm(`Uninstall "${server.name}" and remove it from ${server.enabledBackends.join(', ') || 'no backends'}?`)) return;
                try {
                  setOperationError(null);
                  await uninstallServer.mutateAsync(server.id);
                  if (selectedId === server.id) setSelectedId(null);
                } catch (error) {
                  setOperationError(error instanceof Error ? error.message : 'Uninstall failed');
                }
              }}
            />
          ))}
        </div>
      )}

      {servers && servers.length === 0 && !isCreating && !showDiscover && (
        <p className="text-ink-3 py-4 text-center text-sm">
          No global MCP servers configured. Add one or discover existing
          entries from backend configs.
        </p>
      )}

      {/* Create form */}
      {isCreating && (
        <div className="border-glass-border rounded-lg border p-4">
          <ServerForm
            onSubmit={async (data) => {
              await createServer.mutateAsync(data);
              setIsCreating(false);
            }}
            onCancel={handleClose}
          />
        </div>
      )}

      {/* Edit form */}
      {selectedServer && (
        <div className="border-glass-border rounded-lg border p-4">
          <ServerForm
            server={selectedServer}
            onSubmit={async (data) => {
              await updateServer.mutateAsync({
                id: selectedServer.id,
                data,
              });
              setSelectedId(null);
            }}
            onCancel={handleClose}
          />
        </div>
      )}

      {/* Discover panel */}
      {showDiscover && (
        <div className="border-glass-border rounded-lg border p-4">
          <h4 className="text-ink-1 mb-2 text-sm font-medium">
            Discovered MCP Entries
          </h4>
          {isDiscovering && (
            <p className="text-ink-3 text-sm" role="status" aria-live="polite">Scanning backend configs...</p>
          )}
          {discoveryError && (
            <div className="space-y-2">
              <p className="text-status-error text-xs" role="alert">{discoveryError.message}</p>
              <Button size="sm" variant="secondary" onClick={() => void discoverEntries()}>Retry</Button>
            </div>
          )}
           {!isDiscovering && discovered && discovered.groups.length === 0 && (
            <p className="text-ink-3 text-sm">
              No unmanaged MCP entries found in backend configs.
            </p>
          )}
          {!isDiscovering &&
             discovered &&
             discovered.groups.map((group) => (
              <DiscoveredGroupCard
                key={group.normalizedName}
                group={group}
                onImport={async (variant, backends) => {
                  try {
                    setOperationError(null);
                    await importEntry.mutateAsync({ entry: variant, backends });
                    await discoverEntries();
                  } catch (error) {
                    setOperationError(error instanceof Error ? error.message : 'Import failed');
                    throw error;
                  }
                }}
              />
             ))}
          {!isDiscovering && discovered?.errors.map((error) => (
            <p key={error.backend} className="text-status-error text-xs" role="alert">
              {error.backend}: {error.message}
            </p>
          ))}
          <div className="mt-3">
            <Button onClick={handleClose} size="sm" variant="secondary">
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ServerRow({
  server,
  isSelected,
  isMutating,
  onSelect,
  onUninstall,
  onToggle,
}: {
  server: GlobalMcpServer;
  isSelected: boolean;
  isMutating: boolean;
  onSelect: () => void;
  onUninstall: () => void;
  onToggle: (backend: AgentBackendType, enabled: boolean) => Promise<void>;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${
        isSelected
          ? 'bg-white/[0.08] border border-white/10'
          : 'hover:bg-white/[0.04] border border-transparent'
      }`}
    >
      <div
        className="min-w-0 flex-1 text-left"
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') onSelect();
        }}
        role="button"
        tabIndex={0}
      >
        <div className="text-ink-1 truncate text-sm font-medium">
          {server.name}
        </div>
        <div className="text-ink-3 truncate text-xs">
          {server.transportType} ·{' '}
          {server.enabledBackends.length > 0
            ? server.enabledBackends.join(', ')
            : 'no backends enabled'}
        </div>
        <div className="mt-1 flex gap-1">
          {ALL_BACKENDS.map((backend) => {
            const enabled = server.enabledBackends.includes(backend.id);
            const supported = backendSupportsTransport(
              backend.id,
              server.transportType,
            );
            return (
              <button
                key={backend.id}
                disabled={isMutating || !supported}
                title={
                  supported
                    ? `${enabled ? 'Disable' : 'Enable'} on ${backend.label}`
                    : `${backend.label} does not support ${server.transportType}`
                }
                className={`rounded px-1.5 py-0.5 text-[10px] ${enabled ? 'bg-white/10 text-ink-1' : 'text-ink-3'}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void onToggle(backend.id, enabled);
                }}
              >
                {backend.label}{!supported && ' (unavailable)'}
              </button>
            );
          })}
        </div>
      </div>
      <button
        className="text-ink-3 hover:text-status-error shrink-0 p-1 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onUninstall();
        }}
        aria-label="Uninstall"
        disabled={isMutating}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function DiscoveredGroupCard({
  group,
  onImport,
}: {
  group: DiscoveredMcpGroup;
  onImport: (
    variant: DiscoveredMcpVariant,
    backends: AgentBackendType[],
  ) => Promise<void>;
}) {
  return (
    <div className="border-glass-border space-y-2 rounded-md border p-3">
      <div>
        <div className="text-ink-1 text-sm font-medium">{group.name}</div>
        {group.conflict ? (
          <p className="text-status-error text-xs" role="alert">
            Configuration conflict. Select one variant as canonical.
          </p>
        ) : (
          <p className="text-ink-3 text-xs">
            Found in{' '}
            {group.variants[0].sources
              .map((source) => backendLabel(source.backend))
              .join(', ')}
          </p>
        )}
      </div>
      {group.variants.map((variant) => (
        <DiscoveredVariantRow
          key={`${variant.common.transportType}:${variant.common.command ?? variant.common.url}:${variant.common.args.join('\u0000')}`}
          variant={variant}
          showDetails={group.conflict}
          onImport={onImport}
        />
      ))}
    </div>
  );
}

function DiscoveredVariantRow({
  variant,
  showDetails,
  onImport,
}: {
  variant: DiscoveredMcpVariant;
  showDetails: boolean;
  onImport: (
    variant: DiscoveredMcpVariant,
    backends: AgentBackendType[],
  ) => Promise<void>;
}) {
  const [selectedBackends, setSelectedBackends] = useState<
    AgentBackendType[]
  >(variant.sources.map((source) => source.backend));
  const [canonicalName, setCanonicalName] = useState(variant.canonicalName);
  const [importing, setImporting] = useState(false);
  const canonicalNameValid = /^[A-Za-z0-9_-]{1,128}$/.test(
    canonicalName.trim(),
  );

  return (
    <div className="flex items-center gap-3 border-b border-white/5 py-2 last:border-0">
      <div className="min-w-0 flex-1">
        {showDetails && (
          <div className="text-ink-2 text-xs">
            {variant.common.transportType === 'stdio'
              ? [variant.common.command, ...variant.common.args]
                  .filter(Boolean)
                  .join(' ')
              : variant.common.url}
          </div>
        )}
        <label className="text-ink-3 mt-2 block text-xs">
          Managed name
          <input
            className="border-glass-border bg-bg-1 text-ink-1 mt-1 w-full rounded border px-2 py-1"
            value={canonicalName}
            onChange={(event) => setCanonicalName(event.target.value)}
            aria-label={`Managed name for ${variant.name}`}
          />
        </label>
        {!canonicalNameValid && (
          <p className="text-status-error text-xs" role="alert">
            Use 1-128 letters, numbers, hyphens, or underscores.
          </p>
        )}
        {showDetails && (
          <div className="text-ink-3 text-xs">
            Sources:{' '}
            {variant.sources
              .map(
                (source) =>
                  `${backendLabel(source.backend)} (${source.entryName})`,
              )
              .join(', ')}
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          {ALL_BACKENDS.map((b) => (
            <label
              key={b.id}
              className="flex items-center gap-1 text-xs text-ink-3"
            >
              <input
                type="checkbox"
                checked={selectedBackends.includes(b.id)}
                disabled={
                  importing ||
                  !backendSupportsTransport(
                    b.id,
                    variant.common.transportType,
                  )
                }
                onChange={(e) => {
                  setSelectedBackends((prev) =>
                    e.target.checked
                      ? [...prev, b.id]
                      : prev.filter((x) => x !== b.id),
                  );
                }}
                className="size-3"
              />
              {b.label}
            </label>
          ))}
        </div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        icon={<Download size={14} />}
        disabled={
          importing || selectedBackends.length === 0 || !canonicalNameValid
        }
        onClick={async () => {
          setImporting(true);
          try {
            await onImport(
              { ...variant, canonicalName: canonicalName.trim() },
              selectedBackends,
            );
          } finally {
            setImporting(false);
          }
        }}
      >
        Import
      </Button>
    </div>
  );
}

function backendLabel(backend: AgentBackendType): string {
  return ALL_BACKENDS.find((item) => item.id === backend)?.label ?? backend;
}

function ServerForm({
  server,
  onSubmit,
  onCancel,
}: {
  server?: GlobalMcpServer;
  onSubmit: (
    data: {
      name: string;
      transportType: McpTransportType;
      command?: string | null;
      args?: string[];
      env?: Record<string, string>;
      url?: string | null;
      enabledBackends: AgentBackendType[];
    },
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [transportType, setTransportType] = useState<McpTransportType>(
    server?.transportType ?? 'stdio',
  );
  const [command, setCommand] = useState(server?.command ?? '');
  const [args, setArgs] = useState<string[]>(server?.args ?? []);
  const [environment, setEnvironment] = useState(
    Object.entries(server?.env ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [environmentTouched, setEnvironmentTouched] = useState(
    !server?.hasStoredEnv,
  );
  const [url, setUrl] = useState(server?.url ?? '');
  const [enabledBackends, setEnabledBackends] = useState<AgentBackendType[]>(
    server?.enabledBackends ?? [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const duplicateEnvironmentKey = environment.find(
        ({ key }, index) =>
          key.trim() &&
          environment.findIndex((entry) => entry.key.trim() === key.trim()) !==
            index,
      );
      if (duplicateEnvironmentKey) {
        throw new Error(
          `Environment variable "${duplicateEnvironmentKey.key.trim()}" is duplicated`,
        );
      }
      if (environment.some(({ key }) => !key.trim()))
        throw new Error('Environment variable names cannot be empty');
      const parsedEnv = environmentTouched
        ? Object.fromEntries(
            environment.map(({ key, value }) => [key.trim(), value]),
          )
        : undefined;
      await onSubmit({
        name: name.trim(),
        transportType,
        command: transportType === 'stdio' ? command || null : null,
        args: transportType === 'stdio' ? args : [],
        env: transportType === 'stdio' ? parsedEnv : {},
        url:
          transportType !== 'stdio' ? url || null : null,
        enabledBackends,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <h4 className="text-ink-1 text-sm font-medium">
        {server ? 'Edit MCP Server' : 'New MCP Server'}
      </h4>

      {error && (
        <div className="text-status-error rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs" role="alert">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="text-ink-2 mb-1 block text-xs">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border-glass-border bg-bg-1 text-ink-1 w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:border-white/20"
            placeholder="my-mcp-server"
          />
        </div>

        <div>
          <label className="text-ink-2 mb-1 block text-xs">Transport</label>
          <div className="flex gap-2">
            {TRANSPORT_TYPES.map((t) => (
              <button
                key={t.id}
                className={`rounded-md px-3 py-1 text-xs transition-colors ${
                  transportType === t.id
                    ? 'bg-white/10 text-ink-1'
                    : 'text-ink-3 hover:bg-white/5'
                }`}
                onClick={() => {
                  setTransportType(t.id);
                  setEnabledBackends((backends) =>
                    backends.filter((backend) =>
                      backendSupportsTransport(backend, t.id),
                    ),
                  );
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {transportType === 'stdio' && (
          <>
            <div>
              <label className="text-ink-2 mb-1 block text-xs">
                Command
              </label>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="border-glass-border bg-bg-1 text-ink-1 w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:border-white/20"
                placeholder="npx"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-ink-2 block text-xs">Arguments</label>
                <button
                  type="button"
                  className="text-ink-3 hover:text-ink-1 flex items-center gap-1 text-xs transition-colors"
                  onClick={() => {
                    const index = args.length;
                    setArgs((current) => [...current, '']);
                    requestAnimationFrame(() =>
                      document.getElementById(`mcp-argument-${index}`)?.focus(),
                    );
                  }}
                >
                  <Plus className="size-3" />
                  Add argument
                </button>
              </div>
              {args.length === 0 ? (
                <button
                  type="button"
                  className="border-glass-border text-ink-3 hover:border-glass-border-strong hover:text-ink-2 w-full rounded-md border border-dashed px-3 py-2 text-left text-xs transition-colors"
                  onClick={() => setArgs([''])}
                >
                  No arguments. Click to add one.
                </button>
              ) : (
                <div className="space-y-1.5">
                  {args.map((argument, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <span className="text-ink-3 w-5 shrink-0 text-right font-mono text-[10px]">
                        {index + 1}
                      </span>
                      <input
                        id={`mcp-argument-${index}`}
                        type="text"
                        value={argument}
                        onChange={(event) =>
                          setArgs((current) =>
                            current.map((value, itemIndex) =>
                              itemIndex === index ? event.target.value : value,
                            ),
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          setArgs((current) => [
                            ...current.slice(0, index + 1),
                            '',
                            ...current.slice(index + 1),
                          ]);
                          requestAnimationFrame(() =>
                            document
                              .getElementById(`mcp-argument-${index + 1}`)
                              ?.focus(),
                          );
                        }}
                        onPaste={(event) => {
                          const pasted = parsePastedArguments(
                            event.clipboardData.getData('text'),
                          );
                          if (!pasted) return;
                          event.preventDefault();
                          setArgs((current) => [
                            ...current.slice(0, index),
                            ...pasted,
                            ...current.slice(index + 1),
                          ]);
                        }}
                        className="border-glass-border bg-bg-1 text-ink-1 min-w-0 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus:border-white/20"
                        placeholder={index === 0 ? '--port' : '3000'}
                        aria-label={`Argument ${index + 1}`}
                      />
                      <button
                        type="button"
                        className="text-ink-3 hover:text-status-error rounded p-1.5 transition-colors"
                        onClick={() =>
                          setArgs((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                        aria-label={`Remove argument ${index + 1}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-ink-3 mt-1 text-[11px]">
                Enter adds a row. Paste a JSON array or multiple lines to add several.
              </p>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-ink-2 block text-xs">Environment</label>
                <button
                  type="button"
                  className="text-ink-3 hover:text-ink-1 flex items-center gap-1 text-xs transition-colors"
                  onClick={() => {
                    const index = environment.length;
                    setEnvironmentTouched(true);
                    setEnvironment((current) => [
                      ...current,
                      { key: '', value: '' },
                    ]);
                    requestAnimationFrame(() =>
                      document
                        .getElementById(`mcp-environment-key-${index}`)
                        ?.focus(),
                    );
                  }}
                >
                  <Plus className="size-3" />
                  Add variable
                </button>
              </div>
              {server?.hasStoredEnv && !environmentTouched ? (
                <button
                  type="button"
                  className="border-glass-border text-ink-3 hover:border-glass-border-strong hover:text-ink-2 w-full rounded-md border border-dashed px-3 py-2 text-left text-xs transition-colors"
                  onClick={() => setEnvironmentTouched(true)}
                >
                  Stored values are hidden. Click to replace them.
                </button>
              ) : environment.length === 0 ? (
                <button
                  type="button"
                  className="border-glass-border text-ink-3 hover:border-glass-border-strong hover:text-ink-2 w-full rounded-md border border-dashed px-3 py-2 text-left text-xs transition-colors"
                  onClick={() => {
                    setEnvironmentTouched(true);
                    setEnvironment([{ key: '', value: '' }]);
                  }}
                >
                  No environment variables. Click to add one.
                </button>
              ) : (
                <div className="space-y-1.5">
                  {environment.map((entry, index) => (
                    <div key={index} className="flex items-center gap-1.5">
                      <input
                        id={`mcp-environment-key-${index}`}
                        type="text"
                        value={entry.key}
                        onChange={(event) => {
                          setEnvironmentTouched(true);
                          setEnvironment((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, key: event.target.value }
                                : item,
                            ),
                          );
                        }}
                        onPaste={(event) => {
                          const pasted = parsePastedEnvironment(
                            event.clipboardData.getData('text'),
                          );
                          if (!pasted) return;
                          event.preventDefault();
                          setEnvironmentTouched(true);
                          setEnvironment((current) => [
                            ...current.slice(0, index),
                            ...pasted,
                            ...current.slice(index + 1),
                          ]);
                        }}
                        className="border-glass-border bg-bg-1 text-ink-1 w-2/5 min-w-0 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus:border-white/20"
                        placeholder="API_KEY"
                        aria-label={`Environment variable ${index + 1} name`}
                      />
                      <span className="text-ink-3">=</span>
                      <input
                        type="text"
                        value={entry.value}
                        onChange={(event) => {
                          setEnvironmentTouched(true);
                          setEnvironment((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          );
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          setEnvironmentTouched(true);
                          setEnvironment((current) => [
                            ...current.slice(0, index + 1),
                            { key: '', value: '' },
                            ...current.slice(index + 1),
                          ]);
                          requestAnimationFrame(() =>
                            document
                              .getElementById(
                                `mcp-environment-key-${index + 1}`,
                              )
                              ?.focus(),
                          );
                        }}
                        className="border-glass-border bg-bg-1 text-ink-1 min-w-0 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none focus:border-white/20"
                        placeholder="value"
                        aria-label={`Environment variable ${index + 1} value`}
                      />
                      <button
                        type="button"
                        className="text-ink-3 hover:text-status-error rounded p-1.5 transition-colors"
                        onClick={() => {
                          setEnvironmentTouched(true);
                          setEnvironment((current) =>
                            current.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          );
                        }}
                        aria-label={`Remove environment variable ${index + 1}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-ink-3 mt-1 text-[11px]">
                Enter adds a row. Paste a JSON object or KEY=value lines to add several.
              </p>
            </div>
          </>
        )}

        {transportType !== 'stdio' && (
          <div>
            <label className="text-ink-2 mb-1 block text-xs">URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="border-glass-border bg-bg-1 text-ink-1 w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:border-white/20"
              placeholder="http://localhost:3000/mcp"
            />
          </div>
        )}

        <div>
          <label className="text-ink-2 mb-1 block text-xs">
            Enabled Backends
          </label>
          <div className="flex flex-wrap gap-2">
            {ALL_BACKENDS.map((b) => {
              const checked = enabledBackends.includes(b.id);
              const supported = backendSupportsTransport(b.id, transportType);
              return (
                <label
                  key={b.id}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                    checked
                      ? 'bg-white/10 text-ink-1'
                      : 'text-ink-3 hover:bg-white/5'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!supported}
                    onChange={(e) => {
                      setEnabledBackends((prev) =>
                        e.target.checked
                          ? [...prev, b.id]
                          : prev.filter((x) => x !== b.id),
                      );
                    }}
                    className="size-3"
                  />
                  {b.label}
                  {!supported && ' (unsupported)'}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={submitting}
          icon={<Check size={14} />}
        >
          {server ? 'Save' : 'Create'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onCancel}
          icon={<X size={14} />}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
