import { describe, expect, it } from 'vitest';

import { createPermissionModalState } from './permission-modal-state';

describe('createPermissionModalState', () => {
  it('keeps originating step when active selection changes', () => {
    let activeStepId = 'step-1';
    const modal = createPermissionModalState(activeStepId, 'pnpm test');

    activeStepId = 'step-2';

    expect(activeStepId).toBe('step-2');
    expect(modal).toEqual({ stepId: 'step-1', command: 'pnpm test' });
  });
});
