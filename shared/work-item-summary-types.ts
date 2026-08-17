export type WorkItemSummary = {
  providerId: string;
  workItemId: number;
  content: string;
  sourceChangedDate: string | null;
  sourceLatestCommentId: number | null;
  sourceCommentCount: number;
  generatedAt: string;
  updatedAt: string;
  isStale: boolean;
};

export type WorkItemSummaryRequest = {
  projectId: string;
  providerId: string;
  projectName: string;
  workItemId: number;
};
