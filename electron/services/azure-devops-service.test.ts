import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findProviderByIdMock, getDecryptedTokenMock } = vi.hoisted(() => ({
  findProviderByIdMock: vi.fn(),
  getDecryptedTokenMock: vi.fn(),
}));

vi.mock('../database/repositories/providers', () => ({
  ProviderRepository: {
    findById: findProviderByIdMock,
  },
}));

vi.mock('../database/repositories/tokens', () => ({
  TokenRepository: {
    getDecryptedToken: getDecryptedTokenMock,
  },
}));

import {
  addWorkItemComment,
  buildWorkItemBoardColumnPatch,
  buildWorkItemFieldPatch,
  buildIterationPathsCondition,
  getIterations,
  getBoardColumns,
  getWorkItemById,
  getWorkItemsByIds,
  getWorkItemComments,
  getPullRequestFileContent,
  getPullRequestStatuses,
  getPullRequestThreads,
  queryWorkItemOwners,
  queryWorkItems,
  resolveWorkItemBoardColumnUpdate,
  setPullRequestAutoComplete,
  updatePullRequestTitle,
  updateWorkItemBoardColumn,
  uploadPullRequestAttachment,
} from './azure-devops-service';

describe('getWorkItemById', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps acceptance criteria from detailed work items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            id: 55803,
            url: 'api-url',
            fields: {
              'System.Title': 'Story',
              'System.WorkItemType': 'User Story',
              'System.State': 'Active',
              'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>Ship it</p>',
            },
          },
          { ok: true },
        ),
      ),
    );

    await expect(
      getWorkItemById({ providerId: 'provider-1', workItemId: 55803 }),
    ).resolves.toMatchObject({
      fields: { acceptanceCriteria: '<p>Ship it</p>' },
    });
  });
});

describe('getWorkItemsByIds', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deduplicates IDs and maps child and related relations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          count: 1,
          value: [
            {
              id: 10,
              url: 'api-url',
              fields: {
                'System.Title': 'Story',
                'System.WorkItemType': 'User Story',
                'System.State': 'Active',
              },
              relations: [
                {
                  rel: 'System.LinkTypes.Hierarchy-Forward',
                  url: 'https://example/_apis/wit/workItems/11',
                  attributes: {},
                },
                {
                  rel: 'System.LinkTypes.Related',
                  url: 'https://example/_apis/wit/workItems/12',
                  attributes: {},
                },
              ],
            },
          ],
        },
        { ok: true },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getWorkItemsByIds({
        providerId: 'provider-1',
        projectName: 'Team Project',
        workItemIds: [10, 10],
      }),
    ).resolves.toMatchObject([
      { id: 10, childIds: [11], relatedWorkItemIds: [12] },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      ids: [10],
      $expand: 'Relations',
      errorPolicy: 'Omit',
    });
    expect(fetchMock.mock.calls[0][0]).toContain(
      '/Team%20Project/_apis/wit/workitemsbatch',
    );
    expect(
      (await getWorkItemsByIds({
        providerId: 'provider-1',
        projectName: 'Team Project',
        workItemIds: [10],
      }))[0].url,
    ).toContain('/Team%20Project/_workitems/edit/10');
  });

  it('rejects when a batch chunk request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse('service unavailable', { ok: false }),
      ),
    );

    await expect(
      getWorkItemsByIds({
        providerId: 'provider-1',
        projectName: 'Team Project',
        workItemIds: [10],
      }),
    ).rejects.toThrow('Failed to batch-fetch work items for Team Project');
  });

  it('fetches more than 200 IDs in chunks and preserves requested order', async () => {
    const ids = Array.from({ length: 401 }, (_, index) => index + 1);
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const chunk = JSON.parse(String(init?.body)).ids as number[];
      return jsonResponse(
        {
          count: chunk.length,
          value: [...chunk].reverse().map(workItemResponse),
        },
        { ok: true },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getWorkItemsByIds({
      providerId: 'provider-1',
      projectName: 'Team Project',
      workItemIds: ids,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).ids.length)).toEqual([
      200,
      200,
      1,
    ]);
    expect(result.map(({ id }) => id)).toEqual(ids);
    expect(result[0].childIds).toEqual([10_001]);
  });

  it('bounds chunk concurrency at four requests', async () => {
    const ids = Array.from({ length: 1_201 }, (_, index) => index + 1);
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const chunk = JSON.parse(String(init?.body)).ids as number[];
      return jsonResponse(
        { count: chunk.length, value: chunk.map(workItemResponse) },
        { ok: true },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getWorkItemsByIds({
      providerId: 'provider-1',
      projectName: 'Team Project',
      workItemIds: ids,
    });

    expect(maxActive).toBe(4);
    expect(result.map(({ id }) => id)).toEqual(ids);
  });

  it('rejects all results when a later chunk fails', async () => {
    const ids = Array.from({ length: 1_001 }, (_, index) => index + 1);
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const chunk = JSON.parse(String(init?.body)).ids as number[];
      if (chunk[0] === 801) {
        return jsonResponse('later chunk failed', { ok: false });
      }
      return jsonResponse(
        { count: chunk.length, value: chunk.map(workItemResponse) },
        { ok: true },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getWorkItemsByIds({
        providerId: 'provider-1',
        projectName: 'Team Project',
        workItemIds: ids,
      }),
    ).rejects.toThrow('later chunk failed');
  });

  it('aborts active requests and does not claim later chunks after first failure', async () => {
    const ids = Array.from({ length: 1_201 }, (_, index) => index + 1);
    const startedChunks: number[] = [];
    const abortedChunks: number[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const chunk = JSON.parse(String(init?.body)).ids as number[];
      const chunkStart = chunk[0];
      startedChunks.push(chunkStart);
      if (chunkStart === 1) {
        return jsonResponse('controlled first failure', { ok: false });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortedChunks.push(chunkStart);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getWorkItemsByIds({
        providerId: 'provider-1',
        projectName: 'Team Project',
        workItemIds: ids,
      }),
    ).rejects.toThrow('controlled first failure');

    expect(startedChunks).toEqual([1, 201, 401, 601]);
    expect(abortedChunks).toEqual([201, 401, 601]);
    expect(startedChunks).not.toContain(801);
  });
});

describe('queryWorkItems', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('does not truncate WIQL and batch-fetches every returned ID', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => index + 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { workItems: ids.map((id) => ({ id, url: `work-item-${id}` })) },
          { ok: true },
        ),
      )
      .mockImplementation(async (_url, init) => {
        const chunk = JSON.parse(String(init?.body)).ids as number[];
        return jsonResponse(
          { count: chunk.length, value: chunk.map(workItemResponse) },
          { ok: true },
        );
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await queryWorkItems({
      providerId: 'provider-1',
      projectId: 'project-1',
      projectName: 'Team Project',
      filters: {},
    });

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('$top=200');
    expect(result).toHaveLength(201);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('queryWorkItemOwners', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fetches only assigned-to fields in batches and returns unique owners', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => index + 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { workItems: ids.map((id) => ({ id, url: `work-item-${id}` })) },
          { ok: true },
        ),
      )
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          ids: number[];
          fields: string[];
          errorPolicy: string;
        };
        expect(body.fields).toEqual(['System.AssignedTo']);
        expect(body).not.toHaveProperty('$expand');
        return jsonResponse(
          {
            count: body.ids.length,
            value: body.ids.map((id) => ({
              id,
              fields: {
                'System.AssignedTo': {
                  displayName: id % 3 === 1 ? 'Zoe' : ' Alex ',
                  uniqueName:
                    id % 3 === 1
                      ? 'zoe@example.com'
                      : id % 3 === 2
                        ? 'alex.one@example.com'
                        : 'alex.two@example.com',
                },
              },
            })),
          },
          { ok: true },
        );
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      queryWorkItemOwners({
        providerId: 'provider-1',
        projectName: 'Team Project',
      }),
    ).resolves.toEqual([
      { displayName: 'Alex', value: 'alex.one@example.com' },
      { displayName: 'Alex', value: 'alex.two@example.com' },
      { displayName: 'Zoe', value: 'zoe@example.com' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('buildIterationPathsCondition', () => {
  it('deduplicates paths and escapes WIQL quotes', () => {
    expect(
      buildIterationPathsCondition([
        'Project\\Sprint 9',
        "Project\\Team's Sprint",
        'Project\\Sprint 9',
      ]),
    ).toBe(
      "[System.IterationPath] IN ('Project\\Sprint 9', 'Project\\Team''s Sprint')",
    );
  });
});

describe('getIterations', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Azure timeFrame when current iteration has no dates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            count: 1,
            value: [
              {
                id: 'iteration-1',
                name: 'Sprint 10',
                path: 'Project\\Sprint 10',
                attributes: { timeFrame: 'current' },
              },
            ],
          },
          { ok: true },
        ),
      ),
    );

    await expect(
      getIterations({ providerId: 'provider-1', projectName: 'Project' }),
    ).resolves.toEqual([
      {
        id: 'iteration-1',
        name: 'Sprint 10',
        path: 'Project\\Sprint 10',
        startDate: null,
        finishDate: null,
        isCurrent: true,
      },
    ]);
  });
});

describe('buildWorkItemFieldPatch', () => {
  it('validates required fields and priority bounds', () => {
    expect(() => buildWorkItemFieldPatch({ field: 'System.Title', value: ' ' })).toThrow(
      'title cannot be empty',
    );
    expect(() =>
      buildWorkItemFieldPatch({
        field: 'Microsoft.VSTS.Common.Priority',
        value: Number.NaN,
      }),
    ).toThrow('integer from 1 to 4');
    expect(() =>
      buildWorkItemFieldPatch({
        field: 'Microsoft.VSTS.Common.Priority',
        value: 5,
      }),
    ).toThrow('integer from 1 to 4');
  });

  it('only removes fields that Azure permits clearing', () => {
    expect(buildWorkItemFieldPatch({ field: 'System.Tags', value: '' })).toEqual({
      op: 'remove',
      path: '/fields/System.Tags',
    });
    expect(() =>
      buildWorkItemFieldPatch({ field: 'System.State', value: '' }),
    ).toThrow('state cannot be empty');
    expect(
      buildWorkItemFieldPatch({
        field: 'Microsoft.VSTS.Scheduling.StoryPoints',
        value: '',
      }),
    ).toEqual({
      op: 'remove',
      path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints',
    });
  });

  it('validates story points as a non-negative integer', () => {
    expect(
      buildWorkItemFieldPatch({
        field: 'Microsoft.VSTS.Scheduling.StoryPoints',
        value: 3,
      }),
    ).toEqual({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints',
      value: 3,
    });
    expect(() =>
      buildWorkItemFieldPatch({
        field: 'Microsoft.VSTS.Scheduling.StoryPoints',
        value: -1,
      }),
    ).toThrow('non-negative integer');
  });

  it('builds an iteration path update', () => {
    expect(
      buildWorkItemFieldPatch({
        field: 'System.IterationPath',
        value: 'Project\\Sprint 9',
      }),
    ).toEqual({
      op: 'add',
      path: '/fields/System.IterationPath',
      value: 'Project\\Sprint 9',
    });
  });

  it('builds owner assignment and unassignment updates', () => {
    expect(
      buildWorkItemFieldPatch({
        field: 'System.AssignedTo',
        value: 'Alice',
      }),
    ).toEqual({
      op: 'add',
      path: '/fields/System.AssignedTo',
      value: 'Alice',
    });
    expect(
      buildWorkItemFieldPatch({ field: 'System.AssignedTo', value: '' }),
    ).toEqual({ op: 'remove', path: '/fields/System.AssignedTo' });
  });
});

describe('buildWorkItemBoardColumnPatch', () => {
  it('updates state, board column, and done status atomically', () => {
    expect(
      buildWorkItemBoardColumnPatch({
        column: 'Done',
        state: 'Closed',
        isDone: false,
        columnFieldReferenceName: 'WEF_BOARD_Kanban.Column',
        doneFieldReferenceName: 'WEF_BOARD_Kanban.Column.Done',
      }),
    ).toEqual([
      { op: 'add', path: '/fields/System.State', value: 'Closed' },
      {
        op: 'add',
        path: '/fields/WEF_BOARD_Kanban.Column',
        value: 'Done',
      },
      {
        op: 'add',
        path: '/fields/WEF_BOARD_Kanban.Column.Done',
        value: false,
      },
    ]);
  });

  it('rejects empty column and state values', () => {
    expect(() =>
      buildWorkItemBoardColumnPatch({
        column: ' ',
        state: 'Active',
        isDone: false,
        columnFieldReferenceName: 'WEF_BOARD_Kanban.Column',
        doneFieldReferenceName: 'WEF_BOARD_Kanban.Column.Done',
      }),
    ).toThrow('column cannot be empty');
    expect(() =>
      buildWorkItemBoardColumnPatch({
        column: 'Doing',
        state: ' ',
        isDone: false,
        columnFieldReferenceName: 'WEF_BOARD_Kanban.Column',
        doneFieldReferenceName: 'WEF_BOARD_Kanban.Column.Done',
      }),
    ).toThrow('state cannot be empty');
  });
});

describe('resolveWorkItemBoardColumnUpdate', () => {
  const columns: Parameters<
    typeof resolveWorkItemBoardColumnUpdate
  >[0]['columns'] = [
    {
      id: 'doing',
      name: 'Doing',
      stateMappings: { Bug: 'Active' },
    },
    {
      id: 'done',
      name: 'Done',
      columnType: 'outgoing',
      stateMappings: { Bug: 'Closed', Task: 'Closed' },
    },
  ];

  it('derives state and done status from server board mappings', () => {
    expect(
      resolveWorkItemBoardColumnUpdate({
        columns,
        workItemType: 'Bug',
        column: 'Done',
      }),
    ).toEqual({ column: 'Done', state: 'Closed', isDone: false });
  });

  it('rejects unknown and unmapped columns', () => {
    expect(() =>
      resolveWorkItemBoardColumnUpdate({
        columns,
        workItemType: 'Bug',
        column: 'Missing',
      }),
    ).toThrow('Board column not found');
    expect(() =>
      resolveWorkItemBoardColumnUpdate({
        columns,
        workItemType: 'Task',
        column: 'Doing',
      }),
    ).toThrow('not mapped for Task');
  });
});

describe('board column configuration and updates', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns custom-type board columns with stable board identity', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/_apis/projects/project-1/teams')) {
        return jsonResponse(
          { value: [{ id: 'team-1', name: 'Project Team' }] },
          { ok: true },
        );
      }
      if (url.endsWith('/Project%20Team/_apis/work/boards?api-version=7.1')) {
        return jsonResponse(
          { value: [{ id: 'board-1', name: 'Custom Items' }] },
          { ok: true },
        );
      }
      if (url.includes('/_apis/work/boards/board-1?')) {
        return jsonResponse(
          {
            id: 'board-1',
            name: 'Custom Items',
            columns: [
              {
                id: 'ready',
                name: 'Ready',
                stateMappings: { 'Custom Request': 'Ready' },
              },
            ],
            fields: {
              columnField: { referenceName: 'WEF_BOARD_Kanban.Column' },
              doneField: { referenceName: 'WEF_BOARD_Kanban.Column.Done' },
            },
          },
          { ok: true },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      getBoardColumns({
        providerId: 'provider-1',
        projectId: 'project-1',
        projectName: 'Project',
      }),
    ).resolves.toEqual([
      {
        id: 'ready',
        name: 'Ready',
        stateMappings: { 'Custom Request': 'Ready' },
        teamId: 'team-1',
        boardId: 'board-1',
      },
    ]);
  });

  it('updates exact selected board writable fields', async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/_apis/wit/workitems/55778?')) {
        if (init?.method === 'PATCH') return jsonResponse({}, { ok: true });
        return jsonResponse(
          {
            id: 55778,
            url: 'api-55778',
            fields: {
              'System.Title': 'Request',
              'System.WorkItemType': 'Custom Request',
              'System.TeamProject': 'Project',
              'System.State': 'New',
            },
          },
          { ok: true },
        );
      }
      if (url.includes('/Project/team-2/_apis/work/boards/board-2?')) {
        return jsonResponse(
          {
            id: 'board-2',
            name: 'Requests',
            columns: [
              {
                id: 'ready',
                name: 'Ready for development',
                stateMappings: { 'Custom Request': 'Ready' },
              },
            ],
            fields: {
              columnField: { referenceName: 'WEF_EXACT_Kanban.Column' },
              doneField: { referenceName: 'WEF_EXACT_Kanban.Column.Done' },
            },
          },
          { ok: true },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await updateWorkItemBoardColumn({
      providerId: 'provider-1',
      projectId: 'project-1',
      projectName: 'Project',
      workItemId: 55778,
      column: 'Ready for development',
      teamId: 'team-2',
      boardId: 'board-2',
    });

    const patchCall = vi.mocked(fetch).mock.calls.find(
      ([, init]) => init?.method === 'PATCH',
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual([
      { op: 'add', path: '/fields/System.State', value: 'Ready' },
      {
        op: 'add',
        path: '/fields/WEF_EXACT_Kanban.Column',
        value: 'Ready for development',
      },
      {
        op: 'add',
        path: '/fields/WEF_EXACT_Kanban.Column.Done',
        value: false,
      },
    ]);
  });
});

function jsonResponse(body: unknown, init: { ok: boolean; status?: number }) {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 400),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function workItemResponse(id: number) {
  return {
    id,
    url: `api-${id}`,
    fields: {
      'System.Title': `Item ${id}`,
      'System.WorkItemType': 'User Story',
      'System.State': 'Active',
    },
    relations: [
      {
        rel: 'System.LinkTypes.Hierarchy-Forward',
        url: `https://example/_apis/wit/workItems/${id + 10_000}`,
        attributes: {},
      },
    ],
  };
}

describe('uploadPullRequestAttachment', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses a content hash suffix and retries when Azure reports a duplicate attachment name', async () => {
    const dataBase64 = Buffer.from('image').toString('base64');

    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/_apis/profile/profiles/me')) {
        return jsonResponse(
          {
            id: 'profile-id',
            displayName: 'PR Owner',
            emailAddress: 'owner@example.com',
          },
          { ok: true },
        );
      }

      if (url.includes('/_apis/connectionData')) {
        return jsonResponse(
          { authenticatedUser: { id: 'owner-id' } },
          { ok: true },
        );
      }

      if (url.includes('/pullrequests/123?')) {
        return jsonResponse(
          {
            pullRequestId: 123,
            title: 'Test PR',
            status: 'active',
            isDraft: false,
            createdBy: {
              id: 'owner-id',
              displayName: 'PR Owner',
              uniqueName: 'owner@example.com',
            },
            creationDate: '2026-01-01T00:00:00Z',
            sourceRefName: 'refs/heads/feature',
            targetRefName: 'refs/heads/main',
          },
          { ok: true },
        );
      }

      if (url.includes('/attachments/image-6105d6cc.png?')) {
        return jsonResponse(
          {
            message:
              "The attachment with file name 'image-6105d6cc.png' already exists.",
          },
          { ok: false, status: 400 },
        );
      }

      if (url.includes('/attachments/image-6105d6cc-1.png?')) {
        return jsonResponse(
          {
            url: 'https://dev.azure.com/org/project/_apis/attachment/image-6105d6cc-1.png',
          },
          { ok: true },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      uploadPullRequestAttachment({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
        fileName: 'image.png',
        mimeType: 'image/png',
        dataBase64,
      }),
    ).resolves.toEqual({
      url: 'https://dev.azure.com/org/project/_apis/attachment/image-6105d6cc-1.png',
    });

    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls).toContain(
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/123/attachments/image-6105d6cc.png?api-version=7.1-preview.1',
    );
    expect(urls).toContain(
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/123/attachments/image-6105d6cc-1.png?api-version=7.1-preview.1',
    );
  });
});

describe('addWorkItemComment', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('posts work item comments as markdown so mention tokens resolve', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          id: 50,
          workItemId: 299,
          text: '@<09c05d5e-5817-4b65-b3f2-07f1c8047f52> please review',
          renderedText:
            '<p><a href="#" data-vss-mention="version:2.0,09c05d5e-5817-4b65-b3f2-07f1c8047f52">@Patrick Lin</a> please review</p>',
          createdBy: { displayName: 'Patrick Lin' },
          createdDate: '2026-01-01T00:00:00Z',
        },
        { ok: true },
      ),
    );

    const comment = await addWorkItemComment({
      providerId: 'provider-1',
      projectName: 'Project Name',
      workItemId: 299,
      text: '@<09c05d5e-5817-4b65-b3f2-07f1c8047f52> please review',
    });

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://dev.azure.com/org/Project%20Name/_apis/wit/workItems/299/comments?format=markdown&api-version=7.0-preview.4',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          text: '@<09c05d5e-5817-4b65-b3f2-07f1c8047f52> please review',
        }),
      }),
    );
    expect(comment.text).toContain('@Patrick Lin');
    expect(comment.format).toBe('html');
  });

  it('uses rendered comment HTML so mentions display without identity lookup', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          comments: [
            {
              id: 50,
              workItemId: 299,
              text: '@<09c05d5e-5817-4b65-b3f2-07f1c8047f52> please review',
              renderedText:
                '<p><a href="#" data-vss-mention="version:2.0,09c05d5e-5817-4b65-b3f2-07f1c8047f52">@Patrick Lin</a> please review</p>',
              createdBy: { displayName: 'Patrick Lin' },
              createdDate: '2026-01-01T00:00:00Z',
            },
          ],
        },
        { ok: true },
      ),
    );

    await expect(
      getWorkItemComments({
        providerId: 'provider-1',
        projectName: 'Project Name',
        workItemId: 299,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        text: '<p><a href="#" data-vss-mention="version:2.0,09c05d5e-5817-4b65-b3f2-07f1c8047f52">@Patrick Lin</a> please review</p>',
        format: 'html',
      }),
    ]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      'https://dev.azure.com/org/Project%20Name/_apis/wit/workItems/299/comments?api-version=7.0-preview.4&$top=50&order=desc&$expand=renderedText',
    );
  });

  it('expands relative work item attachment URLs in rendered comments', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          comments: [
            {
              id: 50,
              workItemId: 299,
              text: '![Image]( /70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png)',
              renderedText:
                '<p>![Image]( /70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png)</p>',
              createdBy: { displayName: 'Patrick Lin' },
              createdDate: '2026-01-01T00:00:00Z',
            },
          ],
        },
        { ok: true },
      ),
    );

    await expect(
      getWorkItemComments({
        providerId: 'provider-1',
        projectName: 'Project Name',
        workItemId: 299,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        text: '<p>![Image](https://dev.azure.com/org/Project%20Name/_apis/wit/attachments/70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png)</p>',
        format: 'html',
      }),
    ]);
  });

  it('falls back to raw markdown when Azure returns blank rendered HTML', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          comments: [
            {
              id: 50,
              workItemId: 299,
              text: 'Line one\nLine two\n\n![image.png]( /70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png)',
              renderedText: '',
              createdBy: { displayName: 'Patrick Lin' },
              createdDate: '2026-01-01T00:00:00Z',
            },
          ],
        },
        { ok: true },
      ),
    );

    await expect(
      getWorkItemComments({
        providerId: 'provider-1',
        projectName: 'Project Name',
        workItemId: 299,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        text: 'Line one\nLine two\n\n![image.png](https://dev.azure.com/org/Project%20Name/_apis/wit/attachments/70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=image.png)',
        format: 'markdown',
      }),
    ]);
  });
});

describe('setPullRequestAutoComplete', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends optional policy ids in completion options', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          pullRequestId: 123,
          title: 'Test PR',
          status: 'active',
          isDraft: false,
          createdBy: {
            id: 'owner-id',
            displayName: 'PR Owner',
            uniqueName: 'owner@example.com',
          },
          creationDate: '2026-01-01T00:00:00Z',
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
          autoCompleteSetBy: {
            id: 'owner-id',
            displayName: 'PR Owner',
          },
          completionOptions: {
            mergeStrategy: 'squash',
            deleteSourceBranch: true,
            transitionWorkItems: false,
            autoCompleteIgnoreConfigIds: [11, 22],
          },
        },
        { ok: true },
      ),
    );

    await expect(
      setPullRequestAutoComplete({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
        enabled: true,
        autoCompleteSetById: 'owner-id',
        completionOptions: {
          mergeStrategy: 'squash',
          deleteSourceBranch: true,
          transitionWorkItems: false,
          autoCompleteIgnoreConfigIds: [11, 22],
        },
      }),
    ).resolves.toMatchObject({
      completionOptions: {
        mergeStrategy: 'squash',
        deleteSourceBranch: true,
        transitionWorkItems: false,
        autoCompleteIgnoreConfigIds: [11, 22],
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/pullrequests/123?api-version=7.0',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          autoCompleteSetBy: { id: 'owner-id' },
          completionOptions: {
            mergeStrategy: 'squash',
            deleteSourceBranch: true,
            transitionWorkItems: false,
            autoCompleteIgnoreConfigIds: [11, 22],
          },
        }),
      }),
    );
  });
});

describe('updatePullRequestTitle', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('patches title without requiring current user to own the PR', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          pullRequestId: 123,
          title: 'Updated PR',
          status: 'active',
          isDraft: false,
          createdBy: {
            id: 'owner-id',
            displayName: 'PR Owner',
            uniqueName: 'owner@example.com',
          },
          creationDate: '2026-01-01T00:00:00Z',
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
        },
        { ok: true },
      ),
    );

    await expect(
      updatePullRequestTitle({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
        title: '  Updated PR  ',
      }),
    ).resolves.toMatchObject({ title: 'Updated PR' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/pullrequests/123?api-version=7.0',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Updated PR' }),
      }),
    );
  });
});

describe('getPullRequestFileContent', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('loads base content from PR iteration common commit instead of target branch head', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/pullrequests/123/iterations?')) {
        return jsonResponse(
          {
            count: 1,
            value: [
              {
                id: 7,
                commonRefCommit: { commitId: 'common-commit' },
                sourceRefCommit: { commitId: 'source-commit' },
                targetRefCommit: { commitId: 'target-commit' },
              },
            ],
          },
          { ok: true },
        );
      }

      if (
        url.includes('/items?') &&
        url.includes('versionDescriptor.version=common-commit') &&
        url.includes('versionDescriptor.versionType=commit')
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => 'base content',
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      getPullRequestFileContent({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
        filePath: '/src/file.ts',
        version: 'base',
      }),
    ).resolves.toBe('base content');

    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes('versionType=branch'))).toBe(false);
    expect(urls).toContain(
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/items?path=%2Fsrc%2Ffile.ts&versionDescriptor.version=common-commit&versionDescriptor.versionType=commit&api-version=7.0',
    );
  });

  it('loads head content from PR iteration source commit', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/pullrequests/123/iterations?')) {
        return jsonResponse(
          {
            count: 1,
            value: [
              {
                id: 7,
                commonRefCommit: { commitId: 'common-commit' },
                sourceRefCommit: { commitId: 'source-commit' },
                targetRefCommit: { commitId: 'target-commit' },
              },
            ],
          },
          { ok: true },
        );
      }

      if (
        url.includes('/items?') &&
        url.includes('versionDescriptor.version=source-commit') &&
        url.includes('versionDescriptor.versionType=commit')
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => 'head content',
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      getPullRequestFileContent({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
        filePath: '/src/file.ts',
        version: 'head',
      }),
    ).resolves.toBe('head content');

    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls).toContain(
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/items?path=%2Fsrc%2Ffile.ts&versionDescriptor.version=source-commit&versionDescriptor.versionType=commit&api-version=7.0',
    );
  });

  it('falls back to PR iteration target commit when common commit is absent', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/pullrequests/123/iterations?')) {
        return jsonResponse(
          {
            count: 1,
            value: [
              {
                id: 7,
                sourceRefCommit: { commitId: 'source-commit' },
                targetRefCommit: { commitId: 'target-commit' },
              },
            ],
          },
          { ok: true },
        );
      }

      if (
        url.includes('/items?') &&
        url.includes('versionDescriptor.version=target-commit') &&
        url.includes('versionDescriptor.versionType=commit')
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => 'target content',
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      getPullRequestFileContent({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
        filePath: '/src/file.ts',
        version: 'base',
      }),
    ).resolves.toBe('target content');

    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls).toContain(
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/items?path=%2Fsrc%2Ffile.ts&versionDescriptor.version=target-commit&versionDescriptor.versionType=commit&api-version=7.0',
    );
  });
});

describe('getPullRequestStatuses', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('includes active thread count for active PRs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/threads?')) {
          return jsonResponse(
            {
              count: 2,
              value: [
                {
                  id: 1,
                  status: 'active',
                  isDeleted: false,
                  comments: [
                    {
                      id: 1,
                      content: 'Needs work',
                      commentType: 'text',
                      author: { id: 'user-1', displayName: 'Reviewer' },
                      publishedDate: '2026-01-01T00:00:00Z',
                      lastUpdatedDate: '2026-01-01T00:00:00Z',
                    },
                  ],
                },
                {
                  id: 2,
                  status: 'closed',
                  isDeleted: false,
                  comments: [
                    {
                      id: 2,
                      content: 'Resolved',
                      commentType: 'text',
                      author: { id: 'user-1', displayName: 'Reviewer' },
                      publishedDate: '2026-01-01T00:00:00Z',
                      lastUpdatedDate: '2026-01-01T00:00:00Z',
                    },
                  ],
                },
              ],
            },
            { ok: true },
          );
        }

        return jsonResponse(
          {
            status: 'active',
            isDraft: false,
            mergeStatus: 'succeeded',
            pullRequestId: 123,
            repository: {
              name: 'repo',
              project: { name: 'project' },
            },
            reviewers: [],
          },
          { ok: true },
        );
      }),
    );

    const statuses = await getPullRequestStatuses({
      providerId: 'provider-1',
      linkedPrs: [{ prId: 123, projectId: 'project', repoId: 'repo' }],
      includeActiveThreadCount: true,
    });

    expect(statuses.get('project:repo:123')).toMatchObject({
      status: 'active',
      activeThreadCount: 1,
    });
  });
});

describe('getPullRequestThreads', () => {
  beforeEach(() => {
    findProviderByIdMock.mockResolvedValue({
      tokenId: 'token-1',
      baseUrl: 'https://dev.azure.com/org',
    });
    getDecryptedTokenMock.mockResolvedValue('pat');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('maps thread iteration source commit for original comment code', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/pullrequests/123/threads?')) {
        return jsonResponse(
          {
            count: 1,
            value: [
              {
                id: 9,
                status: 'active',
                isDeleted: false,
                threadContext: {
                  filePath: '/src/file.ts',
                  rightFileStart: { line: 12 },
                  rightFileEnd: { line: 14 },
                },
                pullRequestThreadContext: {
                  iterationContext: {
                    firstComparingIteration: 1,
                    secondComparingIteration: 2,
                  },
                },
                comments: [
                  {
                    id: 1,
                    content: 'Please update this.',
                    commentType: 'text',
                    author: {
                      id: 'user-1',
                      displayName: 'Reviewer',
                      uniqueName: 'reviewer@example.com',
                    },
                    publishedDate: '2026-01-01T00:00:00Z',
                    lastUpdatedDate: '2026-01-01T00:00:00Z',
                  },
                ],
              },
            ],
          },
          { ok: true },
        );
      }

      if (url.includes('/pullrequests/123/iterations?')) {
        return jsonResponse(
          {
            count: 2,
            value: [
              { id: 1, sourceRefCommit: { commitId: 'source-1' } },
              { id: 2, sourceRefCommit: { commitId: 'source-2' } },
            ],
          },
          { ok: true },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      getPullRequestThreads({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
      }),
    ).resolves.toMatchObject([
      {
        threadContext: {
          filePath: '/src/file.ts',
          rightFileStart: { line: 12 },
          rightFileEnd: { line: 14 },
          originalCommitId: 'source-2',
        },
      },
    ]);
  });

  it('excludes deleted comments whose content Azure omits', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          count: 2,
          value: [
            {
              id: 9,
              status: 'active',
              isDeleted: false,
              comments: [
                {
                  id: 1,
                  content: 'Keep this comment.',
                  commentType: 'text',
                  isDeleted: false,
                  author: {
                    id: 'user-1',
                    displayName: 'Reviewer',
                    uniqueName: 'reviewer@example.com',
                  },
                  publishedDate: '2026-01-01T00:00:00Z',
                  lastUpdatedDate: '2026-01-01T00:00:00Z',
                },
                {
                  id: 2,
                  commentType: 'text',
                  isDeleted: true,
                  author: {
                    id: 'user-1',
                    displayName: 'Reviewer',
                    uniqueName: 'reviewer@example.com',
                  },
                  publishedDate: '2026-01-01T00:00:00Z',
                  lastUpdatedDate: '2026-01-01T00:00:00Z',
                },
              ],
            },
            {
              id: 10,
              status: 'active',
              isDeleted: false,
              comments: [
                {
                  id: 3,
                  content: 'Deleted content may still be returned.',
                  commentType: 'text',
                  isDeleted: true,
                  author: {
                    id: 'user-1',
                    displayName: 'Reviewer',
                    uniqueName: 'reviewer@example.com',
                  },
                  publishedDate: '2026-01-01T00:00:00Z',
                  lastUpdatedDate: '2026-01-01T00:00:00Z',
                },
              ],
            },
          ],
        },
        { ok: true },
      ),
    );

    await expect(
      getPullRequestThreads({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 9,
        comments: [expect.objectContaining({ id: 1, content: 'Keep this comment.' })],
      }),
    ]);
  });

  it('keeps threads when original iteration lookup fails', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/pullrequests/123/threads?')) {
        return jsonResponse(
          {
            count: 1,
            value: [
              {
                id: 9,
                status: 'active',
                isDeleted: false,
                threadContext: {
                  filePath: '/src/file.ts',
                  rightFileStart: { line: 12 },
                  rightFileEnd: { line: 14 },
                },
                pullRequestThreadContext: {
                  iterationContext: {
                    firstComparingIteration: 1,
                    secondComparingIteration: 2,
                  },
                },
                comments: [
                  {
                    id: 1,
                    content: 'Please update this.',
                    commentType: 'text',
                    author: {
                      id: 'user-1',
                      displayName: 'Reviewer',
                      uniqueName: 'reviewer@example.com',
                    },
                    publishedDate: '2026-01-01T00:00:00Z',
                    lastUpdatedDate: '2026-01-01T00:00:00Z',
                  },
                ],
              },
            ],
          },
          { ok: true },
        );
      }

      if (url.includes('/pullrequests/123/iterations?')) {
        return jsonResponse({ message: 'nope' }, { ok: false, status: 500 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      getPullRequestThreads({
        providerId: 'provider-1',
        projectId: 'project',
        repoId: 'repo',
        pullRequestId: 123,
      }),
    ).resolves.toMatchObject([
      {
        id: 9,
        threadContext: {
          filePath: '/src/file.ts',
          rightFileStart: { line: 12 },
          rightFileEnd: { line: 14 },
        },
      },
    ]);
  });
});
