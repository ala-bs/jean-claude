import { Download, Folder, GitBranch, Link2, X } from 'lucide-react';
import {
  type GitCloneProtocol,
  parseGitUrl,
  toCloneUrl,
} from '@shared/git-url-utils';
import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { Button } from '@/common/ui/button';
import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';

export interface CloneUrlResult {
  path: string;
  repoName: string;
  remoteUrl: string;
}

/**
 * Reduce a name to something that can only ever be a single directory inside
 * the chosen parent — no separators, no `.`/`..` traversal.
 *
 * Deliberately idempotent: `folderNameIsSafe` compares a name against its own
 * sanitized form, so any transformation that is not a fixed point (trimming
 * surrounding whitespace, say) would reject names the user can never correct.
 * Whitespace is therefore left alone and only genuinely unsafe characters are
 * rewritten.
 */
function sanitizeFolderName(name: string): string {
  return name.replace(/[/\\]/g, '-').replace(/^\.+/, '');
}

const PROTOCOLS: { value: GitCloneProtocol; label: string }[] = [
  { value: 'ssh', label: 'SSH' },
  { value: 'https', label: 'HTTPS' },
];

export function CloneUrlPane({
  onClose,
  onCloneSuccess,
}: {
  onClose: () => void;
  onCloneSuccess: (result: CloneUrlResult) => void;
}) {
  const [url, setUrl] = useState('');
  const [protocol, setProtocol] = useState<GitCloneProtocol>('ssh');
  const [parentPath, setParentPath] = useState('');
  // Holds only a manually-typed folder name. While null, the name is derived
  // from the parsed URL — derivation rather than effect-syncing, so typing in
  // the URL field cannot clobber a name the user has edited.
  const [folderNameOverride, setFolderNameOverride] = useState<string | null>(
    null,
  );
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseGitUrl(url), [url]);
  const showParseError = url.trim().length > 0 && !parsed;

  // An empty override falls back to the derived name rather than latching:
  // `??` would treat a cleared input as an intentional choice and leave Clone
  // disabled forever, even after the user types a new URL.
  // The derived half is sanitized because it comes from the pasted URL, which
  // may be untrusted — a repo path of `..%2F..%2Fevil` decodes to `../../evil`
  // and would otherwise clone outside the folder the user picked.
  const folderName =
    folderNameOverride || sanitizeFolderName(parsed?.repoName ?? '');

  const folderNameIsSafe =
    folderName.length > 0 && folderName === sanitizeFolderName(folderName);

  const targetPath =
    parentPath && folderNameIsSafe ? `${parentPath}/${folderName}` : '';
  const resolvedUrl = parsed ? toCloneUrl(parsed, protocol) : '';
  const canClone = Boolean(parsed && parentPath && targetPath && !isCloning);

  async function handleSelectFolder() {
    const selectedPath = await api.dialog.openDirectory();
    if (selectedPath) setParentPath(selectedPath);
  }

  async function handleClone() {
    if (!parsed || !targetPath) return;

    setIsCloning(true);
    setError(null);

    try {
      const result = await api.git.cloneFromUrl({
        url,
        protocol,
        targetPath,
      });

      if (result.success && result.path) {
        onCloneSuccess({
          path: result.path,
          repoName: parsed.repoName,
          remoteUrl: resolvedUrl,
        });
      } else {
        setError(result.error || 'Clone failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clone failed');
    } finally {
      setIsCloning(false);
    }
  }

  return (
    <div className="border-glass-border bg-bg-1/50 flex h-full w-96 shrink-0 flex-col rounded-lg border">
      {/* Header */}
      <div className="border-glass-border flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="bg-acc/20 text-acc-ink flex h-7 w-7 items-center justify-center rounded-lg">
            <Link2 className="h-3.5 w-3.5" aria-hidden />
          </div>
          <h3 className="text-ink-1 font-medium">Clone from URL</h3>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          onClick={onClose}
          icon={<X />}
          tooltip="Close pane"
        />
      </div>

      {/* Content */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <label
            htmlFor="clone-url"
            className="text-ink-2 mb-1 block text-xs font-medium"
          >
            Repository URL
          </label>
          <Input
            id="clone-url"
            size="md"
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            aria-invalid={showParseError}
            aria-describedby="clone-url-hint"
          />
          <p id="clone-url-hint" className="text-ink-3 mt-1 text-xs">
            {showParseError
              ? 'Not a recognizable git URL.'
              : 'Paste an HTTPS or SSH URL, or just owner/repo.'}
          </p>
        </div>

        <div>
          <span className="text-ink-2 mb-1 block text-xs font-medium">
            Protocol
          </span>
          <div
            role="radiogroup"
            aria-label="Clone protocol"
            className="border-glass-border bg-bg-1/50 flex gap-1 rounded-lg border p-1"
          >
            {PROTOCOLS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={protocol === option.value}
                onClick={() => setProtocol(option.value)}
                className={`flex-1 cursor-pointer rounded px-2 py-1 text-xs font-medium transition-colors ${
                  protocol === option.value
                    ? 'bg-acc/20 text-acc-ink'
                    : 'text-ink-3 hover:bg-glass-medium/50'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {resolvedUrl && (
            <p className="text-ink-3 mt-1 truncate font-mono text-[11px]">
              {resolvedUrl}
            </p>
          )}
        </div>

        <div>
          <span className="text-ink-2 mb-1 block text-xs font-medium">
            Clone to folder
          </span>
          <Button
            variant="secondary"
            size="md"
            onClick={handleSelectFolder}
            icon={<Folder />}
            className="w-full justify-start"
          >
            <span className="text-ink-1 flex-1 truncate text-left">
              {parentPath || 'Select parent folder…'}
            </span>
          </Button>
        </div>

        <div>
          <label
            htmlFor="clone-folder-name"
            className="text-ink-2 mb-1 block text-xs font-medium"
          >
            Folder name
          </label>
          <Input
            id="clone-folder-name"
            size="md"
            value={folderName}
            onChange={(e) => setFolderNameOverride(e.target.value)}
            placeholder="repo-name"
          />
          {targetPath && (
            <p className="text-ink-3 mt-1 flex items-center gap-1 truncate text-[11px]">
              <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate font-mono">{targetPath}</span>
            </p>
          )}
          {folderName.length > 0 && !folderNameIsSafe && (
            <p className="text-status-fail mt-1 text-[11px]">
              Folder name cannot contain slashes or start with a dot.
            </p>
          )}
        </div>

        {error && (
          <div className="bg-status-fail/10 text-status-fail border-status-fail/50 rounded-lg border px-3 py-2 text-xs">
            {error}
          </div>
        )}

        <Button
          variant="primary"
          size="md"
          onClick={handleClone}
          disabled={!canClone}
          loading={isCloning}
          icon={<Download />}
          className="w-full"
        >
          {isCloning ? 'Cloning…' : 'Clone Repository'}
        </Button>
      </div>
    </div>
  );
}
