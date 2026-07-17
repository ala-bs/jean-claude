import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
} from 'react';
import { Edit3, Image, Loader2, Save, X } from 'lucide-react';
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';


import type {
  AzureDevOpsCommentThread,
  AzureDevOpsFileChange,
  AzureDevOpsPullRequestDetails,
  AzureDevOpsUser,
} from '@/lib/api';
/* eslint-disable sort-imports */
import {
  type DiffFile,
  FileDiffContent,
  normalizeAzureChangeType,
} from '@/features/common/ui-file-diff';
import {
  getAllowedMergeStrategies,
  useCurrentAzureUser,
  useLinkWorkItemToPr,
  usePullRequestFileContent,
  usePullRequestPolicyEvaluations,
  usePullRequestWorkItems,
  useRequeuePolicyEvaluation,
  useSetAutoComplete,
  useUnlinkWorkItemFromPr,
  useUpdatePullRequestDescription,
  useUploadPullRequestAttachment,
} from '@/hooks/use-pull-requests';
import {
  isVideoFile,
  VideoGifConverter,
} from '@/features/common/ui-video-gif-converter';
import { MAX_IMAGES, processImageFile } from '@/lib/image-utils';
import {
  type MentionDisplayNames,
  normalizeMentionId,
} from '@/lib/azure-devops-mentions';
import {
  getPromptImageMarkdownSize,
  markdownImagePlaceholderPattern,
  replaceMarkdownImageUrl,
} from '@/lib/markdown-image-size';
import { AzureMarkdownContent } from '@/features/common/ui-azure-html-content';
import { Button } from '@/common/ui/button';
import { formatBytes } from '@/lib/format-bytes';
import { Kbd } from '@/common/ui/kbd';
import type { MentionOption } from '@/common/ui/mention-textarea';
import type { PromptImagePart } from '@shared/agent-backend-types';
import type { PullRequestRepoInfo } from '@/hooks/use-pull-requests';
import { Textarea } from '@/common/ui/textarea';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useHorizontalResize } from '@/hooks/use-horizontal-resize';
import { useImagePreviewUrls } from '@/hooks/use-image-preview-urls';
import { createPromptImageUploadCache } from '@/lib/prompt-image-upload-cache';



import {
  convertPrThreadsForFile,
  PrInlineCommentThread,
} from '../ui-pr-inline-comment-thread';
import { CIInlinePanel } from '../ui-pr-ci-inline';
import { PrChecks } from '../ui-pr-checks';
import { PrComments } from '../ui-pr-comments';
import { PrMetaPanel } from '../ui-pr-meta-panel';
import { descriptionPreviewMarkdown } from './media-preview';



type PendingDescriptionImage = PromptImagePart & {
  placeholderMarkdown: string;
};

function placeholderPattern(placeholderMarkdown: string) {
  return markdownImagePlaceholderPattern(placeholderMarkdown);
}

export function PrOverview({
  pr,
  projectId,
  prId,
  providerId,
  azureProjectId,
  repoId: _repoId,
  azureProjectName,
  threads = [],
  onAddComment,
  onUploadImage,
  isAddingComment,
  bottomPadding = 0,
  fileCount = 0,
  files = [],
  mentionOptions = [],
  onSearchMentions,
  repoInfo,
  readOnly = false,
  commentSubmitLabel,
}: {
  pr: AzureDevOpsPullRequestDetails;
  projectId: string;
  prId: number;
  providerId?: string;
  azureProjectId?: string;
  repoId?: string;
  azureProjectName?: string;
  threads?: AzureDevOpsCommentThread[];
  onAddComment?: (content: string) => Promise<void> | void;
  onUploadImage?: (image: PromptImagePart, fileName: string) => Promise<string>;
  isAddingComment?: boolean;
  bottomPadding?: number;
  fileCount?: number;
  files?: AzureDevOpsFileChange[];
  mentionOptions?: MentionOption[];
  onSearchMentions?: (query: string) => Promise<MentionOption[]>;
  repoInfo?: PullRequestRepoInfo;
  readOnly?: boolean;
  commentSubmitLabel?: string;
}) {
  const [filePreview, setFilePreview] = useState<{
    filePath: string;
    lineStart: number;
    lineEnd: number;
  } | null>(null);
  const [filePreviewWidth, setFilePreviewWidth] = useState(560);
  // Track which build is expanded inline in the checks block
  const [expandedBuildId, setExpandedBuildId] = useState<number | null>(null);
  const { data: currentUser } = useCurrentAzureUser(projectId, repoInfo);

  const mentionDisplayNames = useMemo(() => {
    const names: MentionDisplayNames = {};
    const addName = (
      id: string | undefined,
      displayName: string | undefined,
    ) => {
      if (id && displayName) names[normalizeMentionId(id)] = displayName;
    };

    addName(pr.createdBy.id, pr.createdBy.displayName);
    for (const reviewer of pr.reviewers) {
      addName(reviewer.id, reviewer.displayName);
    }
    addName(currentUser?.id, currentUser?.displayName);
    addName(currentUser?.identityId, currentUser?.displayName);
    for (const thread of threads) {
      for (const comment of thread.comments) {
        addName(comment.author.id, comment.author.displayName);
      }
    }

    return names;
  }, [currentUser, pr.createdBy, pr.reviewers, threads]);


  const handleExpandCheck = useCallback((buildId: number | null) => {
    setExpandedBuildId(buildId);
  }, []);

  const {
    containerRef: previewResizeContainerRef,
    isDragging: isPreviewDragging,
    handleMouseDown: handlePreviewResizeMouseDown,
  } = useHorizontalResize({
    initialWidth: filePreviewWidth,
    minWidth: 320,
    maxWidthFraction: 0.75,
    direction: 'left',
    onWidthChange: setFilePreviewWidth,
  });

  // Track which evaluations were recently queued by the user
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set());

  // Poll faster when there are active/queued builds
  const hasActiveBuilds = queuedIds.size > 0;

  const { data: evaluations = [], isLoading: isChecksLoading } =
    usePullRequestPolicyEvaluations(
      projectId,
      prId,
      {
        refetchInterval: hasActiveBuilds ? 10_000 : false,
      },
      repoInfo,
    );

  const { data: workItems = [], isLoading: isWorkItemsLoading } =
    usePullRequestWorkItems(projectId, prId, repoInfo);

  const linkWorkItem = useLinkWorkItemToPr(projectId, prId, repoInfo);
  const unlinkWorkItem = useUnlinkWorkItemFromPr(projectId, prId, repoInfo);

  // Clear queued IDs when the server confirms they're no longer pending
  const prevEvaluationsRef = useRef(evaluations);
  useEffect(() => {
    if (queuedIds.size === 0) return;
    startTransition(() => setQueuedIds((prev) => {
      const next = new Set(prev);
      for (const id of prev) {
        const evaluation = evaluations.find((e) => e.evaluationId === id);
        if (!evaluation) {
          next.delete(id);
        } else if (
          evaluation.status !== 'queued' ||
          !!evaluation.context?.buildId
        ) {
          next.delete(id);
        }
      }
      if (next.size === prev.size) return prev;
      return next;
    }));
    prevEvaluationsRef.current = evaluations;
  }, [evaluations, queuedIds]);

  const requeueMutation = useRequeuePolicyEvaluation(projectId, prId, repoInfo);
  const autoCompleteMutation = useSetAutoComplete(projectId, prId, repoInfo);

  const handleRequeue = useCallback(
    (evaluationId: string) => {
      setQueuedIds((prev) => new Set(prev).add(evaluationId));
      requeueMutation.mutate(
        { evaluationId },
        {
          onError: () => {
            setQueuedIds((prev) => {
              const next = new Set(prev);
              next.delete(evaluationId);
              return next;
            });
          },
        },
      );
    },
    [requeueMutation],
  );

  const handleQueueAll = useCallback(
    (ids: string[]) => {
      setQueuedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
      for (const id of ids) {
        requeueMutation.mutate(
          { evaluationId: id },
          {
            onError: () => {
              setQueuedIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            },
          },
        );
      }
    },
    [requeueMutation],
  );

  const ignoredAutoCompletePolicyIds = useMemo(
    () => new Set(pr.completionOptions?.autoCompleteIgnoreConfigIds ?? []),
    [pr.completionOptions?.autoCompleteIgnoreConfigIds],
  );

  const handleSetPolicyIgnored = useCallback(
    (configId: number, shouldIgnore: boolean) => {
      if (!pr.autoCompleteSetBy || autoCompleteMutation.isAnyPending) return;

      const currentIds = pr.completionOptions?.autoCompleteIgnoreConfigIds ?? [];
      const autoCompleteIgnoreConfigIds = shouldIgnore
        ? Array.from(new Set([...currentIds, configId]))
        : currentIds.filter((id) => id !== configId);

      autoCompleteMutation.mutate({
        enabled: true,
        autoCompleteSetById: pr.autoCompleteSetBy.id,
        completionOptions: {
          mergeStrategy:
            pr.completionOptions?.mergeStrategy ??
            getAllowedMergeStrategies(evaluations)[0] ??
            'noFastForward',
          deleteSourceBranch: pr.completionOptions?.deleteSourceBranch ?? true,
          transitionWorkItems:
            pr.completionOptions?.transitionWorkItems ?? false,
          mergeCommitMessage: pr.completionOptions?.mergeCommitMessage,
          autoCompleteIgnoreConfigIds,
        },
      });
    },
    [
      autoCompleteMutation,
      evaluations,
      pr.autoCompleteSetBy,
      pr.completionOptions,
    ],
  );

  // Merge optimistic queued state with server data
  const evaluationsWithOptimistic = useMemo(
    () =>
      evaluations.map((e) => {
        if (queuedIds.has(e.evaluationId) && !e.context?.buildId) {
          return { ...e, _optimisticQueued: true as const };
        }
        return { ...e, _optimisticQueued: false as const };
      }),
    [evaluations, queuedIds],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        ref={previewResizeContainerRef}
        className={clsx(
          'grid min-h-0 flex-1 overflow-hidden',
          filePreview
            ? 'grid-cols-[minmax(0,1fr)_auto] gap-0 py-5 pr-0 pl-5'
            : 'grid-cols-[1fr_280px] gap-5 p-5',
          isPreviewDragging && 'select-none',
        )}
      >
        {/* Main column */}
        <div
          className={clsx(
            'min-h-0 min-w-0 space-y-4 overflow-y-auto',
            filePreview ? 'pr-0' : 'pr-1',
          )}
          style={
            bottomPadding > 0 ? { paddingBottom: bottomPadding } : undefined
          }
        >
          {/* Checks */}
          <PrChecks
            evaluations={evaluationsWithOptimistic}
            isLoading={isChecksLoading}
            onRequeue={readOnly ? undefined : handleRequeue}
            onQueueAll={readOnly ? undefined : handleQueueAll}
            isRequeuing={requeueMutation.isPending}
            expandedBuildId={providerId ? expandedBuildId : undefined}
            onExpandCheck={providerId ? handleExpandCheck : undefined}
            renderExpanded={
              providerId && azureProjectId
                ? (buildId) => (
                    <CIInlinePanel
                      providerId={providerId}
                      azureProjectId={azureProjectId}
                      buildId={buildId}
                      onClose={() => setExpandedBuildId(null)}
                    />
                  )
                : undefined
            }
            ignoredAutoCompletePolicyIds={ignoredAutoCompletePolicyIds}
            onSetPolicyIgnored={
              !readOnly && pr.autoCompleteSetBy
                ? handleSetPolicyIgnored
                : undefined
            }
            isSettingPolicyIgnored={autoCompleteMutation.isAnyPending}
          />

          {/* Description */}
          <PrDescriptionCard
            pr={pr}
            projectId={projectId}
            prId={prId}
            providerId={providerId}
            mentionDisplayNames={mentionDisplayNames}
            currentUser={currentUser}
            repoInfo={repoInfo}
            readOnly={readOnly}
          />

          {/* Comments */}
          <PrComments
            threads={threads}
            providerId={providerId}
            projectId={projectId}
            prId={prId}
            onAddComment={onAddComment}
            onUploadImage={onUploadImage}
            isAddingComment={isAddingComment}
            onOpenFilePreview={setFilePreview}
            mentionDisplayNames={mentionDisplayNames}
            mentionOptions={mentionOptions}
            onSearchMentions={onSearchMentions}
            readOnly={readOnly}
            repoInfo={repoInfo}
            submitLabel={commentSubmitLabel}
          />
        </div>

        {/* Right sidebar */}
        <div
          className={clsx(
            'relative min-h-0 min-w-0 overflow-y-auto',
            filePreview && 'pl-3',
          )}
          style={{
            width: filePreview ? filePreviewWidth : undefined,
            ...(bottomPadding > 0 ? { paddingBottom: bottomPadding } : {}),
          }}
        >
          {filePreview && (
            <div
              onMouseDown={handlePreviewResizeMouseDown}
              className={clsx(
                'hover:bg-acc/50 absolute top-0 left-0 h-full w-1 cursor-col-resize transition-colors',
                isPreviewDragging && 'bg-acc/50',
              )}
            />
          )}
          <div
            className={clsx('h-full min-h-0', filePreview ? 'pr-0' : undefined)}
          >
            {filePreview ? (
              <PrFilePreviewPane
                projectId={projectId}
                prId={prId}
                filePath={filePreview.filePath}
                lineStart={filePreview.lineStart}
                lineEnd={filePreview.lineEnd}
                scrollToLine={filePreview.lineStart}
                threads={threads}
                files={files}
                providerId={providerId}
                mentionDisplayNames={mentionDisplayNames}
                mentionOptions={mentionOptions}
                onSearchMentions={onSearchMentions}
                onUploadImage={onUploadImage}
                onClose={() => setFilePreview(null)}
                repoInfo={repoInfo}
                readOnly={readOnly}
              />
            ) : (
              <PrMetaPanel
                pr={pr}
                projectId={projectId}
                fileCount={fileCount}
                providerId={providerId}
                repoInfo={repoInfo}
                workItems={workItems}
                isWorkItemsLoading={isWorkItemsLoading}
                azureProjectId={azureProjectId}
                azureProjectName={azureProjectName}
                onLinkWorkItem={
                  readOnly
                    ? undefined
                    : (workItemId) => linkWorkItem.mutate(workItemId)
                }
                onUnlinkWorkItem={
                  readOnly
                    ? undefined
                    : (workItemId) => unlinkWorkItem.mutate(workItemId)
                }
                isLinkingWorkItem={linkWorkItem.isPending}
                isUnlinkingWorkItem={unlinkWorkItem.isPending}
                readOnly={readOnly}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const PrDescriptionCard = memo(function PrDescriptionCard({
  pr,
  projectId,
  prId,
  providerId,
  mentionDisplayNames,
  currentUser,
  repoInfo,
  readOnly,
}: {
  pr: AzureDevOpsPullRequestDetails;
  projectId: string;
  prId: number;
  providerId?: string;
  mentionDisplayNames: MentionDisplayNames;
  currentUser?: AzureDevOpsUser;
  repoInfo?: PullRequestRepoInfo;
  readOnly: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(pr.description);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [images, setImages] = useState<PendingDescriptionImage[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const imagesRef = useRef<PendingDescriptionImage[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const tokenCounterRef = useRef(0);
  const saveInProgressRef = useRef(false);
  const uploadCacheRef = useRef(createPromptImageUploadCache());
  const imagePreviewUrls = useImagePreviewUrls(images);
  const updateDescription = useUpdatePullRequestDescription(projectId, prId, repoInfo);
  const uploadAttachment = useUploadPullRequestAttachment(projectId, prId, repoInfo);
  const controlsLocked = isSaving || updateDescription.isPending || uploadAttachment.isPending;
  const canEdit = (() => {
    if (readOnly || !currentUser) return false;
    const email = currentUser.emailAddress.toLowerCase();
    const ownerEmail = pr.createdBy.uniqueName.toLowerCase();
    return (
      currentUser.identityId === pr.createdBy.id ||
      currentUser.id === pr.createdBy.id ||
      email === ownerEmail
    );
  })();
  const debouncedDraft = useDebouncedValue(draft, 300);
  const previewDraft = useMemo(
    () => descriptionPreviewMarkdown(debouncedDraft, images, imagePreviewUrls),
    [debouncedDraft, imagePreviewUrls, images],
  );

  useEffect(() => {
    if (!isEditing) {
      startTransition(() => setDraft(pr.description));
      startTransition(() => setError(null));
      imagesRef.current = [];
      uploadCacheRef.current.clear();
      startTransition(() => setImages([]));
    }
  }, [isEditing, pr.description]);

  useEffect(() => {
    const cache = uploadCacheRef.current;
    return () => cache.clear();
  }, []);

  const insertMarkdown = useCallback((markdown: string) => {
    if (saveInProgressRef.current) return;
    const textarea = textareaRef.current;
    if (!textarea) {
      setDraft((current) => `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${markdown}`);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setDraft((current) => `${current.slice(0, start)}${markdown}${current.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + markdown.length, start + markdown.length);
    });
  }, []);

  const stageImage = useCallback((image: PromptImagePart) => {
    if (saveInProgressRef.current) return;
    if (imagesRef.current.length >= MAX_IMAGES) {
      setError(`Only ${MAX_IMAGES} images or GIFs can be attached.`);
      return;
    }
    const token = ++tokenCounterRef.current;
    const fileName = image.filename || `image-${token}.png`;
    const safeAltText = fileName.replace(/[[\]()\\]/g, '_');
    const placeholderMarkdown = `![${safeAltText}](jc-image://${token}${getPromptImageMarkdownSize(image)})`;
    insertMarkdown(placeholderMarkdown);
    const nextImages = [...imagesRef.current, { ...image, placeholderMarkdown }];
    imagesRef.current = nextImages;
    setImages(nextImages);
  }, [insertMarkdown]);

  const stageImageFiles = useCallback(async (files: File[]) => {
    if (saveInProgressRef.current) return;
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    const video = files.find(isVideoFile);
    if (imageFiles.length === 0 && !video) return;
    const allowed = MAX_IMAGES - images.length;
    if (allowed <= 0) return;
    if (video && allowed > imageFiles.length) setVideoFile(video);
    setError(null);
    try {
      await Promise.all(imageFiles.slice(0, allowed).map((file) => new Promise<void>((resolve, reject) => {
        void processImageFile(file, (image) => { stageImage(image); resolve(); }, reject).catch(reject);
      })));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to stage image');
    }
  }, [images.length, stageImage]);

  const save = useCallback(async () => {
    if (saveInProgressRef.current || uploadAttachment.isPending) return;
    saveInProgressRef.current = true;
    setIsSaving(true);
    setError(null);
    try {
      let finalDescription = draft;
      for (const image of images) {
        const pattern = placeholderPattern(image.placeholderMarkdown);
        if (!pattern || !finalDescription.match(pattern)) continue;
        const fileName = image.filename || 'image.png';
        const attachmentUrl = await uploadCacheRef.current.resolve({
          image,
          fileName,
          upload: async () => (await uploadAttachment.mutateAsync({
            fileName,
            mimeType: image.mimeType || 'application/octet-stream',
            dataBase64: image.data,
          })).url,
        });
        finalDescription = finalDescription.replace(pattern, (match) => replaceMarkdownImageUrl(match, attachmentUrl));
      }
      if (finalDescription.includes('jc-image://')) {
        setError('Remove incomplete image placeholders before saving.');
        return;
      }
      await updateDescription.mutateAsync(finalDescription);
      imagesRef.current = [];
      uploadCacheRef.current.clear();
      setImages([]);
      setDraft(finalDescription);
      setIsEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save description');
    } finally {
      saveInProgressRef.current = false;
      setIsSaving(false);
    }
  }, [draft, images, updateDescription, uploadAttachment]);

  const handleFiles = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    await stageImageFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }, [stageImageFiles]);
  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (saveInProgressRef.current) return;
    const files = Array.from(event.clipboardData.files);
    if (!files.some((file) => file.type.startsWith('image/') || isVideoFile(file))) return;
    event.preventDefault();
    void stageImageFiles(files);
  }, [stageImageFiles]);
  const handleDrop = useCallback((event: DragEvent<HTMLTextAreaElement>) => {
    if (saveInProgressRef.current) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.some((file) => file.type.startsWith('image/') || isVideoFile(file))) return;
    event.preventDefault();
    void stageImageFiles(files);
  }, [stageImageFiles]);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  }, [save]);
  const removeImage = useCallback((index: number) => {
    if (saveInProgressRef.current || updateDescription.isPending || uploadAttachment.isPending) return;
    const image = imagesRef.current[index];
    if (image) {
      uploadCacheRef.current.delete(image);
      const pattern = placeholderPattern(image.placeholderMarkdown);
      setDraft((current) => pattern ? current.replace(pattern, '') : current);
    }
    const nextImages = imagesRef.current.filter((_, imageIndex) => imageIndex !== index);
    imagesRef.current = nextImages;
    setImages(nextImages);
  }, [updateDescription.isPending, uploadAttachment.isPending]);
  const cancel = useCallback(() => {
    if (saveInProgressRef.current) return;
    imagesRef.current = [];
    uploadCacheRef.current.clear();
    setImages([]);
    setIsEditing(false);
  }, []);
  const startEditing = useCallback(() => {
    uploadCacheRef.current.clear();
    imagesRef.current = [];
    setImages([]);
    setDraft(pr.description);
    setError(null);
    setIsEditing(true);
  }, [pr.description]);

  return (
    <div className="border-glass-border bg-bg-1 overflow-hidden rounded-lg border">
      <div className="border-glass-border/50 flex items-center gap-2.5 border-b px-3.5 py-2.5">
        <span className="text-ink-0 text-[13px] font-medium">Description</span>
        <div className="flex-1" />
        <span className="text-ink-3 text-[11.5px]">by {pr.createdBy.displayName}</span>
        {canEdit && !isEditing && <Button type="button" variant="ghost" size="sm" icon={<Edit3 className="h-3.5 w-3.5" />} onClick={startEditing}>Edit</Button>}
      </div>
      <div className="p-4">
        {isEditing ? <div className="space-y-3">
          <Textarea ref={textareaRef} value={draft} onChange={(event) => { if (!saveInProgressRef.current) setDraft(event.target.value); }} onPaste={handlePaste} onDrop={handleDrop} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === 'file')) event.preventDefault(); }} onKeyDown={handleKeyDown} rows={10} className="min-h-56 font-mono text-xs" placeholder="Describe the pull request..." disabled={controlsLocked} />
          <input ref={inputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={handleFiles} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" icon={<Image className="h-3.5 w-3.5" />} onClick={() => { if (!saveInProgressRef.current) inputRef.current?.click(); }} disabled={controlsLocked}>{uploadAttachment.isPending ? 'Uploading...' : 'Add image/GIF'}</Button>
            <div className="flex-1" />
            <Button type="button" variant="ghost" size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={cancel} disabled={controlsLocked}>Cancel</Button>
            <Button type="button" variant="primary" size="sm" icon={isSaving || updateDescription.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} onClick={() => void save()} disabled={controlsLocked}>Save <Kbd shortcut="cmd+enter" /></Button>
          </div>
          {previewDraft.trim() && <div className="border-glass-border/60 bg-bg-2/60 rounded-md border p-3"><div className="text-ink-4 mb-2 text-[10px] font-medium tracking-wide uppercase">Preview</div><AzureMarkdownContent markdown={previewDraft} providerId={providerId} className="text-ink-1 text-sm" imageClassName="max-h-[360px] object-contain" enableImageModal allowBlobImages mentionDisplayNames={mentionDisplayNames} /></div>}
          {error && <p className="text-xs text-red-400">{error}</p>}
          {images.length > 0 && <div className="flex flex-wrap gap-1.5">{images.map((image, index) => <div key={`${image.filename ?? 'img'}-${index}`} className="relative">{imagePreviewUrls[index] ? <img src={imagePreviewUrls[index]} alt={image.filename || 'Attached image'} title={image.sizeBytes ? formatBytes(image.sizeBytes) : undefined} className="h-8 w-8 rounded border border-white/10 object-cover" /> : <div title={image.filename} className="text-ink-3 border-stroke-1 flex h-8 max-w-36 items-center rounded border px-1.5 text-[9px]"><span className="truncate">{image.filename ?? image.mimeType}</span></div>}{image.sizeBytes && <span className="absolute right-0 bottom-0 left-0 rounded-b bg-black/70 px-0.5 text-center font-mono text-[7px] leading-3 text-white">{formatBytes(image.sizeBytes)}</span>}<button type="button" aria-label={`Remove ${image.filename ?? 'attached image'}`} onClick={() => removeImage(index)} disabled={controlsLocked} className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/60 text-white opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-30"><X className="h-2.5 w-2.5" /></button></div>)}</div>}
        </div> : pr.description.trim() ? <AzureMarkdownContent markdown={pr.description} providerId={providerId} className="text-ink-1 text-sm" imageClassName="max-h-[520px] object-contain" enableImageModal mentionDisplayNames={mentionDisplayNames} /> : <p className="text-ink-3 text-sm italic">No description</p>}
        <VideoGifConverter file={videoFile} onAttach={stageImage} onClose={() => setVideoFile(null)} />
      </div>
    </div>
  );
});

function PrFilePreviewPane({
  projectId,
  prId,
  filePath,
  lineStart,
  lineEnd,
  scrollToLine,
  threads,
  files,
  providerId,
  mentionDisplayNames,
  mentionOptions,
  onSearchMentions,
  onUploadImage,
  onClose,
  repoInfo,
  readOnly,
}: {
  projectId: string;
  prId: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  scrollToLine: number;
  threads: AzureDevOpsCommentThread[];
  files: AzureDevOpsFileChange[];
  providerId?: string;
  mentionDisplayNames: MentionDisplayNames;
  mentionOptions: MentionOption[];
  onSearchMentions?: (query: string) => Promise<MentionOption[]>;
  onUploadImage?: (image: PromptImagePart, fileName: string) => Promise<string>;
  onClose: () => void;
  repoInfo?: PullRequestRepoInfo;
  readOnly: boolean;
}) {
  const { data: headContent = '', isLoading: isHeadLoading } =
    usePullRequestFileContent(projectId, prId, filePath, 'head', repoInfo);
  const { data: baseContent = '', isLoading: isBaseLoading } =
    usePullRequestFileContent(projectId, prId, filePath, 'base', repoInfo);

  const file = useMemo<DiffFile>(() => {
    const change = files.find(
      (candidate) =>
        candidate.path === filePath ||
        candidate.path === stripLeadingSlash(filePath),
    );
    return {
      path: filePath,
      status: change ? normalizeAzureChangeType(change.changeType) : 'modified',
      originalPath: change?.originalPath,
    };
  }, [filePath, files]);

  const fileThreads = useMemo(
    () => convertPrThreadsForFile(threads, filePath),
    [threads, filePath],
  );

  return (
    <div className="border-glass-border bg-bg-1 flex h-full min-h-0 flex-col overflow-hidden rounded-lg border">
      <div className="border-glass-border/60 flex items-center gap-2 border-b px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-ink-0 truncate text-xs font-medium">
            File diff preview
          </div>
          <div className="text-ink-3 truncate font-mono text-[11px]">
            {filePath}:
            {lineStart === lineEnd ? lineStart : `${lineStart}-${lineEnd}`}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={<X className="h-3.5 w-3.5" />}
          onClick={onClose}
        >
          Close
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <FileDiffContent
          file={file}
          oldContent={baseContent}
          newContent={headContent}
          isLoading={isHeadLoading || isBaseLoading}
          headerClassName="hidden"
          threads={fileThreads}
          renderThread={(thread) => (
            <PrInlineCommentThread
              thread={thread}
              projectId={projectId}
              prId={prId}
              providerId={providerId}
              mentionDisplayNames={mentionDisplayNames}
              mentionOptions={mentionOptions}
              onSearchMentions={onSearchMentions}
              onUploadImage={onUploadImage}
              repoInfo={repoInfo}
              readOnly={readOnly}
            />
          )}
          scrollToLine={scrollToLine}
        />
      </div>
    </div>
  );
}

function stripLeadingSlash(value: string) {
  return value.replace(/^\/+/, '');
}
