import { Sparkles, Wrench, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Modal } from '@/common/ui/modal';
import { type ChangelogEntry, changelog, changelogHash } from '@/lib/changelog';
import { useChangelogStore } from '@/stores/changelog';

const DAYS_PER_PAGE = 10;

const typeIcons = {
  feature: Sparkles,
  fix: Wrench,
  improvement: Zap,
} as const;

const typeColors = {
  feature: 'text-blue-400',
  fix: 'text-amber-400',
  improvement: 'text-emerald-400',
} as const;

function EntryIcon({ type }: { type: ChangelogEntry['type'] }) {
  const Icon = typeIcons[type];
  const color = typeColors[type];
  return <Icon className={`h-4 w-4 shrink-0 ${color}`} aria-hidden />;
}

export function ChangelogModal() {
  const lastSeenHash = useChangelogStore((s) => s.lastSeenHash);
  const isOpen = useChangelogStore((s) => s.isOpen);
  const open = useChangelogStore((s) => s.open);
  const close = useChangelogStore((s) => s.close);
  const markSeen = useChangelogStore((s) => s.markSeen);
  const [daysShown, setDaysShown] = useState(DAYS_PER_PAGE);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const dayRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const visibleDays = useMemo(() => changelog.slice(0, daysShown), [daysShown]);
  const hasMore = changelog.length > daysShown;

  // Auto-open on startup if hash changed
  useEffect(() => {
    const hasChanges = lastSeenHash !== changelogHash && changelog.length > 0;
    if (hasChanges) {
      open();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Infinite scroll — load more when sentinel visible
  useEffect(() => {
    if (!isOpen || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setDaysShown((n) => Math.min(n + DAYS_PER_PAGE, changelog.length));
        }
      },
      { root: scrollContainerRef.current, threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isOpen, hasMore, daysShown]);

  // Track which day section is in view for sidebar highlight
  useEffect(() => {
    if (!isOpen) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the topmost intersecting entry
        let topEntry: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            (!topEntry ||
              entry.boundingClientRect.top < topEntry.boundingClientRect.top)
          ) {
            topEntry = entry;
          }
        }
        if (topEntry) {
          const date = topEntry.target.getAttribute('data-date');
          if (date) setActiveDate(date);
        }
      },
      { root: container, threshold: 0.3 },
    );

    for (const el of dayRefs.current.values()) {
      observer.observe(el);
    }

    return () => observer.disconnect();
  }, [isOpen, visibleDays]); // re-register when new days loaded

  const handleClose = () => {
    close();
    markSeen(changelogHash);
    setDaysShown(DAYS_PER_PAGE);
    setActiveDate(null);
  };

  const scrollToDate = useCallback((date: string) => {
    const el = dayRefs.current.get(date);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const setDayRef = useCallback(
    (date: string) => (el: HTMLDivElement | null) => {
      if (el) {
        dayRefs.current.set(date, el);
      } else {
        dayRefs.current.delete(date);
      }
    },
    [],
  );

  if (!isOpen || changelog.length === 0) return null;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Changelog" size="lg">
      <div className="-m-4 flex" style={{ height: '60vh' }}>
        {/* Sidebar — day list */}
        <nav className="border-glass-border flex w-40 shrink-0 flex-col overflow-y-auto border-r py-2">
          {changelog.map((day) => (
            <button
              key={day.date}
              onClick={() => {
                const idx = changelog.indexOf(day);
                // Load enough days if clicking beyond visible range
                if (idx >= daysShown) {
                  setDaysShown(idx + DAYS_PER_PAGE);
                  requestAnimationFrame(() => scrollToDate(day.date));
                } else {
                  scrollToDate(day.date);
                }
              }}
              className={`px-3 py-1.5 text-left text-xs transition-colors ${
                day.date === activeDate
                  ? 'bg-glass-medium text-ink-0 font-medium'
                  : 'text-ink-2 hover:bg-glass-light hover:text-ink-1'
              }`}
            >
              {day.label}
            </button>
          ))}
        </nav>

        {/* Content — scrollable entries */}
        <div
          ref={scrollContainerRef}
          className="min-w-0 flex-1 overflow-y-auto p-4"
        >
          <div className="space-y-6">
            {visibleDays.map((day) => (
              <div
                key={day.date}
                ref={setDayRef(day.date)}
                data-date={day.date}
              >
                <h3 className="text-ink-2 mb-2 text-xs font-medium tracking-wider uppercase">
                  {day.label}
                </h3>
                <ul className="space-y-2">
                  {day.entries.map((entry, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <EntryIcon type={entry.type} />
                      <span className="text-ink-1 text-sm">{entry.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {/* Infinite scroll sentinel */}
            {hasMore && <div ref={sentinelRef} className="h-4" aria-hidden />}
          </div>
        </div>
      </div>
    </Modal>
  );
}
