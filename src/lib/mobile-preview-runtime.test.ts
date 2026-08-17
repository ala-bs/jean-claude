import { describe, expect, it } from 'vitest';

import {
  createMobileDevServerCommandId,
  createMobilePreviewRuntimeKey,
  parseMobileDevServerCommandId,
  parseMobilePreviewRuntimeKey,
} from './mobile-preview-runtime';

describe('mobile preview runtime identity', () => {
  it.each([
    ['', '.'],
    ['.', '.'],
    ['apps/mobile', 'apps/mobile'],
    ['apps/mobile:dev server', 'apps/mobile:dev server'],
  ])('round trips mobile dev-server app path %j', (appPath, expected) => {
    const commandId = createMobileDevServerCommandId(appPath);

    expect(parseMobileDevServerCommandId(commandId)).toBe(expected);
    expect(commandId).toBe(
      `mobile-dev-server:${encodeURIComponent(expected)}`,
    );
  });

  it.each([
    ['', null],
    ['mobile-dev-server:', null],
    ['mobile-dev-server:%', null],
    ['mobile-dev-server:app:extra', null],
    ['other:app', null],
  ])('rejects malformed mobile dev-server command ID %j', (value, expected) => {
    expect(parseMobileDevServerCommandId(value)).toBe(expected);
  });

  it('round trips encoded task and app runtime identity', () => {
    const key = createMobilePreviewRuntimeKey({
      taskId: 'task:one/two',
      appPath: 'apps/mobile:dev server',
    });

    expect(key).toBe(
      'mobile-runtime:task%3Aone%2Ftwo:apps%2Fmobile%3Adev%20server',
    );
    expect(parseMobilePreviewRuntimeKey(key)).toEqual({
      taskId: 'task:one/two',
      appPath: 'apps/mobile:dev server',
    });
  });

  it('normalizes the root app path in runtime keys', () => {
    const key = createMobilePreviewRuntimeKey({ taskId: 'task-1', appPath: '' });

    expect(parseMobilePreviewRuntimeKey(key)).toEqual({
      taskId: 'task-1',
      appPath: '.',
    });
  });

  it.each([
    '',
    'mobile-runtime:',
    'mobile-runtime:task-1:',
    'mobile-runtime::app',
    'mobile-runtime:task-1:%',
    'mobile-runtime:task-1:app:extra',
    'other:task-1:app',
  ])('rejects malformed runtime key %j', (value) => {
    expect(parseMobilePreviewRuntimeKey(value)).toBeNull();
  });
});
