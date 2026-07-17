import { describe, expect, it } from 'vitest';

import {
  expandRelativeAzureAttachmentUrls,
  restoreEscapedMarkdownLinks,
} from './azure-devops-markdown';

describe('expandRelativeAzureAttachmentUrls', () => {
  it('expands relative image attachment URLs with optional space after paren', () => {
    expect(
      expandRelativeAzureAttachmentUrls({
        value:
          '![Image]( /70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png)',
        attachmentBaseUrl:
          'https://dev.azure.com/org/project/_apis/wit/attachments',
      }),
    ).toBe(
      '![Image](https://dev.azure.com/org/project/_apis/wit/attachments/70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png)',
    );
  });

  it('drops Azure control characters before relative attachment URLs', () => {
    expect(
      expandRelativeAzureAttachmentUrls({
        value:
          '<img src="\u0006/70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png" alt=Image>',
        attachmentBaseUrl:
          'https://dev.azure.com/org/project/_apis/wit/attachments',
      }),
    ).toBe(
      '<img src="https://dev.azure.com/org/project/_apis/wit/attachments/70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png" alt=Image>',
    );
  });
});

describe('restoreEscapedMarkdownLinks', () => {
  it('restores markdown image links escaped by Turndown', () => {
    expect(
      restoreEscapedMarkdownLinks(
        'Test !\\[image.png\\](azure-image-proxy://provider/image) done',
      ),
    ).toBe('Test ![image.png](azure-image-proxy://provider/image) done');
  });

  it('does not restore ordinary escaped markdown links', () => {
    expect(
      restoreEscapedMarkdownLinks(
        'See \\[Azure\\](https://dev.azure.com/org/project)',
      ),
    ).toBe('See \\[Azure\\](https://dev.azure.com/org/project)');
  });
});
