export type PreferenceEvidenceSource =
  | 'task-review-comment'
  | 'pr-file-comment';

export interface PreferenceEvidenceCommentInput {
  body: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  presets?: string[];
  pullRequestId?: string | number;
  selectedText?: string;
}

export interface PreferenceEvidenceFileSnapshot {
  filePath: string;
  content?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  truncated?: boolean;
  bytes?: number;
  reason?: 'missing-task-worktree' | 'outside-worktree' | 'read-failed';
}

export interface PreferenceEvidenceMetadata {
  projectName?: string | null;
  projectPath?: string;
  taskName?: string | null;
  taskPrompt?: string;
  worktreePath?: string | null;
  branchName?: string | null;
  sourceBranch?: string | null;
}

export interface RecordPreferenceEvidenceParams {
  source: PreferenceEvidenceSource;
  taskId?: string;
  projectId?: string;
  comments: PreferenceEvidenceCommentInput[];
  context?: Record<string, string | number | boolean | null | undefined>;
}

export interface PreferenceEvidenceRecord {
  id: string;
  createdAt: string;
  source: PreferenceEvidenceSource;
  taskId?: string;
  projectId: string;
  comment: PreferenceEvidenceCommentInput;
  fileSnapshot?: PreferenceEvidenceFileSnapshot;
  metadata?: PreferenceEvidenceMetadata;
  context?: Record<string, string | number | boolean | null>;
}

export interface RecordPreferenceEvidenceResult {
  path: string;
  recorded: number;
}

export interface PreferenceMemoryHistoryEntry {
  id: string;
  createdAt: string;
  backend: string;
  model: string;
  thinkingEffort: string;
  evidence: { files: Array<{ fileName: string; recordCount: number }> };
  document: { content: string; sha256: string };
}

export interface PreferenceMemoryDashboard {
  projectId: string;
  preferences: { content: string; updatedAt: string | null };
  evidence: {
    records: PreferenceEvidenceRecord[];
    page: number;
    pageSize: number;
    total: number;
    bySource: Record<PreferenceEvidenceSource, number>;
  };
  state: {
    lastConsolidatedAt: string | null;
    pendingBytes: number;
    totalBytes: number;
  };
  history: PreferenceMemoryHistoryEntry[];
}
