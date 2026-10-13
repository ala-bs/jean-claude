import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import FocusLock from 'react-focus-lock';
import { Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';



import { api } from '@/lib/api';
import type { BindingKey } from '@/common/context/keyboard-bindings/types';
import { Kbd } from '@/common/ui/kbd';
import type { Project } from '@shared/types';
import { useActiveProjects } from '@/hooks/use-projects';
import { useCommands } from '@/common/hooks/use-commands';
import { useKeyboardLayer } from '@/common/context/keyboard-bindings';


const PROJECT_OVERLAY_GRID_COLUMNS = 3;

const PROJECT_OVERLAY_LG_GRID_CLASS: Record<number, string> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
};

// Uniform cover-art slot: real uploaded logo when there is one, otherwise a
// color-tinted gradient tile with the project's initials — every slot is the
// same size so the grid reads as one consistent system.
function ProjectArt({
  project,
  size = 36,
}: {
  project: Pick<Project, 'name' | 'color' | 'logoPath'>;
  size?: number;
}) {
  const { data: logoUrl } = useQuery({
    queryKey: ['project-logo', project.logoPath],
    queryFn: () => api.fs.getImageUrl(project.logoPath ?? ''),
    enabled: !!project.logoPath,
    staleTime: Infinity,
  });

  const radius = Math.round(size / 4.5);

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        className="shrink-0 object-cover"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          boxShadow: 'inset 0 0 0 1px var(--color-glass-border)',
        }}
      />
    );
  }

  const initial = project.name
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 2)
    .toLowerCase();

  return (
    <div
      aria-hidden="true"
      className="grid shrink-0 place-items-center"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(150deg, color-mix(in oklch, ${project.color} 34%, var(--color-bg-2)), color-mix(in oklch, ${project.color} 10%, var(--color-bg-1)))`,
        boxShadow: 'inset 0 0 0 1px var(--color-glass-border)',
      }}
    >
      <span
        className="font-mono font-semibold"
        style={{
          fontSize: Math.max(10, Math.round(size * 0.34)),
          letterSpacing: '-0.02em',
          color: `color-mix(in oklch, ${project.color} 80%, white)`,
        }}
      >
        {initial}
      </span>
    </div>
  );
}

// Truncates from the front (keeping the meaningful trailing segments visible)
// instead of the end, via the classic rtl-direction + bdi trick.
function ProjectPath({ path }: { path: string }) {
  const display = path.replace(/^\/Users\/[^/]+\//, '~/');
  return (
    <span
      className="text-ink-2 block font-mono text-[11px]"
      style={{
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        direction: 'rtl',
        textAlign: 'left',
      }}
    >
      <bdi dir="ltr">{display}</bdi>
    </span>
  );
}

function Hint({ shortcuts, label }: { shortcuts: BindingKey[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5">
        {shortcuts.map((shortcut) => (
          <Kbd key={shortcut} shortcut={shortcut} />
        ))}
      </span>
      {label}
    </span>
  );
}

export function ProjectOverlay({ onClose }: { onClose: () => void }) {
  const layer = useKeyboardLayer('overlay', {
    exclusive: true,
    passthrough: ['global-nav'],
  });

  const { data: projects = [] } = useActiveProjects();
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.sortOrder - b.sortOrder),
    [projects],
  );

  // Selecting a project navigates to its details view, so "current project" is
  // the project-details route rather than the feed filter.
  const projectId = useMemo(() => {
    const match = pathname.match(/^\/all\/projects\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }, [pathname]);

  const options = useMemo(
    () => sortedProjects.map((project) => project.id),
    [sortedProjects],
  );

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option === projectId),
    [options, projectId],
  );

  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  // Keyboard nav can scroll a different tile under a stationary cursor,
  // which fires a synthetic `mouseenter` with no real pointer movement —
  // that would immediately fight the arrow key that just ran. Hover only
  // drives the highlight again once the pointer genuinely moves.
  const pointerActiveRef = useRef(true);

  useEffect(() => {
    if (selectedIndex >= 0) {
      startTransition(() => setHighlightedIndex(selectedIndex));
    }
  }, [selectedIndex]);

  useEffect(() => {
    if (highlightedIndex >= options.length) {
      startTransition(() => setHighlightedIndex(Math.max(0, options.length - 1)));
    }
  }, [highlightedIndex, options.length, selectedIndex]);

  // Keep the keyboard-highlighted tile in view as arrow keys move it —
  // mouse hover already scrolls the item under the cursor into place by
  // virtue of being visible, but keyboard nav can move the highlight
  // off-screen in either direction.
  useEffect(() => {
    const highlighted = gridRef.current?.querySelector<HTMLButtonElement>(
      'button[data-selected="true"]',
    );

    highlighted?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'auto',
    });
  }, [highlightedIndex, options.length]);

  const moveHighlight = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      if (options.length === 0) {
        return;
      }

      pointerActiveRef.current = false;

      setHighlightedIndex((current) => {
        const safeCurrent =
          current >= 0 && current < options.length ? current : 0;

        const rowStart =
          Math.floor(safeCurrent / PROJECT_OVERLAY_GRID_COLUMNS) *
          PROJECT_OVERLAY_GRID_COLUMNS;
        const rowEnd = Math.min(
          rowStart + PROJECT_OVERLAY_GRID_COLUMNS - 1,
          options.length - 1,
        );

        if (direction === 'left') {
          return Math.max(rowStart, safeCurrent - 1);
        }

        if (direction === 'right') {
          return Math.min(rowEnd, safeCurrent + 1);
        }

        if (direction === 'up') {
          const nextIndex = safeCurrent - PROJECT_OVERLAY_GRID_COLUMNS;
          return nextIndex >= 0 ? nextIndex : safeCurrent;
        }

        const nextIndex = safeCurrent + PROJECT_OVERLAY_GRID_COLUMNS;
        return nextIndex < options.length ? nextIndex : safeCurrent;
      });
    },
    [options.length],
  );

  const selectIndex = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option) {
        return;
      }

      // Picking a project opens its details view; the feed filter is left
      // untouched so the list keeps showing everything.
      navigate({
        to: '/all/projects/$projectId',
        params: { projectId: option },
      });

      onClose();
    },
    [navigate, onClose, options],
  );

  useCommands(
    'project-overlay',
    [
      {
        label: 'Close Project Overlay',
        shortcut: 'escape',
        handler: () => {
          onClose();
        },
        hideInCommandPalette: true,
      },
      {
        label: 'Navigate Project Options Up',
        shortcut: 'up',
        handler: () => {
          moveHighlight('up');
        },
        hideInCommandPalette: true,
      },
      {
        label: 'Navigate Project Options Down',
        shortcut: 'down',
        handler: () => {
          moveHighlight('down');
        },
        hideInCommandPalette: true,
      },
      {
        label: 'Navigate Project Options Left',
        shortcut: 'left',
        handler: () => {
          moveHighlight('left');
        },
        hideInCommandPalette: true,
      },
      {
        label: 'Navigate Project Options Right',
        shortcut: 'right',
        handler: () => {
          moveHighlight('right');
        },
        hideInCommandPalette: true,
      },
      {
        label: 'Select Highlighted Project Option',
        shortcut: 'enter',
        handler: () => {
          selectIndex(highlightedIndex);
        },
        hideInCommandPalette: true,
      },
    ],
    { layer },
  );

  return createPortal(
    <FocusLock returnFocus>
      <div
        className="bg-bg-0/50 fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
        onClick={onClose}
      >
        <div
          className="border-glass-border bg-bg-0 flex max-h-[72svh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-line-soft flex items-center justify-between gap-4 border-b px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-ink-0 text-[15px] font-semibold tracking-tight">
                Switch Project
              </h2>
              <p className="text-ink-2 mt-0.5 text-xs">
                Open a project to see its git status, branches and history.
              </p>
            </div>
            <Link
              to="/projects/new"
              onClick={onClose}
              className="border-glass-border text-ink-1 hover:border-glass-border-strong hover:bg-glass-light hover:text-ink-0 inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
            >
              <Plus size={12} />
              <span>New Project</span>
            </Link>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            ref={gridRef}
            onMouseMove={() => {
              pointerActiveRef.current = true;
            }}
          >
            <div
              className={clsx(
                'grid gap-1.5 px-5 pt-3.5 pb-4 sm:grid-cols-2',
                PROJECT_OVERLAY_LG_GRID_CLASS[PROJECT_OVERLAY_GRID_COLUMNS] ??
                  'lg:grid-cols-3',
              )}
            >
              {sortedProjects.map((project, index) => {
                const isSelected = projectId === project.id;
                const isHighlighted = highlightedIndex === index;

                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => selectIndex(index)}
                    onMouseEnter={() => {
                      if (pointerActiveRef.current) {
                        setHighlightedIndex(index);
                      }
                    }}
                    data-selected={isHighlighted}
                    className={clsx(
                      'flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors',
                      isHighlighted
                        ? 'border-acc-line bg-acc-soft'
                        : isSelected
                          ? 'bg-glass-medium'
                          : 'hover:bg-glass-subtle',
                    )}
                    style={
                      isSelected
                        ? { boxShadow: `inset 3px 0 0 0 ${project.color}` }
                        : undefined
                    }
                  >
                    <ProjectArt project={project} size={36} />
                    <div className="min-w-0 flex-1">
                      <p
                        className={clsx(
                          'truncate text-[13px]',
                          isSelected
                            ? 'text-ink-0 font-medium'
                            : 'text-ink-1 font-normal',
                        )}
                      >
                        {project.name}
                      </p>
                      <ProjectPath path={project.path} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-line-soft text-ink-2 flex items-center gap-4 border-t px-5 py-2.5 text-[11.5px]">
            <Hint shortcuts={['up', 'down']} label="navigate" />
            <Hint shortcuts={['enter']} label="open" />
            <Hint shortcuts={['escape']} label="close" />
            <span className="ml-auto">
              {sortedProjects.length}{' '}
              {sortedProjects.length === 1 ? 'project' : 'projects'}
            </span>
          </div>
        </div>
      </div>
    </FocusLock>,
    document.body,
  );
}
