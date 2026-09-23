import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  executeMock,
  executeTakeFirstMock,
  limitMock,
  orderByMock,
  selectMock,
  selectFromMock,
  whereMock,
} =
  vi.hoisted(() => {
    const executeTakeFirstMock = vi.fn();
    const executeMock = vi.fn();
    const limitMock = vi.fn(() => ({
      executeTakeFirst: executeTakeFirstMock,
      execute: executeMock,
    }));
    // Mirrors Kysely's `$if`: the callback only runs when the condition holds.
    const ifMock = vi.fn(
      (condition: boolean, apply: (qb: unknown) => unknown) => {
        const self = { limit: limitMock, execute: executeMock, $if: ifMock };
        return condition ? apply(self) : self;
      },
    );
    const orderByMock = vi.fn(() => ({
      limit: limitMock,
      execute: executeMock,
      $if: ifMock,
    }));
    const whereMock = vi.fn();
    whereMock.mockImplementation(() => ({ where: whereMock, orderBy: orderByMock }));
    const selectMock = vi.fn(() => ({ where: whereMock }));
    const selectFromMock = vi.fn(() => ({ select: selectMock }));
    return {
      executeMock,
      executeTakeFirstMock,
      limitMock,
      orderByMock,
      selectMock,
      selectFromMock,
      whereMock,
    };
  });

vi.mock('../index', () => ({ db: { selectFrom: selectFromMock } }));

import {
  AgentMessageRepository,
  formatNormalizedDataForRawId,
} from './agent-messages';

describe('agent message raw mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps multiple normalized entries for one raw message', () => {
    const normalizedData = formatNormalizedDataForRawId([
      JSON.stringify({ type: 'thinking', value: 'Thinking' }),
      JSON.stringify({ type: 'assistant-message', value: 'Answer' }),
    ]);

    expect(normalizedData ? JSON.parse(normalizedData) : null).toEqual([
      { type: 'thinking', value: 'Thinking' },
      { type: 'assistant-message', value: 'Answer' },
    ]);
  });

  it('finds latest result for a step with a bounded indexed query', async () => {
    executeTakeFirstMock.mockResolvedValue({
      data: JSON.stringify({
        id: 'result-2',
        date: '2026-07-18T00:00:00.000Z',
        type: 'result',
        value: 'latest result',
        isError: false,
      }),
    });

    await expect(
      AgentMessageRepository.findLatestResultByStepId('step-1'),
    ).resolves.toBe('latest result');

    expect(selectFromMock).toHaveBeenCalledWith('agent_messages');
    expect(selectMock).toHaveBeenCalledWith(['agent_messages.data']);
    expect(whereMock).toHaveBeenCalledWith('agent_messages.stepId', '=', 'step-1');
    expect(whereMock).toHaveBeenCalledWith('agent_messages.type', '=', 'result');
    expect(orderByMock).toHaveBeenCalledWith(
      'agent_messages.messageIndex',
      'desc',
    );
    // executeTakeFirst does not add a LIMIT on its own, so without this the
    // query loads every result row for the step.
    expect(limitMock).toHaveBeenCalledWith(1);
  });

  it('loads a whole step in ascending order with no LIMIT', async () => {
    executeMock.mockResolvedValue([
      { data: JSON.stringify({ type: 'user-message', value: 'first' }) },
      { data: JSON.stringify({ type: 'assistant-message', value: 'second' }) },
    ]);

    await expect(
      AgentMessageRepository.findByStepId('step-1'),
    ).resolves.toEqual([
      { type: 'user-message', value: 'first' },
      { type: 'assistant-message', value: 'second' },
    ]);

    expect(orderByMock).toHaveBeenCalledWith(
      'agent_messages.messageIndex',
      'asc',
    );
    expect(limitMock).not.toHaveBeenCalled();
  });

  it('keeps the newest entries when limited, restoring ascending order', async () => {
    // The query runs DESC so the LIMIT keeps the tail; rows come back newest
    // first and must be reversed before returning.
    executeMock.mockResolvedValue([
      { data: JSON.stringify({ type: 'assistant-message', value: 'newest' }) },
      { data: JSON.stringify({ type: 'user-message', value: 'older' }) },
    ]);

    const result = await AgentMessageRepository.findByStepIdWithTruncation(
      'step-1',
      { limit: 2 },
    );

    expect(result.entries).toEqual([
      { type: 'user-message', value: 'older' },
      { type: 'assistant-message', value: 'newest' },
    ]);
    expect(orderByMock).toHaveBeenCalledWith(
      'agent_messages.messageIndex',
      'desc',
    );
    expect(limitMock).toHaveBeenCalledWith(2);
    // Row count equals the limit, so older entries were clipped.
    expect(result.truncated).toBe(true);
  });

  it('reports truncation from the row count, not the surviving entries', async () => {
    // A blank `data` row is filtered out after the LIMIT, so the returned entry
    // count is below the limit even though the query did clip older rows.
    executeMock.mockResolvedValue([
      { data: JSON.stringify({ type: 'assistant-message', value: 'newest' }) },
      { data: '' },
    ]);

    const result = await AgentMessageRepository.findByStepIdWithTruncation(
      'step-1',
      { limit: 2 },
    );

    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('treats a non-positive limit as unlimited rather than returning nothing', async () => {
    executeMock.mockResolvedValue([
      { data: JSON.stringify({ type: 'user-message', value: 'first' }) },
    ]);

    const result = await AgentMessageRepository.findByStepIdWithTruncation(
      'step-1',
      { limit: 0 },
    );

    expect(result.entries).toEqual([{ type: 'user-message', value: 'first' }]);
    expect(result.truncated).toBe(false);
    expect(limitMock).not.toHaveBeenCalled();
    expect(orderByMock).toHaveBeenCalledWith(
      'agent_messages.messageIndex',
      'asc',
    );
  });

  it('does not report truncation when the step fits under the limit', async () => {
    executeMock.mockResolvedValue([
      { data: JSON.stringify({ type: 'user-message', value: 'first' }) },
    ]);

    await expect(
      AgentMessageRepository.findByStepIdWithTruncation('step-1', { limit: 5 }),
    ).resolves.toMatchObject({ truncated: false });
  });

  it('returns null for malformed or valueless latest result rows', async () => {
    executeTakeFirstMock.mockResolvedValue({ data: '{bad json' });
    await expect(
      AgentMessageRepository.findLatestResultByStepId('step-1'),
    ).resolves.toBeNull();

    executeTakeFirstMock.mockResolvedValue({
      data: JSON.stringify({ type: 'result', isError: false }),
    });
    await expect(
      AgentMessageRepository.findLatestResultByStepId('step-1'),
    ).resolves.toBeNull();
  });
});
