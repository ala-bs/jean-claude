import { useCallback, useMemo } from 'react';

import type {
  AzureDevOpsCommentThread,
  AzureDevOpsFileChange,
} from '@/lib/api';
import {
  convertPrThreadsForFile,
  PrInlineCommentThread,
} from '../ui-pr-inline-comment-thread';
import {
  FileDiffContent,
  normalizeAzureChangeType,
} from '@/features/common/ui-file-diff';
import type { ReviewComment, ReviewPresetId } from '@/stores/review-comments';
import type { DiffFile } from '@/features/common/ui-file-diff';
import type { LineRange } from '@/features/agent/ui-diff-view';
import type { MentionDisplayNames } from '@/lib/azure-devops-mentions';
import type { MentionOption } from '@/common/ui/mention-textarea';
import { PrCommentForm } from '../ui-pr-comment-form';
import type { PromptImagePart } from '@shared/agent-backend-types';
import type { PullRequestRepoInfo } from '@/hooks/use-pull-requests';
import { usePrFileDraftActions } from '@/stores/pr-comment-drafts';


export function PrDiffView({
  file,
  baseContent,
  headContent,
  isLoadingContent,
  threads,
  projectId,
  prId,
  providerId,
  repoInfo,
  onAddFileComment,
  onUploadImage,
  isAddingComment,
  mentionDisplayNames,
  mentionOptions = [],
  onSearchMentions,
  readOnly = false,
  submitLabel,
  reviewComments,
  onAddReviewComment,
  onDeleteReviewComment,
  onEditReviewComment,
  onResolveReviewComment,
  defaultReviewCommentFormLineRanges,
  getReviewCommentDraftBody,
  onReviewCommentDraftBodyChange,
}: {
  file: AzureDevOpsFileChange;
  baseContent: string;
  headContent: string;
  isLoadingContent: boolean;
  threads: AzureDevOpsCommentThread[];
  projectId: string;
  prId: number;
  providerId?: string;
  repoInfo?: PullRequestRepoInfo;
  onAddFileComment?: (params: {
    filePath: string;
    line: number;
    lineEnd?: number;
    content: string;
  }) => void;
  onUploadImage?: (image: PromptImagePart, fileName: string) => Promise<string>;
  isAddingComment?: boolean;
  mentionDisplayNames?: MentionDisplayNames;
  mentionOptions?: MentionOption[];
  onSearchMentions?: (query: string) => Promise<MentionOption[]>;
  readOnly?: boolean;
  submitLabel?: string;
  reviewComments?: ReviewComment[];
  onAddReviewComment?: (params: {
    filePath: string;
    lineStart: number;
    lineEnd?: number;
    selectedText?: string;
    body: string;
    presets: ReviewPresetId[];
    images?: PromptImagePart[];
  }) => void;
  onDeleteReviewComment?: (commentId: string) => void;
  onEditReviewComment?: (
    commentId: string,
    newBody: string,
    newImages: PromptImagePart[],
  ) => void;
  onResolveReviewComment?: (commentId: string) => void;
  defaultReviewCommentFormLineRanges?: LineRange[];
  getReviewCommentDraftBody?: (lineStart: number, lineEnd?: number) => string;
  onReviewCommentDraftBodyChange?: (
    body: string,
    lineStart: number,
    lineEnd?: number,
  ) => void;
}) {
  const { setDraft, clearDraft, getBody, getAllDrafts } = usePrFileDraftActions(
    prId,
    file.path,
  );

  // Convert to unified DiffFile type
  const diffFile: DiffFile = useMemo(
    () => ({
      path: file.path,
      status: normalizeAzureChangeType(file.changeType),
      originalPath: file.originalPath,
    }),
    [file.path, file.changeType, file.originalPath],
  );

  // Convert threads to unified format
  const fileThreads = useMemo(
    () => convertPrThreadsForFile(threads, file.path),
    [threads, file.path],
  );

  // Restore all draft ranges as open forms on mount.
  // Read imperatively — does NOT subscribe, so no re-render on body edits.
  // getAllDrafts is stable per file.path (keyed by fKey), so this only recomputes on file switch.
  const defaultCommentFormLineRanges: LineRange[] = useMemo(() => {
    const drafts = getAllDrafts();
    return Object.values(drafts).map((d) => ({
      start: d.lineStart,
      end: d.lineEnd ?? d.lineStart,
    }));
  }, [getAllDrafts]);

  const handleCommentFormClose = useCallback(
    (range: LineRange) => {
      const lineEnd = range.end !== range.start ? range.end : undefined;
      clearDraft(range.start, lineEnd);
    },
    [clearDraft],
  );

  const handleBodyChange = useCallback(
    (body: string, lineStart: number, lineEnd?: number) => {
      if (body.trim()) {
        setDraft({ body, lineStart, lineEnd });
      } else {
        clearDraft(lineStart, lineEnd);
      }
    },
    [setDraft, clearDraft],
  );

  // Clear draft for submitted range
  const handleAddFileComment = useCallback(
    (params: {
      filePath: string;
      line: number;
      lineEnd?: number;
      content: string;
    }) => {
      if (!onAddFileComment) return;
      clearDraft(params.line, params.lineEnd);
      onAddFileComment(params);
    },
    [onAddFileComment, clearDraft],
  );

  const renderCommentForm = useCallback(
    (props: {
      onSubmit: (content: string) => void;
      onCancel: () => void;
      lineStart: number;
      lineEnd?: number;
      isSubmitting?: boolean;
      placeholder?: string;
    }) => {
      const lineEnd = props.lineEnd !== undefined ? props.lineEnd : undefined;
      return (
        <PrCommentForm
          {...props}
          uploadImage={onUploadImage}
          mentionOptions={mentionOptions}
          onSearchMentions={onSearchMentions}
          initialBody={getBody(props.lineStart, lineEnd)}
          onBodyChange={(body) =>
            handleBodyChange(body, props.lineStart, lineEnd)
          }
          submitLabel={submitLabel}
        />
      );
    },
    [
      getBody,
      handleBodyChange,
      mentionOptions,
      onSearchMentions,
      onUploadImage,
      submitLabel,
    ],
  );

  const shouldKeepCommentFormRangeOnOpen = useCallback(
    (range: LineRange) => {
      const lineEnd = range.end !== range.start ? range.end : undefined;
      return Boolean(getBody(range.start, lineEnd).trim());
    },
    [getBody],
  );

  return (
    <FileDiffContent
      key={file.path}
      file={diffFile}
      oldContent={baseContent}
      newContent={headContent}
      isLoading={isLoadingContent}
      headerClassName="h-[40px] shrink-0"
      threads={fileThreads}
      renderThread={(thread) => (
        <PrInlineCommentThread
          thread={thread}
          projectId={projectId}
          prId={prId}
          providerId={providerId}
          repoInfo={repoInfo}
          mentionDisplayNames={mentionDisplayNames}
          mentionOptions={mentionOptions}
          onSearchMentions={onSearchMentions}
          onUploadImage={onUploadImage}
          readOnly={readOnly}
        />
      )}
      defaultCommentFormLineRanges={
        !readOnly && onAddFileComment && !onAddReviewComment
          ? defaultCommentFormLineRanges
          : (defaultReviewCommentFormLineRanges ?? undefined)
      }
      onCommentFormClose={
        !readOnly && onAddFileComment && !onAddReviewComment
          ? handleCommentFormClose
          : undefined
      }
      shouldKeepCommentFormRangeOnOpen={
        !readOnly && onAddFileComment && !onAddReviewComment
          ? shouldKeepCommentFormRangeOnOpen
          : undefined
      }
      onAddComment={!readOnly && onAddFileComment ? handleAddFileComment : undefined}
      isAddingComment={isAddingComment}
      renderCommentForm={
        !readOnly && onAddFileComment && !onAddReviewComment
          ? renderCommentForm
          : undefined
      }
      reviewComments={reviewComments}
      onAddReviewComment={!readOnly ? onAddReviewComment : undefined}
      onDeleteReviewComment={onDeleteReviewComment}
      onEditReviewComment={onEditReviewComment}
      onResolveReviewComment={onResolveReviewComment}
      getReviewCommentDraftBody={getReviewCommentDraftBody}
      onReviewCommentDraftBodyChange={onReviewCommentDraftBodyChange}
    />
  );
}
