import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  executeTakeFirstMock,
  limitMock,
  orderByMock,
  selectMock,
  selectFromMock,
  whereMock,
} =
  vi.hoisted(() => {
    const executeTakeFirstMock = vi.fn();
    const limitMock = vi.fn(() => ({ executeTakeFirst: executeTakeFirstMock }));
    const orderByMock = vi.fn(() => ({ limit: limitMock }));
    const whereMock = vi.fn();
    whereMock.mockImplementation(() => ({ where: whereMock, orderBy: orderByMock }));
    const selectMock = vi.fn(() => ({ where: whereMock }));
    const selectFromMock = vi.fn(() => ({ select: selectMock }));
    return {
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
