import { describe, expect, it } from 'vitest';

import { cleanIpcError } from './ipc-error';

describe('cleanIpcError', () => {
  it('strips the electron remote-method prefix', () => {
    expect(
      cleanIpcError(
        new Error(
          "Error invoking remote method 'tokens:delete': Error: Cannot delete token: still used by 2 organizations (contoso, fabrikam).",
        ),
      ),
    ).toBe(
      'Cannot delete token: still used by 2 organizations (contoso, fabrikam).',
    );
  });

  it('leaves a plain message untouched', () => {
    expect(cleanIpcError(new Error('Something broke'))).toBe('Something broke');
  });

  it('handles non-Error values', () => {
    expect(cleanIpcError('boom')).toBe('boom');
  });
});
