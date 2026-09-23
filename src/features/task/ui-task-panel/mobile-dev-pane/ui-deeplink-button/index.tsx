import { Link2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/common/ui/button';
import { Dropdown } from '@/common/ui/dropdown';
import { Input } from '@/common/ui/input';
import { useMobileDevDeeplinksStore } from '@/stores/mobile-dev-deeplinks';

/**
 * Tracks whether the dropdown menu is currently mounted. `Dropdown` only
 * exposes a `toggle()` handle (a flip, not a close) and has no `onClose`, so
 * closing it programmatically after an await is only safe if we know it is
 * still open — otherwise the flip re-opens a menu the user already dismissed.
 * The menu's children unmount on close, which makes this a reliable signal.
 */
function MenuOpenTracker({
  openRef,
}: {
  openRef: { current: boolean };
}) {
  useEffect(() => {
    openRef.current = true;
    return () => {
      openRef.current = false;
    };
  }, [openRef]);
  return null;
}

/**
 * "Deeplink" button for the mobile dev pane: opens a dropdown with an input
 * (submit on Enter or via the Open button) plus a global history of recently
 * opened deeplinks.
 */
export function DeeplinkButton({
  disabled,
  disabledReason,
  onOpenDeeplink,
}: {
  disabled: boolean;
  disabledReason?: string;
  /** Resolves once the deeplink was handed to the device; rejects on failure. */
  onOpenDeeplink: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recentUrls = useMobileDevDeeplinksStore((state) => state.recentUrls);
  const recordOpened = useMobileDevDeeplinksStore((state) => state.recordOpened);
  const removeUrl = useMobileDevDeeplinksStore((state) => state.remove);
  const dropdownRef = useRef<{
    toggle: (restoreFocusTo?: HTMLElement | null) => void;
  } | null>(null);
  const isMenuOpenRef = useRef(false);

  const submit = useCallback(
    async (rawUrl: string) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || isOpening) return;
      setIsOpening(true);
      setError(null);
      try {
        await onOpenDeeplink(trimmed);
        // Only record links that actually opened, so the history stays a list
        // of known-good deeplinks rather than a log of typos.
        recordOpened(trimmed);
        setUrl('');
        // `toggle()` flips; only call it while the menu is genuinely open, or a
        // user who dismissed it mid-request gets it re-opened on resolve.
        if (isMenuOpenRef.current) dropdownRef.current?.toggle();
      } catch (openError) {
        setError(
          openError instanceof Error ? openError.message : String(openError),
        );
      } finally {
        setIsOpening(false);
      }
    },
    [isOpening, onOpenDeeplink, recordOpened],
  );

  return (
    <Dropdown
      dropdownRef={dropdownRef}
      align="left"
      // The input is the only thing worth focusing when the menu opens.
      initialFocusIndex={-1}
      // A failure from a previous session would otherwise still be on screen
      // when the menu is reopened, reading as a fresh error.
      onOpen={() => setError(null)}
      className="w-72 p-2"
      trigger={
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          disabled={disabled}
          icon={<Link2 />}
          title={disabledReason ?? 'Open a deeplink on the selected device'}
        >
          Deeplink
        </Button>
      }
    >
      <MenuOpenTracker openRef={isMenuOpenRef} />
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(url);
        }}
      >
        <Input
          autoFocus
          size="sm"
          value={url}
          spellCheck={false}
          autoComplete="off"
          placeholder="myapp://path"
          aria-label="Deeplink URL"
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
          className="flex-1"
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          loading={isOpening}
          disabled={!url.trim() || isOpening}
        >
          Open
        </Button>
      </form>

      {error && (
        <p className="text-status-fail mt-1.5 text-xs break-words">{error}</p>
      )}

      {recentUrls.length > 0 && (
        <div className="mt-2">
          <p className="text-ink-3 px-1 pb-1 text-[11px] font-medium uppercase">
            Recent
          </p>
          <ul className="max-h-48 overflow-y-auto">
            {recentUrls.map((recent) => (
              <li key={recent} className="group flex items-center gap-1">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => void submit(recent)}
                  disabled={isOpening}
                  title={recent}
                  className="text-ink-2 hover:bg-bg-1 focus:bg-bg-1 min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-xs"
                >
                  {recent}
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Remove ${recent} from history`}
                  onClick={() => removeUrl(recent)}
                  className="text-ink-3 hover:text-ink-1 hover:bg-bg-1 shrink-0 rounded p-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dropdown>
  );
}
