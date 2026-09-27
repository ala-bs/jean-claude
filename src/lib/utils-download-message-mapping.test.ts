import { describe, expect, it } from 'vitest';

import { getMessageMappingFilename } from './utils-download-message-mapping';

describe('getMessageMappingFilename', () => {
  it('uses the task title and removes filesystem-invalid characters', () => {
    expect(
      getMessageMappingFilename({
        taskId: '1234567890abcdef',
        taskTitle: 'Fix: export/raw messages?',
      }),
    ).toBe('message-mapping-Fix- export-raw messages-.json');
  });

  it('falls back to the task ID when the title is blank', () => {
    expect(
      getMessageMappingFilename({
        taskId: '1234567890abcdef',
        taskTitle: '...///',
      }),
    ).toBe('message-mapping-12345678.json');
  });

  it('caps long task titles', () => {
    const filename = getMessageMappingFilename({
      taskId: '1234567890abcdef',
      taskTitle: 'a'.repeat(100),
    });

    expect(filename).toBe(`message-mapping-${'a'.repeat(80)}.json`);
  });
});
