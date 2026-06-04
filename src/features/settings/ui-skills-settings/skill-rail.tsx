import clsx from 'clsx';
import { Bot, Loader2, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { Chip } from '@/common/ui/chip';
import { ListPane, ListSearchInput } from '@/common/ui/list-detail-layout';
import { useRegistrySearch } from '@/hooks/use-managed-skills';
import { formatCompactNumber } from '@/lib/numbers';
import { useSkillsRailWidth } from '@/stores/navigation';
import type { ManagedSkill, RegistrySkill } from '@shared/skill-types';

import { GroupHeader, SkillRow } from './skill-row';

export type RailMode = 'installed' | 'browse';

export function SkillRail({
  builtinSkills,
  mySkills,
  installedSkills,
  selectedPath,
  onSelect,
  onAdd,
  onCreateWithAgent,
  mode,
  onModeChange,
  selectedRegistrySkillId,
  onSelectRegistrySkill,
  installedNames,
}: {
  builtinSkills: ManagedSkill[];
  mySkills: ManagedSkill[];
  installedSkills: ManagedSkill[];
  selectedPath: string | null;
  onSelect: (skillPath: string) => void;
  onAdd: () => void;
  onCreateWithAgent: () => void;
  mode: RailMode;
  onModeChange: (mode: RailMode) => void;
  selectedRegistrySkillId: string | null;
  onSelectRegistrySkill: (skill: RegistrySkill) => void;
  installedNames: Set<string>;
}) {
  const { width, setWidth, minWidth, maxWidth } = useSkillsRailWidth();
  const onWidthChange = useCallback((w: number) => setWidth(w), [setWidth]);
  const [searchInput, setSearchInput] = useState('');

  return (
    <ListPane
      width={width}
      minWidth={minWidth}
      maxWidth={maxWidth}
      onWidthChange={onWidthChange}
      headerContent={
        <div className="border-glass-border bg-section-strip flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-md border p-1">
          <ModeButton
            label="Installed"
            isActive={mode === 'installed'}
            onClick={() => onModeChange('installed')}
          />
          <ModeButton
            label="Browse"
            icon={<Search size={11} />}
            isActive={mode === 'browse'}
            onClick={() => onModeChange('browse')}
          />
        </div>
      }
      headerActions={
        mode === 'installed' ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onCreateWithAgent}
              className="rounded p-1 transition-colors hover:bg-chrome-hover hover:text-chrome-fg"
              style={{ color: 'var(--color-ink-2)' }}
              title="Create with Agent"
            >
              <Bot size={13} />
            </button>
            <button
              type="button"
              onClick={onAdd}
              className="rounded p-1 transition-colors"
              style={{ color: 'var(--color-acc)' }}
              title="Add skill"
            >
              <Plus size={13} />
            </button>
          </div>
        ) : null
      }
      top={
        mode === 'browse' ? (
          <div className="px-3 pt-1 pb-2">
            <ListSearchInput
              value={searchInput}
              onChange={setSearchInput}
              placeholder="Search skills.sh..."
              ariaLabel="Search skills registry"
              autoFocus
            />
          </div>
        ) : null
      }
    >
      {mode === 'installed' ? (
        <InstalledList
          builtinSkills={builtinSkills}
          mySkills={mySkills}
          installedSkills={installedSkills}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ) : (
        <BrowseList
          selectedRegistrySkillId={selectedRegistrySkillId}
          onSelectRegistrySkill={onSelectRegistrySkill}
          installedNames={installedNames}
          searchInput={searchInput}
        />
      )}
    </ListPane>
  );
}

function ModeButton({
  label,
  icon,
  isActive,
  suffix,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  isActive: boolean;
  suffix?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors',
        isActive
          ? 'bg-glass-medium text-chrome-fg'
          : 'text-chrome-fg-muted hover:bg-chrome-hover hover:text-chrome-fg',
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      {suffix}
    </button>
  );
}

function InstalledList({
  builtinSkills,
  mySkills,
  installedSkills,
  selectedPath,
  onSelect,
}: {
  builtinSkills: ManagedSkill[];
  mySkills: ManagedSkill[];
  installedSkills: ManagedSkill[];
  selectedPath: string | null;
  onSelect: (skillPath: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      {builtinSkills.length > 0 && (
        <div>
          <GroupHeader label={`Builtin (${builtinSkills.length})`} />
          {builtinSkills.map((skill) => (
            <SkillRow
              key={skill.skillPath}
              label={skill.name}
              isActive={selectedPath === skill.skillPath}
              isEnabled={Object.values(skill.enabledBackends).some(Boolean)}
              onClick={() => onSelect(skill.skillPath)}
            />
          ))}
        </div>
      )}

      {mySkills.length > 0 && (
        <div>
          <GroupHeader label={`My Skills (${mySkills.length})`} accent />
          {mySkills.map((skill) => (
            <SkillRow
              key={skill.skillPath}
              label={skill.name}
              isActive={selectedPath === skill.skillPath}
              isEnabled={Object.values(skill.enabledBackends).some(Boolean)}
              onClick={() => onSelect(skill.skillPath)}
            />
          ))}
        </div>
      )}

      {installedSkills.length > 0 && (
        <div>
          <GroupHeader label={`Installed (${installedSkills.length})`} />
          {installedSkills.map((skill) => (
            <SkillRow
              key={skill.skillPath}
              label={skill.name}
              isActive={selectedPath === skill.skillPath}
              isEnabled={Object.values(skill.enabledBackends).some(Boolean)}
              onClick={() => onSelect(skill.skillPath)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const POPULAR_QUERY = 'skill';

function BrowseList({
  selectedRegistrySkillId,
  onSelectRegistrySkill,
  installedNames,
  searchInput,
}: {
  selectedRegistrySkillId: string | null;
  onSelectRegistrySkill: (skill: RegistrySkill) => void;
  installedNames: Set<string>;
  searchInput: string;
}) {
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const activeQuery = debouncedQuery || POPULAR_QUERY;

  const { data: searchResult, isLoading } = useRegistrySearch(activeQuery);

  return (
    <div className="flex-1 overflow-y-auto">
      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-chrome-fg-muted">
          <Loader2 size={14} className="animate-spin" />
          {debouncedQuery ? 'Searching...' : 'Loading popular...'}
        </div>
      )}

      {!isLoading && searchResult && searchResult.skills.length === 0 && (
        <p className="py-8 text-center text-xs text-chrome-fg-muted">
          No skills found.
        </p>
      )}

      {!isLoading && searchResult && searchResult.skills.length > 0 && (
        <div>
          <GroupHeader
            label={debouncedQuery ? `${searchResult.count} results` : 'Popular'}
          />
          {searchResult.skills.map((skill) => {
            const isInstalled = installedNames.has(skill.name);
            return (
              <SkillRow
                key={skill.id}
                label={skill.name}
                isActive={selectedRegistrySkillId === skill.id}
                suffix={
                  isInstalled ? (
                    <Chip size="xs" color="green" className="ml-auto">
                      ✓
                    </Chip>
                  ) : (
                    <span className="ml-auto font-mono text-[10px] text-chrome-fg-muted">
                      {formatCompactNumber(skill.installs)}
                    </span>
                  )
                }
                onClick={() => onSelectRegistrySkill(skill)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
