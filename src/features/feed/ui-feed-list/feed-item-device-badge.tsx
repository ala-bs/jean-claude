import { Smartphone } from 'lucide-react';

import { PLATFORM_LABELS } from '@shared/mobile-simulator-types';
import { useMobileDevPaneStore } from '@/stores/mobile-dev-pane';

/**
 * Shows which mobile device a task's Mobile Dev pane is targeting.
 *
 * Reads the persisted selection rather than the live device list: the feed
 * renders every task, and one `listDevices` query per row would be far more
 * expensive than the indicator is worth. The selection is what the pane itself
 * restores on open, so it is the honest answer to "which device is this task
 * using".
 */
export function FeedItemDeviceBadge({
  taskId,
}: {
  taskId: string | undefined;
}) {
  // Indexing inside the selector keeps the subscription narrow: the row only
  // re-renders when its own task's device changes, and the returned object
  // identity is stable across unrelated store updates.
  const device = useMobileDevPaneStore((state) =>
    taskId ? (state.deviceByTaskId[taskId] ?? null) : null,
  );

  // The store's persisted-payload guard accepts an empty `deviceName`, which
  // would render as a bare bordered box with no text to explain it.
  if (!device?.deviceName) return null;

  const platformLabel = PLATFORM_LABELS[device.platform];

  return (
    <span
      // `title` rather than the Tooltip component: Tooltip wraps its child in
      // an unstyled `inline-flex` span, which would become the flex item here
      // and strand the sizing classes below one level too deep. Native `title`
      // also matches how every other affordance in this card explains itself.
      title={`Mobile Dev · ${platformLabel} · ${device.deviceName}`}
      aria-label={`Mobile device: ${device.deviceName} (${platformLabel})`}
      // The cap is a percentage, not a rem value: the row title is `flex-1`
      // (basis 0), so its scaled shrink factor is 0 and it absorbs none of the
      // shrink. Left uncapped the badge claims its full max-content width, so
      // in a 256px sidebar the title is squeezed to a few characters (subtask
      // rows) or the attention pill is pushed onto a second line (the parent
      // row, which wraps). `min-w-0` plus `overflow-hidden` is what lets the
      // badge shrink and keeps the icon inside the border when it does.
      className="border-glass-border text-ink-3 mt-px flex max-w-[40%] min-w-0 items-center gap-1 overflow-hidden rounded border px-1 py-0.5 text-[10px] leading-none font-medium"
    >
      <Smartphone className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{device.deviceName}</span>
    </span>
  );
}
