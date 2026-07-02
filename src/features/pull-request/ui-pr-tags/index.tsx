import { Loader2, Plus, Tag, X } from 'lucide-react';
import type { ChangeEvent, FormEvent } from 'react';
import { useCallback, useState } from 'react';


import { Button } from '@/common/ui/button';
import { Input } from '@/common/ui/input';
import {
  type PullRequestRepoInfo,
  useAddPullRequestTag,
  usePullRequestTags,
  useRemovePullRequestTag,
} from '@/hooks/use-pull-requests';


export function PrTags({
  projectId,
  prId,
  repoInfo,
  isActive,
  readOnly = false,
}: {
  projectId: string;
  prId: number;
  repoInfo?: PullRequestRepoInfo;
  isActive: boolean;
  readOnly?: boolean;
}) {
  const { data: tags = [] } = usePullRequestTags(projectId, prId, repoInfo);
  const addTag = useAddPullRequestTag(projectId, prId, repoInfo);
  const removeTag = useRemovePullRequestTag(projectId, prId, repoInfo);
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [removingTagName, setRemovingTagName] = useState<string | null>(null);
  const canEdit = !readOnly && isActive;

  const handleAddTag = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const nextTag = tagDraft.trim();

      if (!nextTag) {
        setTagError('Tag is required');
        return;
      }

      setTagError(null);
      addTag.mutate(nextTag, {
        onSuccess: () => {
          setTagDraft('');
          setIsAddingTag(false);
        },
        onError: (error) => setTagError(error.message),
      });
    },
    [addTag, tagDraft],
  );

  const handleRemoveTag = useCallback(
    (name: string) => {
      setTagError(null);
      setRemovingTagName(name);
      removeTag.mutate(name, {
        onSettled: () => setRemovingTagName(null),
        onError: (error) => setTagError(error.message),
      });
    },
    [removeTag],
  );

  if (tags.length === 0 && !canEdit) return null;

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-1">
        <h2 className="text-ink-2 flex items-center gap-1 text-sm font-medium">
          <Tag className="h-3.5 w-3.5" />
          Tags
          {tags.length > 0 && (
            <span className="text-ink-3 ml-1 text-xs font-normal">
              ({tags.length})
            </span>
          )}
        </h2>
        {canEdit && !isAddingTag && (
          <button
            type="button"
            onClick={() => setIsAddingTag(true)}
            className="text-ink-3 hover:text-ink-1 ml-auto rounded p-0.5 transition-colors"
            title="Add tag"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-2">
        {tags.map((tag) => (
          <span
            key={tag.id ?? tag.name}
            className="border-acc/25 bg-acc/10 text-acc-ink inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
          >
            {tag.name}
            {canEdit && (
              <button
                type="button"
                onClick={() => handleRemoveTag(tag.name)}
                disabled={removeTag.isPending}
                className="text-acc-ink/70 hover:text-acc-ink -mr-1 rounded-full p-0.5 transition-colors disabled:opacity-40"
                title={`Remove ${tag.name}`}
              >
                {removingTagName === tag.name ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <X className="h-3 w-3" />
                )}
              </button>
            )}
          </span>
        ))}
      </div>

      {tags.length === 0 && !isAddingTag && (
        <p className="text-ink-3 px-2 text-xs italic">No tags</p>
      )}

      {isAddingTag && canEdit && (
        <form onSubmit={handleAddTag} className="mt-2 flex items-center gap-1.5 px-2">
          <Input
            value={tagDraft}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setTagDraft(event.target.value)
            }
            placeholder="Tag"
            className="h-7 min-w-0 flex-1 text-xs"
            disabled={addTag.isPending}
            autoFocus
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={
              addTag.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )
            }
            disabled={addTag.isPending}
          >
            Add
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<X className="h-3.5 w-3.5" />}
            onClick={() => {
              setIsAddingTag(false);
              setTagDraft('');
              setTagError(null);
            }}
            disabled={addTag.isPending}
          >
            Cancel
          </Button>
        </form>
      )}

      {tagError && <p className="mt-2 px-2 text-xs text-red-400">{tagError}</p>}
    </div>
  );
}
