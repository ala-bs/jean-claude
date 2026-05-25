import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  api: {
    projects: { findById: vi.fn() },
    tasks: { findById: vi.fn() },
  },
}));

import { resolveLocationRedirect } from './navigation';

describe('resolveLocationRedirect', () => {
  it('restores the feed route when feed was last focused', async () => {
    await expect(
      resolveLocationRedirect({ lastLocation: { type: 'all', taskId: null } }),
    ).resolves.toEqual({ to: '/all' });
  });
});
