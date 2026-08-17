import type {
  AzureDevOpsComment,
  AzureDevOpsCommentThread,
} from '@shared/azure-devops-types';

import {
  addPullRequestComment,
  addPullRequestFileComment,
  addThreadReply,
  getFileContentAtCommit,
  getPullRequestFileContent,
  getPullRequestThreads,
} from './azure-devops-service';
import {
  captureAgentMemoryEventSafe,
  isAgentMemoryCaptureEnabled,
  reportAgentMemoryCaptureFailure,
} from './agent-memory-capture-service';
import { ProjectRepository } from '../database/repositories';

type PullRequestRepositoryParams = {
  localProjectId?: string;
  providerId: string;
  projectId: string;
  repoId: string;
  pullRequestId: number;
};

type FileSelection = {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  selectedLines: string;
};

function captureFailure(
  source: 'pr-comment' | 'pr-reply',
  projectId: string,
  error: unknown,
) {
  try {
    reportAgentMemoryCaptureFailure({ source, projectId }, error);
  } catch {
    // Warning delivery cannot change a successful provider post.
  }
}

function scheduleCapture(
  source: 'pr-comment' | 'pr-reply',
  projectId: string,
  capture: () => Promise<void>,
) {
  void capture().catch((error) => captureFailure(source, projectId, error));
}

async function validateLocalProject(params: PullRequestRepositoryParams) {
  if (!params.localProjectId) return null;
  const project = await ProjectRepository.findById(params.localProjectId);
  if (
    !project ||
    project.repoProviderId !== params.providerId ||
    project.repoProjectId !== params.projectId ||
    project.repoId !== params.repoId
  ) {
    throw new Error('Local project does not match pull request repository');
  }
  return project.id;
}

function positiveSafeProviderId(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Provider returned invalid ${label}`);
  }
  return value;
}

function postedThreadComment(
  thread: AzureDevOpsCommentThread,
  submittedContent: string,
) {
  positiveSafeProviderId(thread.id, 'thread ID');
  const candidates = thread.comments.filter(
    (candidate) =>
      candidate.commentType === 'text' &&
      candidate.content === submittedContent,
  );
  if (candidates.length !== 1) {
    throw new Error('Provider did not return one unambiguous posted comment');
  }
  const comment = candidates[0];
  positiveSafeProviderId(comment.id, 'comment ID');
  return comment;
}

function providerThreadRange(thread: AzureDevOpsCommentThread) {
  const context = thread.threadContext;
  const filePath = context?.filePath;
  const lineStart = context?.rightFileStart?.line;
  const lineEnd = context?.rightFileEnd?.line ?? lineStart;
  if (
    !filePath ||
    !Number.isSafeInteger(lineStart) ||
    !Number.isSafeInteger(lineEnd) ||
    lineStart! < 1 ||
    lineEnd! < lineStart!
  ) {
    throw new Error('Provider did not return a safe file comment range');
  }
  return { filePath, lineStart: lineStart!, lineEnd: lineEnd! };
}

async function deriveFileSelection(
  params: PullRequestRepositoryParams,
  thread: AzureDevOpsCommentThread,
): Promise<FileSelection> {
  const range = providerThreadRange(thread);
  const originalCommitId = thread.threadContext?.originalCommitId?.trim();
  // Threads without iteration metadata intentionally fall back to current head.
  // Historical metadata always wins so later pushes cannot change captured lines.
  const content = originalCommitId
    ? await getFileContentAtCommit({
        providerId: params.providerId,
        projectId: params.projectId,
        repoId: params.repoId,
        commitId: originalCommitId,
        filePath: range.filePath,
        version: 'current',
      })
    : await getPullRequestFileContent({
        providerId: params.providerId,
        projectId: params.projectId,
        repoId: params.repoId,
        pullRequestId: params.pullRequestId,
        filePath: range.filePath,
        version: 'head',
      });
  const lines = content.split('\n');
  if (range.lineEnd > lines.length) {
    throw new Error('Provider file comment range exceeds file content');
  }
  return {
    ...range,
    selectedLines: lines.slice(range.lineStart - 1, range.lineEnd).join('\n'),
  };
}

async function fileThreadForCapture(
  params: PullRequestRepositoryParams,
  postedThread: AzureDevOpsCommentThread,
) {
  if (postedThread.threadContext?.originalCommitId?.trim()) {
    return postedThread;
  }
  const matchingThreads = (await getPullRequestThreads(params)).filter(
    (thread) => thread.id === postedThread.id,
  );
  if (matchingThreads.length !== 1) {
    throw new Error('Provider did not return one posted file thread');
  }
  positiveSafeProviderId(matchingThreads[0].id, 'thread ID');
  return matchingThreads[0];
}

function closingDelimiter(
  value: string,
  start: number,
  open: string,
  close: string,
) {
  let depth = 1;
  for (let index = start + 1; index < value.length; index++) {
    if (value[index] === '\\') {
      index++;
      continue;
    }
    if (value[index] === open) depth++;
    if (value[index] === close && --depth === 0) return index;
  }
  return -1;
}

function stripMarkdownImageUses(value: string) {
  const referenceLabels = new Set<string>();
  let result = '';
  let cursor = 0;

  while (cursor < value.length) {
    const start = value.indexOf('![', cursor);
    if (start < 0) {
      result += value.slice(cursor);
      break;
    }
    result += value.slice(cursor, start);
    const altEnd = closingDelimiter(value, start + 1, '[', ']');
    if (altEnd < 0) {
      result += value.slice(start, start + 2);
      cursor = start + 2;
      continue;
    }

    const alt = value.slice(start + 2, altEnd);
    let suffixStart = altEnd + 1;
    while (value[suffixStart] === ' ' || value[suffixStart] === '\t') {
      suffixStart++;
    }
    if (value[suffixStart] === '(') {
      const destinationEnd = closingDelimiter(value, suffixStart, '(', ')');
      cursor = destinationEnd < 0 ? altEnd + 1 : destinationEnd + 1;
      continue;
    }
    if (value[suffixStart] === '[') {
      const referenceEnd = closingDelimiter(value, suffixStart, '[', ']');
      if (referenceEnd >= 0) {
        const explicitLabel = value.slice(suffixStart + 1, referenceEnd);
        referenceLabels.add(
          (explicitLabel || alt).trim().replace(/\s+/g, ' ').toLowerCase(),
        );
        cursor = referenceEnd + 1;
        continue;
      }
    }
    referenceLabels.add(alt.trim().replace(/\s+/g, ' ').toLowerCase());
    cursor = altEnd + 1;
  }

  return { result, referenceLabels };
}

const ABSOLUTE_ATTACHMENT_URL =
  /https?:\/\/[^\s<>"')\]]*\/attachments\/[^\s<>"')\]]*/gi;
const RELATIVE_ATTACHMENT_URL =
  /\/(?:[^\s<>"')\]]*\/)?attachments\/[^\s<>"')\]]*/gi;
const SHORT_RELATIVE_ATTACHMENT_URL =
  /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?[^\s<>"')\]]*fileName=[^\s<>"')\]]*/gi;
const IMAGE_DATA_URL = /\bdata:image\/[^\s<>"')\]]+/gi;
const ENCODED_IMAGE_DATA_URL = /\bdata%3aimage%2f[^\s<>"')\]]+/gi;
const LOCAL_IMAGE_URL = /\b(?:blob|file):[^\s<>"')\]]+/gi;

export function stripPullRequestEvidenceArtifacts(text: string): string {
  const withoutHtmlImages = text.replace(/<img\b[^>]*>/gi, '');
  const { result, referenceLabels } =
    stripMarkdownImageUses(withoutHtmlImages);
  return result
    .replace(
      /^[ \t]{0,3}\[([^\]\n]+)\]:[^\n]*(?:\n|$)/gm,
      (definition, label: string) =>
        referenceLabels.has(label.trim().replace(/\s+/g, ' ').toLowerCase())
          ? ''
          : definition,
    )
    .replace(ABSOLUTE_ATTACHMENT_URL, '')
    .replace(RELATIVE_ATTACHMENT_URL, '')
    .replace(SHORT_RELATIVE_ATTACHMENT_URL, '')
    .replace(IMAGE_DATA_URL, '')
    .replace(ENCODED_IMAGE_DATA_URL, '')
    .replace(LOCAL_IMAGE_URL, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function threadTextBeforeReply(
  thread: AzureDevOpsCommentThread,
  postedComment: AzureDevOpsComment,
) {
  positiveSafeProviderId(postedComment.id, 'reply ID');
  const postedIndexes = thread.comments.flatMap((comment, index) =>
    comment.id === postedComment.id ? [index] : [],
  );
  if (postedIndexes.length > 1) {
    throw new Error('Provider returned ambiguous reply IDs in thread');
  }
  const postedIndex = postedIndexes[0] ?? -1;
  const priorComments =
    postedIndex >= 0
      ? thread.comments.slice(0, postedIndex)
      : thread.comments.filter((comment) => comment.id < postedComment.id);
  const text = priorComments
    .filter((comment) => comment.commentType !== 'system')
    .map((comment) => stripPullRequestEvidenceArtifacts(comment.content))
    .filter(Boolean)
    .join('\n\n');
  return text || null;
}

export async function addPullRequestCommentWithAgentMemory(
  params: PullRequestRepositoryParams & { content: string },
): Promise<AzureDevOpsCommentThread> {
  const result = await addPullRequestComment(params);
  if (!params.localProjectId) return result;

  scheduleCapture('pr-comment', params.localProjectId, async () => {
    if (!(await isAgentMemoryCaptureEnabled())) return;
    const projectId = await validateLocalProject(params);
    if (!projectId) return;
    positiveSafeProviderId(params.pullRequestId, 'pull request ID');
    const providerComment = postedThreadComment(result, params.content);
    const text = stripPullRequestEvidenceArtifacts(params.content);
    if (!text) return;
    await captureAgentMemoryEventSafe({
      source: 'pr-comment',
      sourceId: `pr-comment:${params.providerId}:${params.projectId}:${params.repoId}:${params.pullRequestId}:${result.id}:${providerComment.id}`,
      projectId,
      text,
      context: {
        pullRequestId: String(params.pullRequestId),
        filePath: null,
        lineStart: null,
        lineEnd: null,
        selectedLines: null,
        threadContext: null,
      },
      createdAt: providerComment.publishedDate,
    });
  });
  return result;
}

export async function addPullRequestFileCommentWithAgentMemory(
  params: PullRequestRepositoryParams & {
    filePath: string;
    line: number;
    lineEnd?: number;
    selectedLines?: string;
    content: string;
  },
): Promise<AzureDevOpsCommentThread> {
  const result = await addPullRequestFileComment(params);
  if (!params.localProjectId) return result;

  scheduleCapture('pr-comment', params.localProjectId, async () => {
    if (!(await isAgentMemoryCaptureEnabled())) return;
    const projectId = await validateLocalProject(params);
    if (!projectId) return;
    positiveSafeProviderId(params.pullRequestId, 'pull request ID');
    const providerComment = postedThreadComment(result, params.content);
    const captureThread = await fileThreadForCapture(params, result);
    const selection = await deriveFileSelection(params, captureThread);
    const text = stripPullRequestEvidenceArtifacts(params.content);
    if (!text) return;
    await captureAgentMemoryEventSafe({
      source: 'pr-comment',
      sourceId: `pr-comment:${params.providerId}:${params.projectId}:${params.repoId}:${params.pullRequestId}:${result.id}:${providerComment.id}`,
      projectId,
      text,
      context: {
        pullRequestId: String(params.pullRequestId),
        ...selection,
        threadContext: null,
      },
      createdAt: providerComment.publishedDate,
    });
  });
  return result;
}

export async function addThreadReplyWithAgentMemory(
  params: PullRequestRepositoryParams & { threadId: number; content: string },
): Promise<AzureDevOpsComment> {
  const result = await addThreadReply(params);
  if (!params.localProjectId) return result;

  scheduleCapture('pr-reply', params.localProjectId, async () => {
    if (!(await isAgentMemoryCaptureEnabled())) return;
    const projectId = await validateLocalProject(params);
    if (!projectId) return;
    positiveSafeProviderId(params.pullRequestId, 'pull request ID');
    positiveSafeProviderId(params.threadId, 'thread ID');
    positiveSafeProviderId(result.id, 'reply ID');
    const threads = await getPullRequestThreads(params);
    const thread = threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) throw new Error('Provider reply thread was not found');
    positiveSafeProviderId(thread.id, 'thread ID');

    let selection: FileSelection | null = null;
    if (thread.threadContext?.filePath) {
      try {
        selection = await deriveFileSelection(params, thread);
      } catch (error) {
        captureFailure('pr-reply', projectId, error);
      }
    }
    const text = stripPullRequestEvidenceArtifacts(params.content);
    if (!text) return;
    await captureAgentMemoryEventSafe({
      source: 'pr-reply',
      sourceId: `pr-reply:${params.providerId}:${params.projectId}:${params.repoId}:${params.pullRequestId}:${params.threadId}:${result.id}`,
      projectId,
      text,
      context: {
        pullRequestId: String(params.pullRequestId),
        threadId: String(params.threadId),
        filePath: selection?.filePath ?? null,
        lineStart: selection?.lineStart ?? null,
        lineEnd: selection?.lineEnd ?? null,
        selectedLines: selection?.selectedLines ?? null,
        threadContext: threadTextBeforeReply(thread, result),
      },
      createdAt: result.publishedDate,
    });
  });
  return result;
}
