import type { PromptFilePart } from '@shared/agent-backend-types';
import type { AzureDevOpsWorkItem } from '@/lib/api';
import { api } from '@/lib/api';

/** Download related Azure files so the agent can read them from the prompt. */
export async function downloadWorkItemPromptAttachments(params: {
  workItems: AzureDevOpsWorkItem[];
  providerId: string;
  projectPath: string;
}): Promise<{ files: PromptFilePart[]; failures: string[] }> {
  const files: PromptFilePart[] = [];
  const failures: string[] = [];

  for (const workItem of params.workItems) {
    for (const attachment of workItem.attachments ?? []) {
      try {
        const filename = `AB-${workItem.id}-${attachment.name}`;
        const result = await api.azureDevOps.downloadWorkItemAttachment({
          providerId: params.providerId,
          attachmentUrl: attachment.url,
          filename,
          projectPath: params.projectPath,
        });
        files.push({ type: 'file', ...result });
      } catch (error) {
        console.error('Failed to download work item attachment:', error);
        failures.push(`AB#${workItem.id}: ${attachment.name}`);
      }
    }
  }

  return { files, failures };
}
