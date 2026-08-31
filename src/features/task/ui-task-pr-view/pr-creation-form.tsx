/* eslint-disable sort-imports */
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Eye, Image, Pencil, Sparkles, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';


import {
  isVideoFile,
  VideoGifConverter,
} from '@/features/common/ui-video-gif-converter';
import {
  useAddPrFileComments,
  useCreatePullRequest,
} from '@/hooks/use-create-pull-request';
import { AzureMarkdownContent } from '@/features/common/ui-azure-html-content';
import { descriptionPreviewMarkdown } from '@/lib/description-preview-markdown';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useGeneratePrDescription } from '@/hooks/use-generate-pr-description';
import { useImagePreviewUrls } from '@/hooks/use-image-preview-urls';
import { useGenerateSummary, useTaskSummary } from '@/hooks/use-task-summary';
import {
  getAttachmentFileName,
  getAzureAttachmentPayload,
  MAX_FILE_SIZE,
  MAX_PR_DRAFT_IMAGES,
  processImageFile,
} from '@/lib/image-utils';
import { type PrDraftImage, usePrDraftImages } from './use-pr-draft-images';
import { useWorktreeCommits } from '@/hooks/use-worktree-diff';
import { api } from '@/lib/api';
import { Button } from '@/common/ui/button';
import { Checkbox } from '@/common/ui/checkbox';
import type { FileAnnotation } from '@/lib/api';
import { formatBytes } from '@/lib/format-bytes';
import {
  markdownImagePlaceholderPattern,
  replaceMarkdownImageUrl,
  stripUnresolvedImagePlaceholders,
} from '@/lib/markdown-image-size';
import { Input } from '@/common/ui/input';
import { invalidateFeedResource } from '@/cache/feed-cache';
import { Kbd } from '@/common/ui/kbd';
import type { PromptImagePart } from '@shared/agent-backend-types';
import { Separator } from '@/common/ui/separator';
import { Textarea } from '@/common/ui/textarea';
import { useAiSkillSlotsSetting } from '@/hooks/use-settings';
import { useBackgroundJobsStore } from '@/stores/background-jobs';
import { useCommands } from '@/common/hooks/use-commands';
import { usePrDraftState } from '@/stores/navigation';
import { useProject } from '@/hooks/use-projects';
import { useTask } from '@/hooks/use-tasks';
import { useToastStore } from '@/stores/toasts';
import { useWorktreeStatus } from '@/hooks/use-worktree-diff';



function placeholderPattern(placeholderMarkdown: string) {
  return markdownImagePlaceholderPattern(placeholderMarkdown);
}

/**
 * Fire-and-forget diagnostics for the two-phase PR image upload.
 *
 * Deliberately defensive: this runs on the critical PR-creation path, so a
 * missing `api.debug` (older mocks, non-Electron contexts) or a rejected
 * invoke must never take the user's PR down with it.
 */
function debugLog(params: { message: string; data?: unknown }) {
  try {
    void api.debug?.log?.({ scope: '[pr-create]', ...params })?.catch?.(() => {});
  } catch {
    // Diagnostics only.
  }
}

async function readFileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export const PrImageAttachments = memo(function PrImageAttachments({
  images,
  previewUrls,
  onRemove,
}: {
  images: PrDraftImage[];
  previewUrls: (string | undefined)[];
  onRemove: (token: string) => void;
}) {
  if (images.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {images.map((image, index) => (
        <div key={image.token} className="group relative">
          {image.missing ? (
            <div
              title={`${image.filename} is no longer on disk`}
              className="text-status-fail border-status-fail/40 flex h-10 max-w-36 items-center rounded border border-dashed px-1.5 text-[9px]"
            >
              <span className="truncate">Missing: {image.filename}</span>
            </div>
          ) : previewUrls[index] ? (
            <img
              src={previewUrls[index]}
              alt={image.filename || 'Attached image'}
              title={image.sizeBytes ? formatBytes(image.sizeBytes) : undefined}
              className="h-10 w-10 rounded border border-white/10 object-cover"
            />
          ) : (
            <div
              title={image.filename}
              className="text-ink-3 border-stroke-1 flex h-10 max-w-36 items-center rounded border px-1.5 text-[9px]"
            >
              <span className="truncate">{image.filename ?? image.mimeType}</span>
            </div>
          )}
          {image.sizeBytes && (
            <span className="absolute right-0 bottom-0 left-0 bg-scrim-strong text-chrome-fg rounded-b px-0.5 text-center font-mono text-[8px] leading-3">
              {formatBytes(image.sizeBytes)}
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemove(image.token)}
            className="bg-scrim-strong text-chrome-fg absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
            aria-label={`Remove ${image.filename ?? 'attached image'}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
});

export function PrCreationForm({
  taskId,
  projectId,
  onSuccess,
  onCancel,
}: {
  taskId: string;
  projectId: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const { data: task } = useTask(taskId);
  const { data: project } = useProject(projectId);

  // Derive values from task and project
  const branchName = task?.branchName ?? '';
  const workItemId = task?.workItemIds?.[0] ?? null;
  const targetBranch = task?.sourceBranch ?? project?.defaultBranch ?? 'main';
  const repoProviderId = project?.repoProviderId ?? '';
  const repoProjectId = project?.repoProjectId ?? '';
  const repoId = project?.repoId ?? '';
  const { prDraft, setPrDraft, clearPrDraft } = usePrDraftState(taskId);
  const [title, setTitle] = useState(prDraft?.title ?? '');
  const [description, setDescription] = useState(prDraft?.description ?? '');
  const [isDraft, setIsDraft] = useState(true);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [uncheckedAnnotations, setUncheckedAnnotations] = useState<
    Record<string, boolean>
  >({});
  const [commitUnstaged, setCommitUnstaged] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);
  const titleRef = useRef(title);
  const addToast = useToastStore((s) => s.addToast);
  const queryClient = useQueryClient();

  const {
    images: stagedImages,
    isHydrating,
    addImage,
    removeImage,
    deleteImageFiles,
  } = usePrDraftImages({ taskId, worktreePath: task?.worktreePath ?? null });
  const stagedImagePreviewUrls = useImagePreviewUrls(stagedImages);

  const { data: worktreeStatus } = useWorktreeStatus(taskId);
  const hasUncommittedChanges = worktreeStatus?.hasUncommittedChanges ?? false;

  // The description generator is diff-driven, so it has nothing to work from
  // until the branch has at least one commit.
  const { data: worktreeCommits } = useWorktreeCommits(taskId);
  const hasCommits = (worktreeCommits?.length ?? 0) > 0;

  const debouncedDescription = useDebouncedValue(description, 300);
  const previewMarkdown = useMemo(
    () =>
      descriptionPreviewMarkdown(
        debouncedDescription,
        stagedImages,
        stagedImagePreviewUrls,
      ),
    [debouncedDescription, stagedImages, stagedImagePreviewUrls],
  );

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      titleRef.current = newTitle;
      setTitle(newTitle);
      setPrDraft({ title: newTitle, description });
    },
    [description, setPrDraft],
  );

  const updateDescription = useCallback(
    (updater: string | ((current: string) => string)) => {
      setDescription((current) => {
        const next = typeof updater === 'function' ? updater(current) : updater;
        setPrDraft({ title: titleRef.current, description: next });
        return next;
      });
    },
    [setPrDraft],
  );

  const handleDescriptionChange = useCallback(
    (newDescription: string) => {
      updateDescription(newDescription);
    },
    [updateDescription],
  );

  const insertDescriptionMarkdown = useCallback(
    (markdown: string) => {
      const textarea = descriptionRef.current;
      if (!textarea) {
        updateDescription(
          (current) => `${current}${current ? '\n\n' : ''}${markdown}`,
        );
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      updateDescription(
        (current) =>
          `${current.slice(0, start)}${markdown}${current.slice(end)}`,
      );
      requestAnimationFrame(() => {
        textarea.focus();
        const cursor = start + markdown.length;
        textarea.setSelectionRange(cursor, cursor);
      });
    },
    [updateDescription],
  );

  const stageDescriptionImage = useCallback(
    async (image: PromptImagePart) => {
      // `stagedImages` reads empty until hydration finishes, so the cap below
      // would not be enforced against images already in the draft.
      if (isHydrating) return;
      if (stagedImages.length >= MAX_PR_DRAFT_IMAGES) {
        addToast({
          type: 'error',
          message: `Only ${MAX_PR_DRAFT_IMAGES} images or GIFs can be attached.`,
        });
        return;
      }

      try {
        // Persist first: inserting a placeholder whose file failed to write
        // would leave a permanently broken reference in the draft.
        const placeholderMarkdown = await addImage(image);
        if (!placeholderMarkdown) {
          addToast({
            type: 'error',
            message: 'Cannot attach images to a task without a worktree.',
          });
          return;
        }
        insertDescriptionMarkdown(placeholderMarkdown);
      } catch (error) {
        addToast({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Failed to save image',
        });
      }
    },
    [
      addImage,
      addToast,
      insertDescriptionMarkdown,
      isHydrating,
      stagedImages.length,
    ],
  );

  const removeStagedImage = useCallback(
    (token: string) => {
      const image = stagedImages.find((entry) => entry.token === token);
      if (!image) return;
      const pattern = placeholderPattern(image.placeholderMarkdown);
      updateDescription((current) =>
        pattern ? current.replace(pattern, '') : current,
      );
      removeImage(token);
    },
    [removeImage, stagedImages, updateDescription],
  );

  const stageImageFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith('image/'));
      const nextVideoFile = files.find(isVideoFile);
      const unsupported = files.filter(
        (file) => !file.type.startsWith('image/') && !isVideoFile(file),
      );
      if (unsupported.length > 0) {
        addToast({
          type: 'error',
          message: `Not an image or video, skipped: ${unsupported
            .map((file) => file.name)
            .join(', ')}`,
        });
      }
      if (imageFiles.length === 0 && !nextVideoFile) return;

      if (isHydrating) return;
      const allowed = MAX_PR_DRAFT_IMAGES - stagedImages.length;
      if (allowed <= 0) {
        addToast({
          type: 'error',
          message: `Attachment limit reached (${MAX_PR_DRAFT_IMAGES}). Remove an image before adding another.`,
        });
        return;
      }
      if (imageFiles.length > allowed) {
        addToast({
          type: 'error',
          message: `Only ${allowed} more attachment(s) fit (max ${MAX_PR_DRAFT_IMAGES}); skipped: ${imageFiles
            .slice(allowed)
            .map((file) => file.name)
            .join(', ')}`,
        });
      }

      try {
        await Promise.all(
          imageFiles.slice(0, allowed).map(async (file) => {
            const gifData =
              file.type === 'image/gif' && file.size <= MAX_FILE_SIZE
                ? await readFileAsBase64(file)
                : undefined;
            await processImageFile(
              file,
              (image) =>
                stageDescriptionImage(
                  gifData
                    ? {
                        ...image,
                        storageData: gifData,
                        storageMimeType: 'image/gif',
                      }
                    : image,
                ),
              (message) => addToast({ type: 'error', message }),
            );
          }),
        );
        if (nextVideoFile) {
          if (allowed > imageFiles.length) {
            setVideoFile(nextVideoFile);
          } else {
            addToast({
              type: 'error',
              message: `No attachment slot left for "${nextVideoFile.name}" (max ${MAX_PR_DRAFT_IMAGES}).`,
            });
          }
        }
      } catch (error) {
        addToast({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Failed to stage image',
        });
      }
    },
    [addToast, isHydrating, stageDescriptionImage, stagedImages.length],
  );

  const handleImageSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      await stageImageFiles(Array.from(event.target.files ?? []));
      event.target.value = '';
    },
    [stageImageFiles],
  );

  const handleDescriptionPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (
        files.some(
          (file) => file.type.startsWith('image/') || isVideoFile(file),
        )
      ) {
        event.preventDefault();
        void stageImageFiles(files);
      }
    },
    [stageImageFiles],
  );

  const handleDescriptionDrop = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.dataTransfer.files);
      if (
        files.some(
          (file) => file.type.startsWith('image/') || isVideoFile(file),
        )
      ) {
        event.preventDefault();
        void stageImageFiles(files);
      }
    },
    [stageImageFiles],
  );

  const handleDescriptionDragOver = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
      }
    },
    [],
  );

  const generatePrDescription = useGeneratePrDescription();
  const createPr = useCreatePullRequest();

  // The ✨ button now generates the PR description from the diff rather than
  // from the task summary. Annotation comments still come from a summary, so
  // generating one keeps its own (secondary) affordance below -- without it
  // `tasks:summary:generate` would have no caller left in the app.
  const { data: existingSummary } = useTaskSummary(taskId);
  const generateSummary = useGenerateSummary();
  // Derived rather than mirrored into state: the summary arrives asynchronously,
  // and copying it in an effect would cascade an extra render. Only the
  // per-annotation checkbox overrides are stateful.
  const annotationStates = useMemo(
    () =>
      (existingSummary?.annotations ?? []).map((annotation) => ({
        annotation,
        checked:
          uncheckedAnnotations[
            `${annotation.filePath}:${annotation.lineNumber}`
          ] !== true,
      })),
    [existingSummary?.annotations, uncheckedAnnotations],
  );
  const addComments = useAddPrFileComments();

  const addRunningJob = useBackgroundJobsStore((s) => s.addRunningJob);
  const markJobSucceeded = useBackgroundJobsStore((s) => s.markJobSucceeded);
  const markJobFailed = useBackgroundJobsStore((s) => s.markJobFailed);
  // Check if PR description AI slot is configured (allows empty title/description)
  const { data: globalSlots } = useAiSkillSlotsSetting();
  const canAutoGeneratePrDescription = !!(
    project?.aiSkillSlots?.['pr-description'] || globalSlots?.['pr-description']
  );

  async function handleGenerateDescription() {
    // Placeholders are re-appended from `stagedImages` below; running before
    // hydration would orphan every persisted image.
    if (isHydrating) return;
    setSummaryError(null);

    // A draft can represent days of writing, so never clobber it silently.
    const hasContent = !!title.trim() || !!description.trim();
    if (
      hasContent &&
      !window.confirm(
        'Replace the current PR title and description with an AI-generated one?',
      )
    ) {
      return;
    }

    try {
      const generated = await generatePrDescription.mutateAsync(taskId);
      // Image placeholders are anchored in the description that is about to be
      // replaced, so re-append them rather than orphaning the staged files.
      const placeholders = stagedImages
        .map((image) => image.placeholderMarkdown)
        .join('\n\n');
      const nextDescription = placeholders
        ? `${generated.description}\n\n${placeholders}`
        : generated.description;

      titleRef.current = generated.title;
      setTitle(generated.title);
      setDescription(nextDescription);
      setPrDraft({ title: generated.title, description: nextDescription });
    } catch (err) {
      setSummaryError(
        err instanceof Error
          ? err.message
          : 'Failed to generate PR description',
      );
    }
  }

  function handleCreate() {
    if (submittedRef.current) return;
    // Draft images load from disk asynchronously. Submitting mid-hydration
    // would see an empty list, ship raw `jc-image://` links to the host, and
    // then delete the backing files on success -- unrecoverable image loss.
    if (isHydrating) return;
    submittedRef.current = true;
    const descriptionToCreate = description;
    // A ref whose file has gone carries no bytes; uploading it would post a
    // 0-byte attachment and rewrite the placeholder to point at it.
    const imagesToUpload = stagedImages.filter(
      (image) => !image.missing && !!image.data,
    );

    // Collect checked annotations before closing
    const checkedAnnotations = annotationStates
      .filter((a) => a.checked)
      .map((a) => ({
        filePath: a.annotation.filePath,
        line: a.annotation.lineNumber,
        content: `jean-claude: ${a.annotation.explanation}`,
      }));

    const displayTitle = title.trim() || 'AI-generated PR';
    // Strip unconditionally rather than only for known images: a placeholder
    // left by a pruned or unreadable ref would otherwise be posted verbatim.
    const descriptionWithoutImagePlaceholders = stripUnresolvedImagePlaceholders(
      imagesToUpload.reduce((current, image) => {
        const pattern = placeholderPattern(image.placeholderMarkdown);
        return pattern ? current.replace(pattern, '') : current;
      }, descriptionToCreate),
    ).text;
    debugLog({
      message: 'submit',
      data: {
        taskId,
        stagedImages: imagesToUpload.map((image) => ({
          filename: image.filename,
          mimeType: image.mimeType,
          storageMimeType: image.storageMimeType,
          dataBytes: image.data?.length ?? 0,
          storageBytes: image.storageData?.length ?? 0,
          // The stripped length below already reveals whether each placeholder
          // matched; logging the markdown itself would leak user alt text.
          placeholderLength: image.placeholderMarkdown.length,
        })),
        descriptionLength: descriptionToCreate.length,
        strippedLength: descriptionWithoutImagePlaceholders.length,
        repoProviderId,
        repoProjectId,
        repoId,
      },
    });

    // 1. Create background job
    const jobId = addRunningJob({
      type: 'pr-creation',
      title: `Creating PR: ${displayTitle}`,
      taskId,
      projectId,
      details: {
        title: displayTitle,
        branchName,
      },
    });

    // 2. Close the form. The draft is deliberately NOT cleared here: creation
    // is fire-and-forget, so clearing now would destroy the user's writing on
    // any failure. It is cleared in the success branch below instead.
    onSuccess();

    // 3. Fire-and-forget PR creation (backend generates title/description if empty)
    void createPr
      .mutateAsync({
        taskId,
        title,
        description: descriptionWithoutImagePlaceholders,
        isDraft,
        commitUnstaged: hasUncommittedChanges ? commitUnstaged : undefined,
      })
      .then(async (result) => {
        let warningMessage = result.editorCloseWarning ?? null;
        // Only files that actually reached the host may be reclaimed; anything
        // that failed stays on disk so the draft remains retryable.
        const uploadedTokens: string[] = [];
        let attachmentPhaseFailed = false;

        if (imagesToUpload.length > 0) {
          const uploadFailures: string[] = [];
          try {
            // Read back what the server actually stored: the backend replaces
            // an empty description with an AI-generated one, and guessing which
            // case happened is what silently dropped images.
            //
            // This read must never block the uploads that follow. Failing here
            // and aborting would cost every attachment; falling back to the
            // local body only risks re-posting text we already authored.
            let serverDescription: string | null = null;
            try {
              const createdPullRequest = await api.azureDevOps.getPullRequest({
                providerId: repoProviderId,
                projectId: repoProjectId,
                repoId,
                pullRequestId: result.id,
              });
              serverDescription = createdPullRequest.description ?? '';
            } catch (readError) {
              debugLog({
                message: 'read-back FAILED, using local description',
                data: {
                  pullRequestId: result.id,
                  error: (readError instanceof Error
                    ? readError.message
                    : String(readError)
                  ).slice(0, 500),
                },
              });
            }

            // If the server kept our body, rebase onto the local copy so the
            // placeholders (and therefore the inline image positions) survive.
            // Azure round-trips descriptions through JSON and may normalize
            // line endings, so compare on normalized text.
            const normalize = (value: string) =>
              value.replace(/\r\n/g, '\n').trim();
            const serverKeptOurBody =
              serverDescription === null ||
              normalize(serverDescription) ===
                normalize(descriptionWithoutImagePlaceholders);
            let updatedDescription =
              serverKeptOurBody || serverDescription === null
                ? descriptionToCreate
                : serverDescription;

            debugLog({
              message: 'created',
              data: {
                pullRequestId: result.id,
                serverDescriptionLength: serverDescription?.length ?? null,
                serverKeptOurBody,
                readBackFailed: serverDescription === null,
                baseHasPlaceholders: updatedDescription.includes('jc-image://'),
              },
            });

            for (const image of imagesToUpload) {
              // AVIF storage bytes render broken in Azure DevOps; pick a
              // format the host actually serves (GIF kept for animation).
              try {
                const payload = await getAzureAttachmentPayload(image);
                const mimeType = payload.mimeType;
                const attachment =
                  await api.azureDevOps.uploadPullRequestAttachment({
                    providerId: repoProviderId,
                    projectId: repoProjectId,
                    repoId,
                    pullRequestId: result.id,
                    // Extension must match the actual bytes: the host serves
                    // attachments with a content type derived from it.
                    fileName: getAttachmentFileName(
                      image.filename || 'image.png',
                      mimeType,
                    ),
                    mimeType,
                    dataBase64: payload.dataBase64,
                  });
                const pattern = placeholderPattern(image.placeholderMarkdown);
                const replacement = replaceMarkdownImageUrl(
                  image.placeholderMarkdown,
                  attachment.url,
                );
                let matched = false;
                if (pattern && pattern.test(updatedDescription)) {
                  matched = true;
                  // Defensive: `.test` advanced lastIndex on this global
                  // regex. `String.replace` already resets it for global
                  // patterns, but reset explicitly so the invariant does not
                  // depend on that subtlety.
                  pattern.lastIndex = 0;
                  updatedDescription = updatedDescription.replace(
                    pattern,
                    replacement,
                  );
                } else {
                  updatedDescription = `${updatedDescription}${updatedDescription ? '\n\n' : ''}${replacement}`;
                }
                uploadedTokens.push(image.token);
                debugLog({
                  message: 'uploaded',
                  data: {
                    filename: image.filename,
                    uploadedMimeType: mimeType,
                    // The URL points at a private repo attachment; log only
                    // enough to confirm the upload returned something usable.
                    attachmentUrlLength: attachment.url.length,
                    placeholderMatched: matched,
                  },
                });
              } catch (uploadError) {
                // Keep going: already-uploaded images should still land in the
                // description instead of being discarded by one failure.
                console.error(
                  '[pr-creation] attachment upload failed',
                  { pullRequestId: result.id, fileName: image.filename },
                  uploadError,
                );
                const reason =
                  uploadError instanceof Error
                    ? uploadError.message
                    : String(uploadError);
                uploadFailures.push(
                  `${image.filename || 'image'} (${reason.slice(0, 120)})`,
                );
                const pattern = placeholderPattern(image.placeholderMarkdown);
                updatedDescription = pattern
                  ? updatedDescription.replace(pattern, '')
                  : updatedDescription;
              }
            }
            // A surviving placeholder would ship to Azure as a broken
            // `jc-image://` link. Strip it and say so rather than posting it.
            const stripped =
              stripUnresolvedImagePlaceholders(updatedDescription);
            if (stripped.removed > 0) {
              updatedDescription = stripped.text;
              const leftoverWarning = `${stripped.removed} image(s) could not be linked in the PR description and were removed.`;
              warningMessage = warningMessage
                ? `${warningMessage}\n${leftoverWarning}`
                : leftoverWarning;
              addToast({ type: 'error', message: leftoverWarning });
            }

            debugLog({
              message: 'patching description',
              data: {
                pullRequestId: result.id,
                length: updatedDescription.length,
                leftoverPlaceholders:
                  updatedDescription.includes('jc-image://'),
                imageMarkdownCount: (
                  updatedDescription.match(/!\[[^\]]*\]\(/g) ?? []
                ).length,
                uploadFailures,
              },
            });
            await api.azureDevOps.updatePullRequestDescription({
              providerId: repoProviderId,
              projectId: repoProjectId,
              repoId,
              pullRequestId: result.id,
              description: updatedDescription,
            });
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: ['pull-request', projectId, result.id],
              }),
              queryClient.invalidateQueries({
                queryKey: ['pull-requests', projectId],
              }),
              queryClient.invalidateQueries({
                queryKey: ['all-projects-pull-requests'],
              }),
              queryClient.invalidateQueries({ queryKey: ['tasks', taskId] }),
            ]);
            invalidateFeedResource(queryClient, 'pullRequests');

            if (uploadFailures.length > 0) {
              const partialWarning = `PR created, but ${uploadFailures.length} image(s) could not be uploaded: ${uploadFailures.join(', ')}`;
              warningMessage = warningMessage
                ? `${warningMessage}\n${partialWarning}`
                : partialWarning;
              addToast({ type: 'error', message: partialWarning });
            }
          } catch (error) {
            attachmentPhaseFailed = true;
            const rawDetail =
              error instanceof Error ? error.message : String(error);
            const detail =
              rawDetail.length > 200
                ? `${rawDetail.slice(0, 200)}…`
                : rawDetail;
            console.error(
              '[pr-creation] failed to attach description images',
              {
                pullRequestId: result.id,
                providerId: repoProviderId,
                repoProjectId,
                repoId,
                imageCount: imagesToUpload.length,
              },
              error,
            );
            debugLog({
              message: 'description update FAILED',
              data: { pullRequestId: result.id, error: rawDetail.slice(0, 500) },
            });
            const detailedWarning = `PR created, but the description could not be updated with attachments: ${detail}`;
            warningMessage = warningMessage
              ? `${warningMessage}\n${detailedWarning}`
              : detailedWarning;
            addToast({ type: 'error', message: detailedWarning });
          }
        }

        // Post comments for checked annotations
        if (checkedAnnotations.length > 0) {
          try {
            await addComments.mutateAsync({
              providerId: repoProviderId,
              projectId: repoProjectId,
              repoId,
              pullRequestId: result.id,
              comments: checkedAnnotations,
            });
          } catch {
            // Comments are best-effort; don't fail the job
            addToast({
              type: 'error',
              message: 'PR created, but some comments could not be posted',
            });
          }
        }

        // Reclaim only what actually landed on the host.
        await deleteImageFiles(uploadedTokens);

        // Keep the draft whenever an image did not make it: the PR body is
        // missing it, and the draft holds the only remaining copy.
        const allImagesLanded =
          !attachmentPhaseFailed &&
          uploadedTokens.length === imagesToUpload.length &&
          stagedImages.every((image) => !image.missing);
        if (allImagesLanded) {
          clearPrDraft();
        } else {
          addToast({
            type: 'error',
            message:
              'Your PR draft was kept because some images could not be attached.',
          });
        }

        markJobSucceeded(jobId, {
          warningMessage,
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to create PR';
        // Draft intentionally left intact so the user can retry.
        submittedRef.current = false;
        markJobFailed(jobId, message);
        addToast({ type: 'error', message });
      });
  }

  function toggleAnnotation(annotation: FileAnnotation) {
    const key = `${annotation.filePath}:${annotation.lineNumber}`;
    setUncheckedAnnotations((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // Allow submit when title is provided, OR when AI generation is configured.
  // Block submit if uncommitted changes exist and the checkbox is unchecked,
  // or while draft images are still loading from disk (submitting then would
  // publish unresolved image placeholders and delete the files).
  const canSubmit =
    (!!title.trim() || canAutoGeneratePrDescription) &&
    (!hasUncommittedChanges || commitUnstaged) &&
    !isHydrating;

  useCommands('pr-creation-form', [
    canSubmit && {
      label: 'Submit PR',
      shortcut: 'cmd+enter',
      handler: () => {
        handleCreate();
      },
      hideInCommandPalette: true,
    },
  ]);

  return (
    // The parent PR view owns the header and the scroll container, so this
    // flows inline rather than nesting a second scrollable region.
    <div className="flex flex-col">
      <div>
        <div className="space-y-4">
          {/* AI hint */}
          {canAutoGeneratePrDescription &&
            !title.trim() &&
            !description.trim() && (
              <div className="text-acc-ink flex items-center gap-2 bg-status-azure/10 rounded-md px-3 py-2 text-xs">
                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                Title and description will be generated by AI when left empty
              </div>
            )}

          {/* Title */}
          <div>
            <label
              htmlFor="pr-title"
              className="text-ink-1 mb-1.5 block text-sm font-medium"
            >
              Title
            </label>
            <Input
              id="pr-title"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder={
                canAutoGeneratePrDescription
                  ? 'Leave empty for AI generation...'
                  : 'Enter PR title...'
              }
              autoComplete="off"
            />
          </div>

          {/* Description with Generate button */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label
                htmlFor="pr-description"
                className="text-ink-1 text-sm font-medium"
              >
                Description
              </label>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  onClick={() => setIsPreviewing((current) => !current)}
                  variant="secondary"
                  size="sm"
                  icon={isPreviewing ? <Pencil /> : <Eye />}
                >
                  {isPreviewing ? 'Edit' : 'Preview'}
                </Button>
                <Button
                  type="button"
                  onClick={handleGenerateDescription}
                  disabled={
                    generatePrDescription.isPending ||
                    !hasCommits ||
                    isHydrating
                  }
                  loading={generatePrDescription.isPending}
                  title={
                    hasCommits
                      ? 'Generate a title and description from the branch diff'
                      : 'No commits yet'
                  }
                  variant="secondary"
                  size="sm"
                  icon={
                    !generatePrDescription.isPending ? <Sparkles /> : undefined
                  }
                >
                  {generatePrDescription.isPending
                    ? 'Generating...'
                    : 'Generate'}
                </Button>
              </div>
            </div>
            {isPreviewing ? (
              <div className="border-glass-border bg-bg-2/60 min-h-[12rem] rounded-md border p-3">
                {previewMarkdown.trim() ? (
                  <AzureMarkdownContent
                    markdown={previewMarkdown}
                    providerId={repoProviderId}
                    className="text-ink-1 text-sm"
                    imageClassName="max-h-[360px] object-contain"
                    enableImageModal
                    allowBlobImages
                  />
                ) : (
                  <p className="text-ink-3 text-sm italic">Nothing to preview</p>
                )}
              </div>
            ) : (
              <Textarea
                ref={descriptionRef}
                id="pr-description"
                value={description}
                onChange={(e) => handleDescriptionChange(e.target.value)}
                onPaste={handleDescriptionPaste}
                onDrop={handleDescriptionDrop}
                onDragOver={handleDescriptionDragOver}
                placeholder={
                  canAutoGeneratePrDescription
                    ? 'Leave empty for AI generation...'
                    : 'Enter PR description...'
                }
                rows={8}
                autoComplete="off"
              />
            )}
            <PrImageAttachments
              images={stagedImages}
              previewUrls={stagedImagePreviewUrls}
              onRemove={removeStagedImage}
            />
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={handleImageSelection}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              icon={<Image className="h-3.5 w-3.5" />}
              onClick={() => imageInputRef.current?.click()}
            >
              Add image/GIF
            </Button>
          </div>

          {/* Inline review comments come from a task summary. Without this
              button nothing in the app can generate one any more, so the
              annotation feature would be permanently unreachable. */}
          {annotationStates.length === 0 && hasCommits && (
            <Button
              type="button"
              onClick={() => {
                generateSummary.mutate(taskId);
              }}
              disabled={generateSummary.isPending}
              loading={generateSummary.isPending}
              variant="secondary"
              size="sm"
            >
              {generateSummary.isPending
                ? 'Generating summary...'
                : 'Suggest inline comments'}
            </Button>
          )}

          {/* Annotations checklist (only shown after summary) */}
          {annotationStates.length > 0 && (
            <div>
              <label className="text-ink-1 mb-2 block text-sm font-medium">
                Comments to Post
              </label>
              <div className="bg-bg-1/50 border-glass-border max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {annotationStates.map((item) => (
                  <div
                    key={`${item.annotation.filePath}:${item.annotation.lineNumber}`}
                    className="hover:bg-glass-medium/50 flex cursor-pointer items-start gap-2 rounded p-1.5 transition-colors"
                  >
                    <Checkbox
                      size="sm"
                      checked={item.checked}
                      onChange={() => toggleAnnotation(item.annotation)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-ink-2 truncate font-mono text-xs">
                        {item.annotation.filePath}:{item.annotation.lineNumber}
                      </div>
                      <div className="text-ink-3 mt-0.5 line-clamp-2 text-xs">
                        {item.annotation.explanation}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Branch info */}
          <div className="text-ink-3 text-xs">
            <span className="font-mono">{branchName}</span>
            <span className="mx-2">&rarr;</span>
            <span className="font-mono">{targetBranch}</span>
          </div>

          {/* Checkboxes */}
          <div className="flex flex-col gap-3">
            <Checkbox
              checked={isDraft}
              onChange={setIsDraft}
              label="Create as draft"
            />

            {hasUncommittedChanges && (
              <Checkbox
                checked={commitUnstaged}
                onChange={setCommitUnstaged}
                label="Commit unstaged changes before creating PR"
              />
            )}
          </div>

          {/* Work item reference */}
          {workItemId && (
            <div className="text-ink-3 text-xs">
              Linked to work item AB#{workItemId}
            </div>
          )}

          {/* Summary generation error */}
          {summaryError && (
            <div className="text-status-fail bg-status-fail/50 rounded-md px-3 py-2 text-sm">
              {summaryError}
            </div>
          )}
        </div>
      </div>

      {/* Footer with buttons */}
      <Separator className="my-4" />
      <VideoGifConverter
        file={videoFile}
        onAttach={stageDescriptionImage}
        onClose={() => setVideoFile(null)}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          onClick={onCancel}
          variant="secondary"
          className="flex-1"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleCreate}
          disabled={!canSubmit}
          variant="primary"
          className="flex-1"
        >
          <span className="flex items-center gap-1.5">
            Create PR <Kbd shortcut="cmd+enter" />
          </span>
        </Button>
      </div>
    </div>
  );
}
