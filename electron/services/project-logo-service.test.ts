import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';

const {
  appGetPathMock,
  decryptMock,
  findProjectByIdMock,
  getEffectivePolicyMock,
  getSettingMock,
  listProfilesMock,
  updateProjectMock,
  updateSummaryIfBlankMock,
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  decryptMock: vi.fn(),
  findProjectByIdMock: vi.fn(),
  getEffectivePolicyMock: vi.fn(),
  getSettingMock: vi.fn(),
  listProfilesMock: vi.fn(),
  updateProjectMock: vi.fn(),
  updateSummaryIfBlankMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../database/repositories/projects', () => ({
  ProjectRepository: {
    findById: findProjectByIdMock,
    update: updateProjectMock,
    updateSummaryIfBlank: updateSummaryIfBlankMock,
  },
}));

vi.mock('../database/repositories/settings', () => ({
  SettingsRepository: { get: getSettingMock },
}));

vi.mock('./encryption-service', () => ({
  encryptionService: { decrypt: decryptMock },
}));

vi.mock('./project-summary-generation-service', () => ({
  generateProjectSummary: vi.fn(async () => 'summary'),
}));

vi.mock('./model-profile-service', () => ({
  getModelProfileService: () => ({
    listProfiles: listProfilesMock,
    getEffectivePolicy: getEffectivePolicyMock,
  }),
}));

import { detectProjectLogos } from './project-logo-detection-service';
import { generateProjectLogo } from './project-logo-service';

describe('detectProjectLogos', () => {
  it('finds logos in nested workspace apps and packages', async () => {
    const root = '/tmp/workspace';
    const webLogo = path.join(root, 'apps', 'web', 'public', 'logo.png');
    const packageIcon = path.join(
      root,
      'packages',
      'site',
      'assets',
      'icon.png',
    );
    const ignoredLogo = path.join(
      root,
      'node_modules',
      'pkg',
      'public',
      'logo.png',
    );

    vol.mkdirSync(path.dirname(webLogo), { recursive: true });
    vol.mkdirSync(path.dirname(packageIcon), { recursive: true });
    vol.mkdirSync(path.dirname(ignoredLogo), { recursive: true });
    vol.writeFileSync(webLogo, 'png');
    vol.writeFileSync(packageIcon, 'png');
    vol.writeFileSync(ignoredLogo, 'png');

    const logos = await detectProjectLogos(root);

    expect(logos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: webLogo,
          label: 'apps/web: Public logo',
        }),
        expect.objectContaining({
          path: packageIcon,
          label: 'packages/site: Asset icon',
        }),
      ]),
    );
    expect(logos).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ignoredLogo })]),
    );
  });

  it('finds nested mobile app icons', async () => {
    const root = '/tmp/workspace';
    const androidIcon = path.join(
      root,
      'apps',
      'mobile',
      'android',
      'app',
      'src',
      'main',
      'res',
      'mipmap-xxxhdpi',
      'ic_launcher.png',
    );

    vol.mkdirSync(path.dirname(androidIcon), { recursive: true });
    vol.writeFileSync(androidIcon, 'png');

    const logos = await detectProjectLogos(root);

    expect(logos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: androidIcon,
          label: 'apps/mobile: Android mipmap-xxxhdpi',
          source: 'android',
        }),
      ]),
    );
  });
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

/** A profile binding the `project-logo` image role. */
function profileWithLogoRole(binding: unknown) {
  return [
    {
      id: 'profile-1',
      name: 'Profile',
      presets: [],
      roles: { agent: 'inherit', 'project-logo': binding },
    },
  ];
}

describe('generateProjectLogo and the project-logo role', () => {
  const project = {
    id: 'project-1',
    name: 'Jean Claude',
    path: '/workspace/jean-claude',
    color: '#7c3aed',
    logoPath: null,
    logoSource: null,
    aiSkillSlots: null,
    summary: 'Desktop app for managing coding agents across projects.',
  };

  beforeEach(() => {
    vol.mkdirSync('/tmp/jc-logo-role-test', { recursive: true });
    appGetPathMock.mockReturnValue('/tmp/jc-logo-role-test');
    findProjectByIdMock.mockResolvedValue(project);
    updateProjectMock.mockReset();
    updateProjectMock.mockImplementation(
      async (_id: string, update: Record<string, unknown>) => ({
        ...project,
        ...update,
      }),
    );
    getSettingMock.mockReset();
    getSettingMock.mockImplementation(async (key: string) => {
      if (key === 'aiGeneration') {
        return {
          openAiApiKey: 'encrypted-key',
          openAiImageGenerationEnabled: true,
          openAiImageModel: 'gpt-image-2',
          openAiBaseImageMode: 'custom',
          openAiBaseImagePath: null,
        };
      }
      if (key === 'activeModelProfileId') return 'profile-1';
      throw new Error(`Unexpected setting key: ${key}`);
    });
    decryptMock.mockReset();
    decryptMock.mockReturnValue('test-key');
    listProfilesMock.mockReset();
    listProfilesMock.mockResolvedValue([]);
    getEffectivePolicyMock.mockReset();
    getEffectivePolicyMock.mockResolvedValue({ policy: { mode: 'inherit' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ b64_json: PNG_BYTES.toString('base64') }],
        }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vol.rmSync('/tmp/jc-logo-role-test', { recursive: true, force: true });
  });

  /** The model sent in the JSON body of the images request. */
  function requestedModel(): string {
    const call = vi.mocked(fetch).mock.calls[0];
    return JSON.parse(String(call?.[1]?.body)).model;
  }

  it('skips generation cleanly when the project-logo role is off', async () => {
    listProfilesMock.mockResolvedValue(profileWithLogoRole('off'));

    const result = await generateProjectLogo({ projectId: 'project-1' });

    expect(fetch).not.toHaveBeenCalled();
    expect(updateProjectMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'project-1', logoPath: null });
  });

  it('uses the image model bound by the profile', async () => {
    listProfilesMock.mockResolvedValue(
      profileWithLogoRole({ imageModel: 'gpt-image-1' }),
    );

    await generateProjectLogo({ projectId: 'project-1' });

    expect(requestedModel()).toBe('gpt-image-1');
  });

  it('uses the AI Generation setting when the role is unset', async () => {
    getSettingMock.mockImplementation(async (key: string) => {
      if (key === 'aiGeneration') {
        return {
          openAiApiKey: 'encrypted-key',
          openAiImageGenerationEnabled: true,
          openAiImageModel: 'gpt-image-3',
          openAiBaseImageMode: 'custom',
          openAiBaseImagePath: null,
        };
      }
      if (key === 'activeModelProfileId') return 'profile-1';
      throw new Error(`Unexpected setting key: ${key}`);
    });
    listProfilesMock.mockResolvedValue(profileWithLogoRole(undefined));

    await generateProjectLogo({ projectId: 'project-1' });

    expect(requestedModel()).toBe('gpt-image-3');
  });

  it('ignores a non-GPT-image model held by the profile', async () => {
    listProfilesMock.mockResolvedValue(
      profileWithLogoRole({ imageModel: 'dall-e-3' }),
    );

    await generateProjectLogo({ projectId: 'project-1' });

    expect(requestedModel()).toBe('gpt-image-2');
  });

  it('refuses to generate when the project policy blocks the profile', async () => {
    getEffectivePolicyMock.mockResolvedValue({
      policy: { mode: 'enforce', allowedProfileIds: ['other-profile'] },
    });
    listProfilesMock.mockResolvedValue(
      profileWithLogoRole({ imageModel: 'gpt-image-1' }),
    );

    await expect(
      generateProjectLogo({ projectId: 'project-1' }),
    ).rejects.toThrow(/does not permit the model profile/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still generates when profile resolution fails', async () => {
    listProfilesMock.mockRejectedValue(new Error('database unavailable'));

    await generateProjectLogo({ projectId: 'project-1' });

    expect(requestedModel()).toBe('gpt-image-2');
  });
});
