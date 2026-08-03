import { ImagePlus, MessageSquare, MessagesSquare, Pencil, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { Dropdown } from '@/common/ui/dropdown';
import {
  ALLOWED_IMAGE_TYPES,
  getAttachmentFileName,
  getAzureAttachmentPayload,
  MAX_IMAGES,
  processImageFile,
} from '@/lib/image-utils';
import {
  getPromptImageMarkdownSize,
  markdownImagePlaceholderPattern,
} from '@/lib/markdown-image-size';
import { createPromptImageUploadCache } from '@/lib/prompt-image-upload-cache';
import { uploadImagesIntoMarkdown } from '@/features/pull-request/ui-pr-comment-form';
import { useImagePreviewUrls } from '@/hooks/use-image-preview-urls';
import type { PromptImagePart } from '@shared/agent-backend-types';
import {
  isVideoFile,
  VideoGifConverter,
} from '@/features/common/ui-video-gif-converter';
import { useSetWorkItemCommentReaction } from '@/hooks/use-work-items';
import type { WorkItemCommentReactionType } from '@/lib/api';

const REACTIONS: Array<{ type: WorkItemCommentReactionType; label: string; icon: string }> = [
  { type: 'like', label: 'Like', icon: '👍' },
  { type: 'heart', label: 'Heart', icon: '❤️' },
  { type: 'hooray', label: 'Hooray', icon: '🎉' },
  { type: 'smile', label: 'Smile', icon: '😊' },
  { type: 'confused', label: 'Confused', icon: '😕' },
  { type: 'dislike', label: 'Dislike', icon: '👎' },
];

function CommentReactions({ comment, enabled, providerId, projectName }: { comment: WorkItemComment; enabled: boolean; providerId?: string; projectName?: string }) {
  const mutation = useSetWorkItemCommentReaction();
  const pickerRef = useRef<{ toggle: () => void } | null>(null);
  const reactions = comment.reactions ?? [];
  const toggleReaction = (reactionType: WorkItemCommentReactionType, engaged: boolean) => {
    if (!providerId || !projectName) return;
    mutation.mutate({ providerId, projectName, workItemId: comment.workItemId, commentId: comment.id, reactionType, engaged });
    pickerRef.current?.toggle();
  };
  return (
    <div className="relative mt-2 flex flex-wrap gap-1">
      {REACTIONS.map((reaction) => {
        const current = reactions.find((item) => item.type === reaction.type);
        if (!current?.count) return null;
        return (
          <button
            key={reaction.type}
            type="button"
            disabled={!enabled || mutation.isPending || !providerId || !projectName}
            onClick={() => toggleReaction(reaction.type, !current?.isCurrentUserEngaged)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${current?.isCurrentUserEngaged ? 'border-acc/50 bg-acc/15 text-acc-ink' : 'border-glass-border text-ink-3 hover:text-ink-1'} disabled:cursor-default disabled:opacity-70`}
            aria-label={`${reaction.label} reaction, ${current?.count ?? 0}${current?.isCurrentUserEngaged ? ', selected' : ''}`}
            title={enabled ? reaction.label : `${reaction.label}: ${current?.count ?? 0}`}
          >
            {reaction.icon} {current?.count ?? 0}
          </button>
        );
      })}
      {enabled && (
        <Dropdown
          dropdownRef={pickerRef}
          className="min-w-0 max-w-[calc(100vw-16px)] p-1"
          trigger={
            <button
              type="button"
              className="text-ink-4 rounded-full px-1.5 text-[13px] hover:bg-glass-light hover:text-ink-1"
              aria-label="Add reaction"
            >
              +
            </button>
          }
        >
          <div className="flex max-w-full flex-wrap gap-1">
            {REACTIONS.map((reaction) => (
              <button
                key={reaction.type}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="rounded p-1 text-sm hover:bg-glass-light"
                aria-label={`Add ${reaction.label} reaction`}
                title={reaction.label}
                onClick={() => toggleReaction(reaction.type, true)}
              >
                {reaction.icon}
              </button>
            ))}
          </div>
        </Dropdown>
      )}
    </div>
  );
}

function formatCommentDate(value: string) {
  if (!value) return 'Unknown date';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

const MAX_COMMENT_IMAGES = MAX_IMAGES;

/** Pending attachment: uploaded only when the comment is sent. */
type PendingImage = PromptImagePart & { placeholderMarkdown?: string };

function pendingImageFileName(image: PendingImage, index: number) {
  if (image.filename) return image.filename;
  const extension = image.mimeType.split('/')[1] || 'png';
  return `image-${index + 1}.${extension}`;
}

function CommentsContent({
  comments,
  isLoading,
  error,
  providerId,
  emptyMessage,
  mentionDisplayNames,
  onEditComment,
  editingCommentId,
  reactionsEnabled,
  projectName,
}: {
  comments: WorkItemComment[];
  isLoading: boolean;
  error?: string | null;
  providerId?: string;
  emptyMessage: string;
  mentionDisplayNames?: MentionDisplayNames;
  onEditComment?: (comment: WorkItemComment) => void;
  editingCommentId?: number | null;
  reactionsEnabled: boolean;
  projectName?: string;
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
            borderColor:
              editingCommentId === comment.id
                ? 'var(--color-accent, oklch(0.7 0.16 250))'
                : 'oklch(1 0 0 / 0.06)',
            background: 'oklch(1 0 0 / 0.02)',
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
          <CommentReactions comment={comment} enabled={reactionsEnabled} providerId={providerId} projectName={projectName} />
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
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const imageTokenRef = useRef(0);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const uploadCacheRef = useRef(createPromptImageUploadCache());
  const pendingImagePreviewUrls = useImagePreviewUrls(pendingImages);

  useEffect(() => {
    const uploadCache = uploadCacheRef.current;
    return () => uploadCache.clear();
  }, []);
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

  const startEditing = useCallback(
    (comment: WorkItemComment) => {
      setEditingComment(comment);
      setDraft(comment.rawText ?? comment.text);
      setComposerError(null);
      pendingImagesRef.current = [];
      setPendingImages([]);
      // The composer is shared for new comments and edits; focusing it makes
      // clicking the pencil feel connected to the editor.
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      });
    },
    [],
  );

  const clearPendingImages = useCallback(() => {
    pendingImagesRef.current = [];
    setPendingImages([]);
    uploadCacheRef.current.clear();
  }, []);

  const removePendingImage = useCallback((index: number) => {
    const target = pendingImagesRef.current[index];
    if (target?.placeholderMarkdown) {
      const pattern = markdownImagePlaceholderPattern(target.placeholderMarkdown);
      if (pattern) setDraft((body) => body.replace(pattern, ''));
    }
    pendingImagesRef.current = pendingImagesRef.current.filter(
      (_, i) => i !== index,
    );
    setPendingImages(pendingImagesRef.current);
  }, []);

  async function handleSubmit() {
    if (isUploading || isAddingComment) return;
    if (!onAddComment && !onUpdateComment) return;
    const images = pendingImagesRef.current;
    if (!trimmedDraft && images.length === 0) return;

    setComposerError(null);
    let text: string;
    if (images.length > 0) {
      if (!providerId || !projectName) {
        setComposerError('Cannot upload images for this work item.');
        return;
      }
      setIsUploading(true);
      try {
        text = await uploadImagesIntoMarkdown({
          body: trimmedDraft,
          images,
          uploadImage: async (image, fileName) => {
            const payload = await getAzureAttachmentPayload(image);
            const { url } = await api.azureDevOps.uploadWorkItemAttachment({
              providerId,
              projectName,
              filename: getAttachmentFileName(fileName, payload.mimeType),
              mimeType: payload.mimeType,
              base64: payload.dataBase64,
            });
            return url;
          },
          uploadCache: uploadCacheRef.current,
          mentionOptions,
        });
      } catch (uploadError) {
        // Uploaded URLs stay cached, so retrying only re-uploads what failed.
        setComposerError(
          uploadError instanceof Error
            ? uploadError.message
            : 'Failed to upload image',
        );
        return;
      } finally {
        setIsUploading(false);
      }
    } else {
      text = encodeMentionDisplayNames(trimmedDraft, mentionOptions);
    }

    if (text.includes('jc-image://')) {
      setComposerError('Remove incomplete image placeholders before sending.');
      return;
    }

    try {
      if (editingComment && onUpdateComment) {
        await onUpdateComment({ commentId: editingComment.id, text });
        setEditingComment(null);
      } else if (onAddComment) {
        await onAddComment(text);
      }
      setDraft('');
      clearPendingImages();
    } catch {
      // Mutation hook handles user-facing error toast. Keep draft for retry.
    }
  }

  // Tracks the caret across back-to-back inserts: the DOM selection is only
  // corrected after React commits, so re-reading it would use stale offsets.
  const insertionCaretRef = useRef<number | null>(null);

  const insertTextAtCursor = useCallback((text: string) => {
    const textarea = textareaRef.current;
    const tracked = insertionCaretRef.current;
    const start = tracked ?? textarea?.selectionStart;
    const end = tracked ?? textarea?.selectionEnd;
    if (start === undefined || end === undefined) {
      setDraft((current) => `${current}${current ? '\n\n' : ''}${text}`);
      return;
    }
    setDraft((current) => `${current.slice(0, start)}${text}${current.slice(end)}`);
    const cursor = start + text.length;
    insertionCaretRef.current = cursor;
    requestAnimationFrame(() => {
      insertionCaretRef.current = null;
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  }, []);

  const addPendingImage = useCallback(
    (image: PromptImagePart) => {
      if (pendingImagesRef.current.length >= MAX_COMMENT_IMAGES) {
        setComposerError(`You can attach up to ${MAX_COMMENT_IMAGES} images.`);
        return;
      }
      imageTokenRef.current += 1;
      const token = imageTokenRef.current;
      const fileName = pendingImageFileName(image, token - 1);
      const altText = fileName.replace(/[[\]()\\]/g, '_');
      const placeholderMarkdown = `![${altText}](jc-image://${token}${getPromptImageMarkdownSize(image)})`;
      pendingImagesRef.current = [
        ...pendingImagesRef.current,
        { ...image, filename: fileName, placeholderMarkdown },
      ];
      setPendingImages(pendingImagesRef.current);
      setComposerError(null);
      insertTextAtCursor(placeholderMarkdown);
    },
    [insertTextAtCursor],
  );

  async function attachFiles(files: FileList | File[]) {
    if (!canAttach) return;
    const all = [...files];
    const imageFiles = all.filter((file) => ALLOWED_IMAGE_TYPES.includes(file.type));
    const video = all.find(isVideoFile);
    const remaining = MAX_COMMENT_IMAGES - pendingImagesRef.current.length;
    if (remaining <= 0) {
      setComposerError(`You can attach up to ${MAX_COMMENT_IMAGES} images.`);
      return;
    }
    if (imageFiles.length > remaining) {
      setComposerError(
        `Only ${remaining} more image${remaining === 1 ? '' : 's'} can be attached.`,
      );
    }
    for (const file of imageFiles.slice(0, remaining)) {
      await processImageFile(file, addPendingImage, setComposerError);
    }
    if (!video) return;
    if (remaining > imageFiles.length) setVideoFile(video);
    else setComposerError(`You can attach up to ${MAX_COMMENT_IMAGES} images.`);
  }

  const editor = onAddComment || onUpdateComment ? (
    <div className="border-glass-border/50 bg-bg-1/70 sticky top-0 z-10 -mx-5 mb-3 border-b px-5 pt-1 pb-3 backdrop-blur">
        {editingComment && (
          <div className="text-ink-3 mb-1.5 flex items-center gap-2 text-[11px]">
            <Pencil className="h-3 w-3" />
            <span>Editing comment from {editingComment.createdBy}</span>
            <button
              type="button"
              className="text-ink-3 hover:text-ink-1 ml-auto"
              onClick={() => {
                setEditingComment(null);
                setDraft('');
                clearPendingImages();
                setComposerError(null);
              }}
            >
              Cancel
            </button>
          </div>
        )}
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
           if (files.some((file) => ALLOWED_IMAGE_TYPES.includes(file.type) || isVideoFile(file)) && !event.clipboardData.getData('text/plain')) {
             event.preventDefault();
             void attachFiles(files);
           }
         }}
         onDragOver={(event) => event.preventDefault()}
         onDrop={(event) => {
           const files = [...event.dataTransfer.files];
           if (!files.some((file) => ALLOWED_IMAGE_TYPES.includes(file.type) || isVideoFile(file))) return;
           event.preventDefault();
           void attachFiles(files);
         }}
       />
       {pendingImages.length > 0 && (
         <div className="mt-2 flex flex-wrap gap-2">
           {pendingImages.map((image, index) => {
             const name = pendingImageFileName(image, index);
             return (
               <div key={image.placeholderMarkdown ?? `${name}-${index}`} className="border-glass-border relative h-16 w-16 overflow-hidden rounded border">
                 {pendingImagePreviewUrls[index] ? (
                   <img src={pendingImagePreviewUrls[index]} alt={name} className="h-full w-full object-cover" />
                 ) : (
                   <div className="text-ink-3 flex h-full w-full items-center justify-center px-1 text-center text-[9px]">
                     <span className="truncate">{name}</span>
                   </div>
                 )}
                 <button
                   type="button"
                   className="bg-bg-1/90 text-ink-2 hover:text-ink-0 absolute top-0.5 right-0.5 flex h-6 w-6 items-center justify-center rounded"
                   aria-label={`Remove ${name}`}
                   onClick={() => removePendingImage(index)}
                   disabled={isUploading}
                 >
                   <X className="h-3.5 w-3.5" />
                 </button>
               </div>
             );
           })}
         </div>
       )}
       {composerError && (
         <p className="text-status-fail mt-2 text-[11px]" role="alert">
           {composerError}
         </p>
       )}
       <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple hidden onChange={(event) => { void attachFiles(event.target.files ?? []); event.target.value = ''; }} />
       <div className="mt-2 flex items-center justify-between gap-2">
         <div className="flex items-center gap-2">
           <button type="button" className="text-ink-3 hover:text-ink-1 inline-flex items-center gap-1 text-[11px]" disabled={!canAttach} onClick={() => fileInputRef.current?.click()}>
             <ImagePlus className="h-3.5 w-3.5" /> Add image/GIF
             {pendingImages.length > 0 ? ` (${pendingImages.length}/${MAX_COMMENT_IMAGES})` : ''}
           </button>
           <span className="text-ink-4 text-[11px]">Cmd+Enter to post</span>
         </div>
         <Button
          type="button"
          size="sm"
          variant="primary"
          icon={<Send className="h-3.5 w-3.5" />}
           loading={isAddingComment || isUploading}
          disabled={!trimmedDraft && pendingImages.length === 0}
           onClick={handleSubmit}
         >
           {editingComment ? 'Save' : 'Post'}
         </Button>
         {editingComment && <button type="button" className="text-ink-3 hover:text-ink-1" onClick={() => { setEditingComment(null); setDraft(''); clearPendingImages(); setComposerError(null); }} aria-label="Cancel editing"><X className="h-4 w-4" /></button>}
      </div>
      {videoFile &&
        createPortal(
          <VideoGifConverter
            file={videoFile}
            onAttach={addPendingImage}
            onClose={() => setVideoFile(null)}
          />,
          document.body,
        )}
    </div>
  ) : null;

  if (hideHeader) {
    return (
      <div className="flex min-h-full min-w-0 flex-col overflow-x-hidden">
        {editor}
        <div className="min-h-0 flex-1">
          <CommentsContent
            comments={comments}
            isLoading={isLoading}
            error={error}
            providerId={providerId}
            emptyMessage={emptyMessage}
            mentionDisplayNames={mentionDisplayNames}
            onEditComment={onUpdateComment ? startEditing : undefined}
            editingCommentId={editingComment?.id ?? null}
            reactionsEnabled={!!onAddComment || !!onUpdateComment}
            projectName={projectName}
          />
        </div>
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
        {editor}
        <CommentsContent
          comments={comments}
          isLoading={isLoading}
          error={error}
          providerId={providerId}
          emptyMessage={emptyMessage}
          mentionDisplayNames={mentionDisplayNames}
          onEditComment={onUpdateComment ? startEditing : undefined}
          editingCommentId={editingComment?.id ?? null}
          reactionsEnabled={!!onAddComment || !!onUpdateComment}
          projectName={projectName}
        />
      </div>
    </div>
  );
}
