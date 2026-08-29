import { AlertTriangle, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';

import {
  useCreateProjectEnvVar,
  useDeleteProjectEnvVar,
  useProjectEnvVars,
  useSecretStorageAvailable,
  useUpdateProjectEnvVar,
} from '@/hooks/use-project-env-vars';
import { Button } from '@/common/ui/button';
import { Input } from '@/common/ui/input';
import type { ProjectEnvVar } from '@shared/types';
import { Switch } from '@/common/ui/switch';
import { useToastStore } from '@/stores/toasts';

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Per-project environment variables injected into every agent run.
 *
 * Secrets are write-only: once saved, the stored value never comes back over
 * IPC, so the row renders a masked placeholder and edits replace the value.
 */
export function ProjectEnvSettings({ projectId }: { projectId: string }) {
  const { data: envVars = [], isLoading } = useProjectEnvVars(projectId);
  const { data: secretStorageAvailable = false } = useSecretStorageAvailable();
  const addToast = useToastStore((s) => s.addToast);

  const createEnvVar = useCreateProjectEnvVar();
  const updateEnvVar = useUpdateProjectEnvVar();
  const deleteEnvVar = useDeleteProjectEnvVar();

  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newIsSecret, setNewIsSecret] = useState(false);

  const handleAdd = useCallback(() => {
    const key = newKey.trim();
    if (!key) return;
    if (!ENV_KEY_PATTERN.test(key)) {
      addToast({
        message: `"${key}" isn't a valid variable name. Use letters, digits and underscores, and don't start with a digit.`,
        type: 'error',
      });
      return;
    }
    if (envVars.some((envVar) => envVar.key === key)) {
      addToast({ message: `"${key}" is already set.`, type: 'error' });
      return;
    }

    createEnvVar.mutate(
      {
        projectId,
        key,
        value: newValue,
        isSecret: newIsSecret,
        sortOrder: envVars.length,
      },
      {
        onSuccess: () => {
          setNewKey('');
          setNewValue('');
          setNewIsSecret(false);
        },
        onError: (error) => {
          addToast({
            message: errorMessage(error, 'Failed to add environment variable'),
            type: 'error',
          });
        },
      },
    );
  }, [
    addToast,
    createEnvVar,
    envVars,
    newIsSecret,
    newKey,
    newValue,
    projectId,
  ]);

  const brokenSecrets = envVars.filter((envVar) => envVar.decryptionFailed);

  if (isLoading) return <p className="text-ink-3">Loading...</p>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-ink-1 text-lg font-semibold">
          Environment Variables
        </h2>
        <p className="text-ink-3 mt-1 text-sm">
          Injected into every agent run for this project, across all backends.
          Secrets are encrypted with your OS keychain and can be replaced or
          removed, but never read back.
        </p>
      </div>

      {brokenSecrets.length > 0 && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
          {brokenSecrets.length === 1
            ? `The secret ${brokenSecrets[0]!.key} can no longer be decrypted`
            : `${brokenSecrets.length} secrets can no longer be decrypted (${brokenSecrets
                .map((envVar) => envVar.key)
                .join(', ')})`}{' '}
          — this usually means the keychain was reset or the app data moved
          between machines. Agent runs skip {brokenSecrets.length === 1
            ? 'it'
            : 'them'}{' '}
          until you type a new value below.
        </p>
      )}

      {!secretStorageAvailable && (
        <p className="text-ink-3 bg-surface-2 rounded-md p-3 text-sm">
          Secure storage isn&apos;t available on this system, so secret
          variables are disabled. Plain variables still work.
        </p>
      )}

      <div className="space-y-2">
        {envVars.map((envVar) => (
          <EnvVarRow
            key={envVar.id}
            envVar={envVar}
            onSave={(data) =>
              updateEnvVar.mutate(
                { id: envVar.id, data },
                {
                  onError: (error) => {
                    addToast({
                      message: errorMessage(
                        error,
                        'Failed to save environment variable',
                      ),
                      type: 'error',
                    });
                  },
                },
              )
            }
            onDelete={() => deleteEnvVar.mutate(envVar.id)}
          />
        ))}

        {envVars.length === 0 && (
          <p className="text-ink-3 text-sm">
            No environment variables yet.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="w-56 shrink-0">
          <Input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="API_KEY"
            className="font-mono"
          />
        </div>
        <div className="min-w-0 flex-1">
          <Input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="value"
            type={newIsSecret ? 'password' : 'text'}
            className="font-mono"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
          />
        </div>
        {secretStorageAvailable && (
          <label className="text-ink-3 flex items-center gap-2 text-sm">
            <Switch checked={newIsSecret} onChange={setNewIsSecret} />
            Secret
          </label>
        )}
        <Button
          onClick={handleAdd}
          disabled={!newKey.trim() || createEnvVar.isPending}
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>
    </div>
  );
}

function EnvVarRow({
  envVar,
  onSave,
  onDelete,
}: {
  envVar: ProjectEnvVar;
  onSave: (data: { key?: string; value?: string }) => void;
  onDelete: () => void;
}) {
  const [key, setKey] = useState(envVar.key);
  // Secrets start blank: an empty field means "keep the stored value".
  const [value, setValue] = useState(envVar.value ?? '');
  const [secretDirty, setSecretDirty] = useState(false);

  const commit = useCallback(() => {
    const nextKey = key.trim();
    const keyChanged = nextKey !== envVar.key;
    const valueChanged = envVar.isSecret
      ? secretDirty && value.length > 0
      : value !== (envVar.value ?? '');

    if (!keyChanged && !valueChanged) return;

    onSave({
      ...(keyChanged ? { key: nextKey } : {}),
      ...(valueChanged ? { value } : {}),
    });

    if (envVar.isSecret) {
      setValue('');
      setSecretDirty(false);
    }
  }, [envVar, key, onSave, secretDirty, value]);

  return (
    <div className="flex items-center gap-2">
      <div className="w-56 shrink-0">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onBlur={commit}
          className="font-mono"
        />
      </div>
      <div className="relative min-w-0 flex-1">
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (envVar.isSecret) setSecretDirty(true);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          type={envVar.isSecret ? 'password' : 'text'}
          placeholder={
            envVar.decryptionFailed
              ? 'Cannot be decrypted — type a new value'
              : envVar.isSecret
                ? '•••••••• (saved — type to replace)'
                : 'value'
          }
          className={
            envVar.decryptionFailed
              ? 'w-full border-amber-500/50 font-mono'
              : 'w-full font-mono'
          }
        />
      </div>
      {envVar.decryptionFailed ? (
        <AlertTriangle
          className="size-4 shrink-0 text-amber-500"
          aria-label="This secret can no longer be decrypted"
        />
      ) : (
        envVar.isSecret && (
          <KeyRound
            className="text-ink-3 size-4 shrink-0"
            aria-label="Stored as a secret"
          />
        )
      )}
      <Button variant="ghost" onClick={onDelete} aria-label="Remove variable">
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
