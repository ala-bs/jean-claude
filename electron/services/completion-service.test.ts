import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedModel } from '@shared/model-profiles';

const fimComplete = vi.fn();
const mistralConstructor = vi.fn();
const resolveForRole = vi.fn();
const getSetting = vi.fn();

vi.mock('@mistralai/mistralai', () => ({
  Mistral: class {
    fim = { complete: fimComplete };
    constructor(options: unknown) {
      mistralConstructor(options);
    }
  },
}));

vi.mock('../database/repositories', () => ({
  SettingsRepository: { get: (key: string) => getSetting(key) },
  ProjectRepository: { findById: vi.fn().mockResolvedValue(null) },
  CompletionUsageRepository: {
    recordUsage: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./encryption-service', () => ({
  encryptionService: { decrypt: (value: string) => `decrypted:${value}` },
}));

vi.mock('./ai-usage-tracking-service', () => ({
  aiUsageTrackingService: { recordAutocompleteUsageBatched: vi.fn() },
}));

vi.mock('./model-profile-service', () => ({
  getModelProfileService: () => ({ resolveForRole }),
}));

const { complete, resetClient } = await import('./completion-service');

function resolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    backend: 'claude-code',
    model: 'default',
    thinkingEffort: 'default',
    source: 'profile',
    ...overrides,
  };
}

describe('completion service model role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClient();
    getSetting.mockResolvedValue({
      enabled: true,
      apiKey: 'encrypted-key',
      model: 'codestral-latest',
      serverUrl: '',
    });
    resolveForRole.mockResolvedValue(resolved());
    fimComplete.mockResolvedValue({
      choices: [{ message: { content: 'completed()' } }],
    });
  });

  it('returns no completion and never constructs the client when the role is off', async () => {
    resolveForRole.mockResolvedValue(
      resolved({
        off: true,
        blocked: {
          reason: 'role-off',
          message: 'Autocomplete is disabled.',
          allowed: {},
        },
      }),
    );

    const result = await complete({ prompt: 'const x =', projectId: 'p1' });

    expect(result).toBeNull();
    expect(mistralConstructor).not.toHaveBeenCalled();
    expect(fimComplete).not.toHaveBeenCalled();
  });

  it('resolves the completion role for the project', async () => {
    await complete({ prompt: 'const x =', projectId: 'p1' });

    expect(resolveForRole).toHaveBeenCalledWith({
      role: 'completion',
      projectId: 'p1',
    });
  });

  // The `completion` role is toggle-only. Autocomplete is always Mistral FIM
  // using the Autocomplete settings' API key and model, so a model name coming
  // from a preset on some other backend must never reach the Mistral client —
  // it would simply make the request fail.
  it('ignores the role model and always uses the configured Mistral model', async () => {
    resolveForRole.mockResolvedValue(resolved({ model: 'sonnet' }));

    const result = await complete({ prompt: 'const x =' });

    expect(result).toBe('completed()');
    expect(fimComplete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'codestral-latest' }),
    );
    expect(fimComplete).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: 'sonnet' }),
    );
  });

  it('uses the configured model when the role resolves to default', async () => {
    await complete({ prompt: 'const x =' });

    expect(fimComplete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'codestral-latest' }),
    );
  });

  it('returns no completion when the role is blocked by policy', async () => {
    resolveForRole.mockResolvedValue(
      resolved({
        source: 'policy',
        blocked: {
          reason: 'backend-not-allowed',
          message: 'nope',
          allowed: {},
        },
      }),
    );

    const result = await complete({ prompt: 'const x =' });

    expect(result).toBeNull();
    expect(mistralConstructor).not.toHaveBeenCalled();
  });
});
