import { ImagePlus, MessageSquare, MessagesSquare, Pencil, Send, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, type WorkItemComment } from '@/lib/api';
import {
  AzureHtmlContent,
  AzureMarkdownContent,
} from '@/features/common/ui-azure-html-content';
import {
  containsAzureDevOpsMention,
  type MentionDisplayNames,
  normalizeMentionId,
} from '@/lib/azure-devops-mentions';
import {
  EMPTY_MENTION_OPTIONS,
  encodeMentionDisplayNames,
  MENTION_TEXTAREA_MD_CLASS,
  type MentionOption,
  MentionTextarea,
} from '@/common/ui/mention-textarea';
import { Button } from '@/common/ui/button';

function formatCommentDate(value: string) {
  if (!value) return 'Unknown date';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

const MAX_COMMENT_IMAGES = 10;
const MAX_COMMENT_IMAGE_SIZE = 50 * 1024 * 1024;
const COMMENT_IMAGE_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return reject(new Error('Unable to read image'));
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'));
    reader.readAsDataURL(file);
  });
}

function CommentsContent({
  comments,
  isLoading,
  error,
  providerId,
  emptyMessage,
  mentionDisplayNames,
  onEditComment,
}: {
  comments: WorkItemComment[];
  isLoading: boolean;
  error?: string | null;
  providerId?: string;
  emptyMessage: string;
  mentionDisplayNames?: MentionDisplayNames;
  onEditComment?: (comment: WorkItemComment) => void;
}) {
  if (isLoading) {
    return <div className="text-ink-3 py-6 text-sm">Loading comments...</div>;
  }

  if (error) {
    return (
      <div className="py-6">
        <p className="text-ink-2 text-sm">Unable to load comments.</p>
        <p className="text-ink-3 mt-1 text-xs">{error}</p>
      </div>
    );
  }

  if (comments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <MessageSquare className="text-ink-4 h-8 w-8" />
        <p className="text-ink-3 max-w-56 text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pb-2">
      {comments.map((comment) => (
        <div
          key={comment.id}
          className="rounded-md border px-3 py-2.5"
          style={{
            borderColor: 'var(--color-glass-border)',
            background: 'var(--color-glass-subtle)',
          }}
        >
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="text-ink-1 font-medium">{comment.createdBy}</span>
            <span className="text-ink-4">&bull;</span>
            <span className="text-ink-3">
              {formatCommentDate(comment.createdDate)}
            </span>
            {onEditComment && (
              <button type="button" className="text-ink-3 hover:text-ink-1 ml-auto" aria-label="Edit comment" onClick={() => onEditComment(comment)}>
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
          {comment.format === 'markdown' ? (
            <AzureMarkdownContent
              markdown={comment.text}
              providerId={providerId}
              attachmentBaseUrl={comment.attachmentBaseUrl}
              mentionDisplayNames={mentionDisplayNames}
              className="text-ink-2 text-xs"
              imageClassName="max-h-72 w-auto object-contain"
              enableImageModal
            />
          ) : (
            <AzureHtmlContent
              html={comment.text}
              providerId={providerId}
              attachmentBaseUrl={comment.attachmentBaseUrl}
              mentionDisplayNames={mentionDisplayNames}
              className="text-ink-2 text-xs"
              imageClassName="max-h-72 w-auto object-contain"
              enableImageModal
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function WorkItemComments({
  comments,
  isLoading,
  error,
  providerId,
  projectName,
  emptyMessage = 'No comments yet.',
  title = 'Comments',
  hideHeader = false,
  onAddComment,
  onUpdateComment,
  isAddingComment = false,
}: {
  comments: WorkItemComment[];
  isLoading: boolean;
  error?: string | null;
  providerId?: string;
  emptyMessage?: string;
  title?: string;
  hideHeader?: boolean;
  onAddComment?: (text: string) => void | Promise<unknown>;
  projectName?: string;
  onUpdateComment?: (params: { commentId: number; text: string }) => void | Promise<unknown>;
  isAddingComment?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [editingComment, setEditingComment] = useState<WorkItemComment | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchedMentions, setSearchedMentions] = useState<{
    providerId?: string;
    options: MentionOption[];
  }>({ options: [] });
  const trimmedDraft = draft.trim();
  const canAttach = !!providerId && !!projectName && !isAddingComment && !isUploading;
  const shouldLoadMentionNames = comments.some((comment) =>
    containsAzureDevOpsMention(comment.text),
  );
  const { data: initialMentionOptions = EMPTY_MENTION_OPTIONS } = useQuery({
    queryKey: ['azure-identities', providerId, 'work-item-comments'],
    queryFn: () =>
      api.azureDevOps.searchIdentities({ providerId: providerId!, query: '' }),
    enabled: !!providerId && shouldLoadMentionNames,
    staleTime: 5 * 60_000,
  });
  const mentionOptions = useMemo(() => {
    const byId = new Map<string, MentionOption>();
    for (const option of initialMentionOptions) {
      byId.set(normalizeMentionId(option.id), option);
    }
    if (searchedMentions.providerId === providerId) {
      for (const option of searchedMentions.options) {
        byId.set(normalizeMentionId(option.id), option);
      }
    }
    return [...byId.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }, [initialMentionOptions, providerId, searchedMentions]);
  const mentionDisplayNames = useMemo(() => {
    const names: MentionDisplayNames = {};
    for (const option of mentionOptions) {
      names[normalizeMentionId(option.id)] = option.displayName;
    }
    return names;
  }, [mentionOptions]);

  const handleSearchMentions = useCallback(
    async (query: string) => {
      if (!providerId) return [];
      const options = await api.azureDevOps.searchIdentities({
        providerId,
        query,
      });
      setSearchedMentions((current) => {
        const byId = new Map<string, MentionOption>();
        if (current.providerId === providerId) {
          for (const option of current.options) {
            byId.set(normalizeMentionId(option.id), option);
          }
        }
        for (const option of options) {
          byId.set(normalizeMentionId(option.id), option);
        }
        return { providerId, options: [...byId.values()] };
      });
      return options;
    },
    [providerId],
  );

  async function handleSubmit() {
    if (!trimmedDraft || (!onAddComment && !onUpdateComment)) return;
    try {
      const text = encodeMentionDisplayNames(trimmedDraft, mentionOptions);
      if (editingComment && onUpdateComment) {
        await onUpdateComment({ commentId: editingComment.id, text });
        setEditingComment(null);
      } else if (onAddComment) {
        await onAddComment(text);
      }
      setDraft('');
    } catch {
      // Mutation hook handles user-facing error toast. Keep draft for retry.
    }
  }

  async function attachFiles(files: FileList | File[]) {
    if (!providerId || !projectName || isUploading) return;
    const images = [...files].filter((file) => COMMENT_IMAGE_TYPES.has(file.type));
    if (images.length === 0) return;
    if (images.some((file) => file.size > MAX_COMMENT_IMAGE_SIZE)) {
      console.error('Comment image exceeds 50 MB limit');
      return;
    }
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? start;
    setIsUploading(true);
    try {
      const remaining = Math.max(0, MAX_COMMENT_IMAGES - (draft.match(/!\[[^\]]*\]\(/g)?.length ?? 0));
      const markdownParts: string[] = [];
      for (const file of images.slice(0, remaining)) {
        const { url } = await api.azureDevOps.uploadWorkItemAttachment({
          providerId,
          projectName,
          filename: file.name,
          mimeType: file.type,
          base64: await readFileAsBase64(file),
        });
        markdownParts.push(`![${file.name}](${url})`);
      }
      const markdown = markdownParts.join('\n');
      setDraft((value) => `${value.slice(0, start)}${markdown}${value.slice(end)}`);
      requestAnimationFrame(() => textarea?.setSelectionRange(start + markdown.length, start + markdown.length));
    } catch (error) {
      console.error('Failed to upload comment image:', error);
    } finally {
      setIsUploading(false);
    }
  }

  const editor = onAddComment || onUpdateComment ? (
    <div className="border-glass-border/50 bg-bg-1/70 sticky bottom-0 -mx-5 mt-3 border-t px-5 pt-3 pb-1 backdrop-blur">
        <MentionTextarea
         ref={textareaRef}
        value={draft}
        onChange={setDraft}
        mentionOptions={mentionOptions}
        onSearchMentions={providerId ? handleSearchMentions : undefined}
        placeholder="Write a comment..."
        className={MENTION_TEXTAREA_MD_CLASS}
        minHeight={76}
        disabled={isAddingComment}
         onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void handleSubmit();
          }
         }}
         onPaste={(event) => {
           const files = [...event.clipboardData.files];
           if (files.some((file) => COMMENT_IMAGE_TYPES.has(file.type)) && !event.clipboardData.getData('text/plain')) {
             event.preventDefault();
             void attachFiles(files);
           }
         }}
       />
       <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { void attachFiles(event.target.files ?? []); event.target.value = ''; }} />
       <div className="mt-2 flex items-center justify-between gap-2">
         <div className="flex items-center gap-2">
           <button type="button" className="text-ink-3 hover:text-ink-1 inline-flex items-center gap-1 text-[11px]" disabled={!canAttach} onClick={() => fileInputRef.current?.click()}>
             <ImagePlus className="h-3.5 w-3.5" /> {isUploading ? 'Uploading...' : 'Add image/GIF'}
           </button>
           <span className="text-ink-4 text-[11px]">Cmd+Enter to post</span>
         </div>
         <Button
          type="button"
          size="sm"
          variant="primary"
          icon={<Send className="h-3.5 w-3.5" />}
           loading={isAddingComment || isUploading}
          disabled={!trimmedDraft}
           onClick={handleSubmit}
         >
           {editingComment ? 'Save' : 'Post'}
         </Button>
         {editingComment && <button type="button" className="text-ink-3 hover:text-ink-1" onClick={() => { setEditingComment(null); setDraft(''); }} aria-label="Cancel editing"><X className="h-4 w-4" /></button>}
      </div>
    </div>
  ) : null;

  if (hideHeader) {
    return (
      <div className="flex min-h-full min-w-0 flex-col overflow-x-hidden">
        <div className="min-h-0 flex-1">
          <CommentsContent
            comments={comments}
            isLoading={isLoading}
            error={error}
            providerId={providerId}
            emptyMessage={emptyMessage}
            mentionDisplayNames={mentionDisplayNames}
            onEditComment={onUpdateComment ? (comment) => { setEditingComment(comment); setDraft(comment.rawText ?? comment.text); } : undefined}
          />
        </div>
        {editor}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2">
        <MessagesSquare className="text-ink-3 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-ink-1 text-sm font-medium">{title}</div>
          <div className="text-ink-3 text-xs">
            {isLoading
              ? 'Loading thread...'
              : error
                ? 'Unable to load comments'
                : `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
          </div>
        </div>
      </div>

      <div className="border-glass-border/50 mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-3">
        <CommentsContent
          comments={comments}
          isLoading={isLoading}
          error={error}
          providerId={providerId}
          emptyMessage={emptyMessage}
          mentionDisplayNames={mentionDisplayNames}
          onEditComment={onUpdateComment ? (comment) => { setEditingComment(comment); setDraft(comment.rawText ?? comment.text); } : undefined}
        />
      </div>
      {editor}
    </div>
  );
}
