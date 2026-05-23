import { vol } from 'memfs';
import { afterEach, beforeEach, vi } from 'vitest';

vi.mock('fs/promises', async () => {
  const { fs } = await vi.importActual<typeof import('memfs')>('memfs');
  return fs.promises;
});

beforeEach(() => {
  vol.reset();
});

afterEach(() => {
  vol.reset();
});
