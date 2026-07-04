import {
  ArrowRight,
  BookOpen,
  Check,
  Compass,
  Sparkles,
  X,
} from 'lucide-react';
import {
  type GuideCard,
  guideCards,
  isOverlayTarget,
} from '@/lib/onboarding-guides';
import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';

import { Button } from '@/common/ui/button';
import { Modal } from '@/common/ui/modal';
import { useChangelogStore } from '@/stores/changelog';
import { useOnboardingStore } from '@/stores/onboarding';
import { useOverlaysStore } from '@/stores/overlays';

type GuideFilter = 'all' | GuideCard['featureTag'];

const filterLabels: Record<GuideFilter, string> = {
  all: 'All',
  start: 'Start',
  tasks: 'Tasks',
  review: 'Review',
  settings: 'Settings',
  power: 'Power',
  updates: 'Updates',
};

const tagClass: Record<GuideCard['featureTag'], string> = {
  start: 'text-blue-200 bg-blue-400/10 border-blue-300/20',
  tasks: 'text-emerald-200 bg-emerald-400/10 border-emerald-300/20',
  review: 'text-amber-200 bg-amber-400/10 border-amber-300/20',
  settings: 'text-slate-200 bg-slate-400/10 border-slate-300/20',
  power: 'text-fuchsia-200 bg-fuchsia-400/10 border-fuchsia-300/20',
  updates: 'text-cyan-200 bg-cyan-400/10 border-cyan-300/20',
};

function WelcomePanel({
  onStart,
  onSkip,
}: {
  onStart: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-[#17161d] p-5">
      <div className="pointer-events-none absolute -top-16 right-[-10%] h-44 w-44 rounded-full bg-blue-400/10 blur-3xl" />
      <div className="relative max-w-2xl space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-blue-100">
          <Compass className="h-3.5 w-3.5" />
          Start here
        </div>
        <div className="space-y-2">
          <h2 className="text-ink-0 text-2xl font-semibold tracking-[-0.02em]">
            Get to first useful agent run.
          </h2>
          <p className="text-ink-2 max-w-xl text-sm leading-6">
            Jean-Claude is broad. This guide stays short: set up one project,
            run one task, then learn review and power features only when useful.
          </p>
        </div>
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          {['Add project', 'Pick agent', 'Run task'].map((label, index) => (
            <div
              key={label}
              className="border-glass-border bg-glass-light rounded-lg border p-3"
            >
              <div className="text-ink-4 mb-2 font-mono text-[10px]">
                0{index + 1}
              </div>
              <div className="text-ink-1 font-medium">{label}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="accent" onClick={onStart} icon={<ArrowRight />}>
            Start setup
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      </div>
    </div>
  );
}

function GuideCardView({ card }: { card: GuideCard }) {
  const navigate = useNavigate();
  const openOverlay = useOverlaysStore((s) => s.open);
  const closeLearning = useOverlaysStore((s) => s.close);
  const openChangelog = useChangelogStore((s) => s.open);
  const dismissGuide = useOnboardingStore((s) => s.dismissGuide);

  const handleAction = () => {
    if (!card.action) return;
    closeLearning('learning-center');
    if (card.action.type === 'route') {
      if (card.action.target === '/projects/new') {
        void navigate({ to: '/projects/new' });
      }
      if (card.action.target === '/onboarding/setup') {
        void navigate({ to: '/onboarding/setup' });
      }
      return;
    }
    if (card.action.target === 'changelog') {
      openChangelog();
      return;
    }
    if (isOverlayTarget(card.action.target)) {
      openOverlay(card.action.target);
    }
  };

  return (
    <article className="group border-glass-border bg-glass-light hover:bg-glass-medium rounded-xl border p-4 transition-colors">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${tagClass[card.featureTag]}`}
            >
              {filterLabels[card.featureTag]}
            </span>
            <span className="text-ink-4 font-mono text-[10px]">
              v{card.version}
            </span>
          </div>
          <h3 className="text-ink-0 text-sm font-semibold">{card.title}</h3>
        </div>
        <button
          type="button"
          className="text-ink-4 hover:text-ink-1 rounded p-1 opacity-70 transition-colors group-hover:opacity-100"
          aria-label={`Dismiss ${card.title}`}
          onClick={() => dismissGuide(card.id, card.version)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-ink-1 text-sm leading-5">{card.summary}</p>
      <p className="text-ink-3 mt-2 text-xs leading-5">{card.body}</p>
      {card.action && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-3"
          onClick={handleAction}
          icon={<ArrowRight />}
        >
          {card.action.label}
        </Button>
      )}
    </article>
  );
}

export function LearningCenterOverlay({ onClose }: { onClose: () => void }) {
  const hasSeenWelcome = useOnboardingStore((s) => s.hasSeenWelcome);
  const markWelcomeSeen = useOnboardingStore((s) => s.markWelcomeSeen);
  const dismissedGuideIds = useOnboardingStore((s) => s.dismissedGuideIds);
  const [filter, setFilter] = useState<GuideFilter>('all');

  const visibleCards = useMemo(
    () =>
      guideCards.filter(
        (card) =>
          dismissedGuideIds[card.id] !== card.version &&
          (filter === 'all' || card.featureTag === filter),
      ),
    [dismissedGuideIds, filter],
  );

  const handleClose = () => {
    markWelcomeSeen();
    onClose();
  };

  return (
    <Modal
      isOpen
      onClose={handleClose}
      size="xl"
      showHeader={false}
      panelClassName="!max-w-[900px] overflow-hidden border border-white/[0.07] bg-[#1b1a22] shadow-[0_24px_80px_rgba(0,0,0,0.5)]"
      contentClassName="min-h-0 overflow-hidden p-0"
      ariaLabel="Learning Center"
    >
      <div className="flex h-[min(680px,82vh)] flex-col overflow-hidden">
        <header className="border-glass-border flex items-center justify-between gap-3 border-b px-[18px] py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <BookOpen className="text-acc h-4 w-4" />
            <h2 className="text-ink-0 text-[13.5px] font-semibold">
              Learning Center
            </h2>
            <span className="text-ink-4 hidden text-xs sm:inline">
              short guides, no forced tour
            </span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close dialog"
            className="text-ink-2 hover:text-ink-0 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06]"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-[18px]">
          {!hasSeenWelcome && (
            <div className="mb-4">
              <WelcomePanel
                onStart={() => {
                  markWelcomeSeen();
                  setFilter('start');
                }}
                onSkip={markWelcomeSeen}
              />
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1">
              {(Object.keys(filterLabels) as GuideFilter[]).map(
                (nextFilter) => (
                  <button
                    key={nextFilter}
                    type="button"
                    aria-pressed={filter === nextFilter}
                    onClick={() => setFilter(nextFilter)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      filter === nextFilter
                        ? 'text-ink-0 border-white/10 bg-white/[0.055]'
                        : 'text-ink-2 hover:text-ink-1 border-transparent hover:bg-white/[0.035]'
                    }`}
                  >
                    {filterLabels[nextFilter]}
                  </button>
                ),
              )}
            </div>
            <div className="text-ink-4 flex items-center gap-1.5 text-xs">
              <Sparkles className="h-3.5 w-3.5" />
              {visibleCards.length} open guides
            </div>
          </div>

          {visibleCards.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {visibleCards.map((card) => (
                <GuideCardView key={`${card.id}:${card.version}`} card={card} />
              ))}
            </div>
          ) : (
            <div className="border-glass-border bg-glass-light flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
              <Check className="text-acc h-5 w-5" />
              <div className="text-ink-1 text-sm font-medium">
                All caught up
              </div>
              <div className="text-ink-3 max-w-sm text-xs leading-5">
                No open guides for this filter. New cards can appear when
                features change or new workflows land.
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
