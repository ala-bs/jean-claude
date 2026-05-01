import { Star, X } from 'lucide-react';
import { useMemo } from 'react';

import { Select } from '@/common/ui/select';

export function FavoriteBranchesInput({
  branches,
  branchesLoading,
  favoriteBranches,
  onChange,
}: {
  branches: string[];
  branchesLoading: boolean;
  favoriteBranches: string[];
  onChange: (branches: string[]) => void;
}) {
  const availableBranches = useMemo(
    () => branches.filter((b) => !favoriteBranches.includes(b)),
    [branches, favoriteBranches],
  );

  const handleAdd = (branch: string) => {
    if (branch && !favoriteBranches.includes(branch)) {
      onChange([...favoriteBranches, branch]);
    }
  };

  const handleRemove = (branch: string) => {
    onChange(favoriteBranches.filter((b) => b !== branch));
  };

  return (
    <div>
      <label className="text-ink-1 mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Star className="h-4 w-4 text-amber-400" />
        Favorite branches
      </label>
      {favoriteBranches.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {favoriteBranches.map((branch) => (
            <FavoriteBranchBadge
              key={branch}
              branch={branch}
              onRemove={() => handleRemove(branch)}
            />
          ))}
        </div>
      )}
      <Select
        value=""
        options={
          branchesLoading
            ? [{ value: '', label: 'Loading...' }]
            : availableBranches.length === 0
              ? [{ value: '', label: 'No branches available' }]
              : [
                  { value: '', label: 'Add a favorite branch...' },
                  ...availableBranches.map((b) => ({ value: b, label: b })),
                ]
        }
        onChange={(value) => {
          if (value) handleAdd(value);
        }}
        disabled={branchesLoading || availableBranches.length === 0}
        className="w-full justify-between"
      />
      <p className="text-ink-3 mt-1 text-xs">
        Favorite branches appear at the top of branch selectors
      </p>
    </div>
  );
}

export function FavoriteBranchBadge({
  branch,
  onRemove,
}: {
  branch: string;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-400">
      {branch}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="cursor-pointer rounded p-0.5 transition-colors hover:bg-amber-400/20"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
