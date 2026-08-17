import { Check, File, Folder, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import { ContextMenu } from './context-menu';
import type { ContextMenuItem } from './context-menu';
import type { DiffFile } from './types';
import type { DiffTabGroup } from '@/stores/diff-review';
import { getStatusIndicator } from './status-badge';
import { selectionAfterClick } from './utils-selection';

type DropSide = 'before' | 'after';

function fileName(path: string) {
  return path.split('/').pop() || path;
}

/** Reorder `paths` inside `list` around `targetPath`. */
export function reorderPaths(
  list: string[],
  paths: string[],
  targetPath: string,
  side: DropSide,
) {
  const moving = paths.filter((path) => list.includes(path));
  if (moving.length === 0 || moving.includes(targetPath)) return list;
  const rest = list.filter((path) => !moving.includes(path));
  const at = rest.indexOf(targetPath);
  if (at < 0) return list;
  const position = side === 'after' ? at + 1 : at;
  return [...rest.slice(0, position), ...moving, ...rest.slice(position)];
}


/**
 * Open-file tabs above the diff. Supports ⇧/⌘ multi-select, drag reorder and
 * user-made groups (nothing is grouped automatically).
 */
export function DiffTabStrip({
  tabs,
  files,
  activePath,
  reviewedPaths,
  stalePaths,
  groups,
  selection,
  onSelect,
  onClose,
  onSetTabs,
  onSetGroups,
  onSetSelection,
  onToggleReviewed,
}: {
  tabs: string[];
  files: DiffFile[];
  activePath: string | null;
  reviewedPaths: Set<string>;
  stalePaths?: Set<string>;
  groups: DiffTabGroup[];
  selection: string[];
  onSelect: (path: string) => void;
  onClose: (paths: string[]) => void;
  onSetTabs: (paths: string[]) => void;
  onSetGroups: (groups: DiffTabGroup[]) => void;
  onSetSelection: (paths: string[]) => void;
  onToggleReviewed?: (paths: string[], reviewed: boolean) => void;
}) {
  const byPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const openTabs = useMemo(
    () => tabs.filter((path) => byPath.has(path)),
    [tabs, byPath],
  );
  const anchorRef = useRef<string | null>(null);
  const dragRef = useRef<string[]>([]);
  const [drop, setDrop] = useState<{ path: string; side: DropSide } | null>(
    null,
  );
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<
    { kind: 'tab' | 'group'; id: string; x: number; y: number } | null
  >(null);

  useEffect(() => {
    const clear = () => setDrop(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  if (openTabs.length === 0) return null;

  const movingPaths = (path: string) =>
    selection.includes(path) && selection.length > 1 ? selection : [path];

  const handleSelect = (path: string, event: React.MouseEvent, rowPaths: string[]) => {
    const next = selectionAfterClick({
      rowPaths,
      path,
      // Fall back to the open file so ⇧-click works before any plain click.
      anchor: anchorRef.current ?? activePath,
      selection,
      shiftKey: event.shiftKey,
      toggleKey: event.metaKey || event.ctrlKey,
    });
    anchorRef.current = next.anchor;
    onSetSelection(next.selection);
    if (next.activate) onSelect(path);
  };

  const handleReorder = (targetPath: string, side: DropSide) => {
    const paths = dragRef.current;
    if (paths.length === 0) return;
    onSetTabs(reorderPaths(openTabs, paths, targetPath, side));
    onSetGroups(
      groups.map((group) =>
        group.paths.includes(targetPath)
          ? { ...group, paths: reorderPaths(group.paths, paths, targetPath, side) }
          : group,
      ),
    );
  };

  const moveToGroup = (groupId: string | null, path: string) => {
    const paths = movingPaths(path);
    const next = groups
      .map((group) => ({
        ...group,
        paths:
          group.id === groupId
            ? [...group.paths.filter((item) => !paths.includes(item)), ...paths]
            : group.paths.filter((item) => !paths.includes(item)),
      }))
      .filter((group) => group.paths.length > 0);
    onSetGroups(next);
    if (groupId) setActiveGroupId(groupId);
  };

  const createGroup = (path?: string) => {
    const paths = path
      ? movingPaths(path)
      : selection.length > 0
        ? selection
        : activePath
          ? [activePath]
          : [];
    if (paths.length === 0) return;
    const kept = groups
      .map((group) => ({
        ...group,
        paths: group.paths.filter((item) => !paths.includes(item)),
      }))
      .filter((group) => group.paths.length > 0);
    // Number past existing labels so ungrouping never produces a duplicate.
    let index = kept.length + 1;
    const taken = new Set(kept.map((group) => group.label));
    while (taken.has(`Group ${index}`)) index++;
    const id = `g-${index}-${paths[0]}`;
    onSetGroups([...kept, { id, label: `Group ${index}`, paths }]);
    setActiveGroupId(id);
    setRenamingId(id);
  };

  const tabProps = (path: string, rowPaths: string[]) => ({
    file: byPath.get(path) as DiffFile,
    isActive: path === activePath,
    isSelected: selection.includes(path) && selection.length > 1,
    isReviewed: reviewedPaths.has(path),
    isStale: stalePaths?.has(path) ?? false,
    dropSide: drop?.path === path ? drop.side : null,
    onSelect: (event: React.MouseEvent) => handleSelect(path, event, rowPaths),
    onClose: () => onClose(movingPaths(path)),
    onDragStart: () => {
      dragRef.current = movingPaths(path);
    },
    onDragOver: (side: DropSide) =>
      setDrop((previous) =>
        previous?.path === path && previous.side === side
          ? previous
          : { path, side },
      ),
    onDrop: (side: DropSide) => {
      setDrop(null);
      handleReorder(path, side);
    },
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      if (!selection.includes(path)) onSetSelection([path]);
      setMenu({ kind: 'tab', id: path, x: event.clientX, y: event.clientY });
    },
  });


  const tabMenuItems = (path: string): ContextMenuItem[] => {
    const paths = movingPaths(path);
    const count = paths.length;
    const currentGroup = groups.find((group) => group.paths.includes(path));
    const isReviewed = reviewedPaths.has(path) && !stalePaths?.has(path);
    return [
      {
        label: count > 1 ? `New group from ${count} tabs` : 'New group from this tab',
        onSelect: () => createGroup(path),
      },
      ...groups
        .filter((group) => group.id !== currentGroup?.id)
        .map((group) => ({
          label: `Move to ${group.label}`,
          onSelect: () => moveToGroup(group.id, path),
        })),
      ...(currentGroup
        ? [
            {
              label: `Remove from ${currentGroup.label}`,
              onSelect: () => moveToGroup(null, path),
            },
          ]
        : []),
      { separator: true as const },
      ...(onToggleReviewed
        ? [
            {
              label: isReviewed
                ? count > 1
                  ? `Mark ${count} tabs not reviewed`
                  : 'Mark not reviewed'
                : count > 1
                  ? `Mark ${count} tabs reviewed`
                  : 'Mark reviewed',
              onSelect: () => onToggleReviewed(paths, !isReviewed),
            },
            { separator: true as const },
          ]
        : []),
      {
        label: count > 1 ? `Close ${count} tabs` : 'Close tab',
        hint: 'mid-click',
        danger: true,
        onSelect: () => onClose(paths),
      },
      {
        label: 'Close other tabs',
        disabled: openTabs.length <= count,
        danger: true,
        onSelect: () =>
          onClose(openTabs.filter((item) => !paths.includes(item))),
      },
    ];
  };

  const groupMenuItems = (groupId: string): ContextMenuItem[] => {
    const group = groups.find((item) => item.id === groupId);
    if (!group) return [];
    return [
      { label: 'Rename group', onSelect: () => setRenamingId(groupId) },
      {
        label: 'Ungroup tabs',
        onSelect: () =>
          onSetGroups(groups.filter((item) => item.id !== groupId)),
      },
      ...(onToggleReviewed
        ? [
            {
              label: `Mark ${group.paths.length} tab${group.paths.length > 1 ? 's' : ''} reviewed`,
              onSelect: () => onToggleReviewed(group.paths, true),
            },
          ]
        : []),
      { separator: true as const },
      {
        label: `Close ${group.paths.length} tab${group.paths.length > 1 ? 's' : ''}`,
        danger: true,
        onSelect: () => {
          onClose(group.paths);
          onSetGroups(groups.filter((item) => item.id !== groupId));
        },
      },
    ];
  };

  const contextMenu = menu && (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={menu.kind === 'tab' ? tabMenuItems(menu.id) : groupMenuItems(menu.id)}
      onClose={() => setMenu(null)}
    />
  );

  const groupedPaths = new Set(groups.flatMap((group) => group.paths));
  const loose = openTabs.filter((path) => !groupedPaths.has(path));

  if (groups.length === 0) {
    return (
      <div className="border-glass-border bg-bg-1 flex shrink-0 items-center gap-1 overflow-x-auto border-b px-1.5 py-1">
        {openTabs.map((path) => (
          <DiffTab key={path} {...tabProps(path, openTabs)} />
        ))}
        <NewGroupButton onCreate={createGroup} />
        {contextMenu}
      </div>
    );
  }

  const chips = [
    ...groups.map((group) => ({
      id: group.id,
      label: group.label,
      paths: group.paths.filter((path) => byPath.has(path)),
      isReal: true,
    })),
    ...(loose.length > 0
      ? [{ id: 'loose', label: 'Ungrouped', paths: loose, isReal: false }]
      : []),
  ];
  const current =
    chips.find((chip) => chip.id === activeGroupId) ??
    chips.find((chip) => activePath && chip.paths.includes(activePath)) ??
    chips[0];

  return (
    <div className="border-glass-border bg-bg-1 shrink-0 border-b">
      <div className="flex items-center gap-1 overflow-x-auto px-1.5 pt-1">
        {chips.map((chip) => {
          const isCurrent = chip.id === current?.id;
          const isDone =
            chip.paths.length > 0 &&
            chip.paths.every(
              (path) => reviewedPaths.has(path) && !stalePaths?.has(path),
            );
          const Icon = chip.isReal ? Folder : File;
          return (
            <div
              key={chip.id}
              onClick={() => setActiveGroupId(chip.id)}
              onDoubleClick={() => chip.isReal && setRenamingId(chip.id)}
              onContextMenu={(event) => {
                if (!chip.isReal) return;
                event.preventDefault();
                setActiveGroupId(chip.id);
                setMenu({
                  kind: 'group',
                  id: chip.id,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                setDrop(null);
                const path = event.dataTransfer.getData('text/plain');
                if (path) moveToGroup(chip.isReal ? chip.id : null, path);
              }}
              title={
                chip.isReal
                  ? 'Drag tabs here · double-click to rename'
                  : 'Tabs not in a group'
              }
              className={clsx(
                'flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t border border-b-0 px-2 text-[11px]',
                isCurrent
                  ? 'bg-glass-medium border-glass-border text-ink-1'
                  : 'text-ink-3 border-transparent',
              )}
            >
              <Icon
                className={clsx(
                  'h-2.5 w-2.5',
                  isDone ? 'text-status-done' : 'text-ink-4',
                )}
              />
              {renamingId === chip.id ? (
                <input
                  autoFocus
                  defaultValue={chip.label}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={(event) => {
                    onSetGroups(
                      groups.map((group) =>
                        group.id === chip.id
                          ? { ...group, label: event.target.value.trim() || group.label }
                          : group,
                      ),
                    );
                    setRenamingId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') {
                      event.currentTarget.blur();
                    }
                  }}
                  className="bg-bg-0 border-acc/40 text-ink-0 h-4 w-[110px] rounded border px-1 text-[11px]"
                />
              ) : (
                chip.label
              )}
              <span className="text-ink-4 font-mono text-[9.5px]">
                {chip.paths.length}
              </span>
              {chip.isReal && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onSetGroups(groups.filter((group) => group.id !== chip.id));
                  }}
                  title="Ungroup tabs"
                  className="text-ink-4 hover:text-ink-1"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          );
        })}
        <NewGroupButton onCreate={createGroup} />
      </div>
      <div
        className="border-glass-border bg-glass-medium/40 flex items-center gap-1 overflow-x-auto border-t px-1.5 py-1"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setDrop(null);
          const path = event.dataTransfer.getData('text/plain');
          if (path && current) moveToGroup(current.isReal ? current.id : null, path);
        }}
      >
        {current?.paths.map((path) => (
          <DiffTab key={path} {...tabProps(path, current.paths)} />
        ))}
      </div>
      {contextMenu}
    </div>
  );
}

function DiffTab({
  file,
  isActive,
  isSelected,
  isReviewed,
  isStale,
  dropSide,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDrop,
  onContextMenu,
}: {
  file: DiffFile;
  isActive: boolean;
  isSelected: boolean;
  isReviewed: boolean;
  isStale: boolean;
  dropSide: DropSide | null;
  onSelect: (event: React.MouseEvent) => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragOver: (side: DropSide) => void;
  onDrop: (side: DropSide) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const indicator = getStatusIndicator(file.status);
  const sideOf = (event: React.DragEvent): DropSide => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  };

  return (
    <div
      draggable
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', file.path);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragOver(sideOf(event));
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDrop(sideOf(event));
      }}
      title={`${file.path} — drag to reorder · ⇧/⌘-click to multi-select · right-click for actions`}
      className={clsx(
        'group relative flex h-7 max-w-[210px] shrink-0 cursor-pointer items-center gap-1.5 rounded border px-2 text-[11.5px] select-none',
        isActive
          ? 'bg-glass-medium border-glass-border text-ink-0 shadow-[inset_0_-2px_0_var(--color-acc)]'
          : isSelected
            ? 'bg-acc-soft border-acc/30 text-ink-1'
            : 'text-ink-2 hover:bg-glass-medium/50 border-transparent',
      )}
    >
      {dropSide && (
        <span
          className="bg-acc absolute top-0 bottom-0 w-0.5 rounded"
          style={dropSide === 'before' ? { left: -2 } : { right: -2 }}
        />
      )}
      <span className={clsx('font-mono text-[10px] font-semibold', indicator.color)}>
        {indicator.label}
      </span>
      <span className="min-w-0 truncate">{fileName(file.path)}</span>
      {isStale ? (
        <RotateCcw
          className="h-2.5 w-2.5 shrink-0 text-amber-400"
          strokeWidth={3}
          aria-label="Changed since reviewed"
        />
      ) : (
        isReviewed && (
          <Check className="text-status-done h-2.5 w-2.5 shrink-0" strokeWidth={3} />
        )
      )}
      <button
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        title="Close tab"
        className="text-ink-3 hover:bg-bg-3 hover:text-ink-0 ml-0.5 hidden h-3.5 w-3.5 shrink-0 items-center justify-center rounded group-hover:flex"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

function NewGroupButton({ onCreate }: { onCreate: (path?: string) => void }) {
  const [isOver, setIsOver] = useState(false);
  return (
    <button
      onClick={() => onCreate()}
      onDragOver={(event) => {
        event.preventDefault();
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsOver(false);
        const path = event.dataTransfer.getData('text/plain');
        if (path) onCreate(path);
      }}
      title="New group from the selected tab(s) — or drop tabs here"
      className={clsx(
        'h-[22px] shrink-0 rounded border border-dashed px-2 text-[11px] transition-colors',
        isOver
          ? 'bg-acc-soft border-acc text-acc-ink'
          : 'border-glass-border text-ink-4 hover:text-ink-2',
      )}
    >
      ＋ group
    </button>
  );
}
