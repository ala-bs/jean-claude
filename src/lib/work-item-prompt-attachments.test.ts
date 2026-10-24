import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AzureDevOpsWorkItem } from '@/lib/api';

const { downloadWorkItemAttachment } = vi.hoisted(() => ({
  downloadWorkItemAttachment: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: { azureDevOps: { downloadWorkItemAttachment } },
}));

import { downloadWorkItemPromptAttachments } from './work-item-prompt-attachments';

describe('downloadWorkItemPromptAttachments', () => {
  beforeEach(() => downloadWorkItemAttachment.mockReset());

  it('keeps successful files and reports failed attachments by work item', async () => {
    downloadWorkItemAttachment
      .mockResolvedValueOnce({ filePath: '/project/.jean-claude/tmp/one', filename: 'AB-42-spec.pdf' })
      .mockRejectedValueOnce(new Error('Azure unavailable'));
    const workItems = [{
      id: 42,
      attachments: [
        { name: 'spec.pdf', url: 'https://dev.azure.com/org/_apis/wit/attachments/one' },
        { name: 'image.png', url: 'https://dev.azure.com/org/_apis/wit/attachments/two' },
      ],
    }] as AzureDevOpsWorkItem[];

    const result = await downloadWorkItemPromptAttachments({
      workItems,
      providerId: 'provider',
      projectPath: '/project',
    });

    expect(result.files).toEqual([{
      type: 'file',
      filePath: '/project/.jean-claude/tmp/one',
      filename: 'AB-42-spec.pdf',
    }]);
    expect(result.failures).toEqual(['AB#42: image.png']);
    expect(downloadWorkItemAttachment).toHaveBeenCalledTimes(2);
  });
});
