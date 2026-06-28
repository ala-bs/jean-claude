import { describe, expect, it, vi } from 'vitest';

import {
  AskQuestionBridgeError,
  askQuestionViaBridge,
} from './ask-question-bridge';

const input = {
  questions: [
    {
      id: 'approach',
      type: 'single_choice',
      label: 'Which approach?',
      header: 'Approach',
      options: [
        {
          id: 'small',
          label: 'Small change',
          description: 'Keep the change scoped',
        },
      ],
    },
    {
      id: 'constraints',
      type: 'multi_choice',
      label: 'Which constraints matter?',
      allowOther: true,
    },
    {
      id: 'notes',
      type: 'text',
      label: 'Any notes?',
      required: false,
    },
  ],
};

describe('askQuestionViaBridge', () => {
  it('posts questions to the per-session HTTP bridge and returns the summary', async () => {
    const env = await createQuestionBridgeEnv();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ summary: 'Which approach?: Small change' }), {
        status: 200,
      }),
    );

    const result = await askQuestionViaBridge({ input, env, fetchImpl });

    expect(result).toBe('Which approach?: Small change');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'http://127.0.0.1:4321/session-bridge/ask-question',
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: 'session-1',
      questions: input.questions,
    });
  });

  it('posts stepId to the app-scoped HTTP bridge when no session id is configured', async () => {
    const env = createQuestionBridgeEnv({
      serverUrl: 'http://127.0.0.1:4321/app-bridge',
      sessionId: undefined,
      token: 'secret-token',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ summary: 'Which approach?: Small change' }), {
        status: 200,
      }),
    );

    const result = await askQuestionViaBridge({
      input: { ...input, stepId: 'step-1' },
      env,
      fetchImpl,
    });

    expect(result).toBe('Which approach?: Small change');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({
      stepId: 'step-1',
      questions: input.questions,
    });
  });

  it('can omit stepId for app-scoped bridge requests', async () => {
    const env = createQuestionBridgeEnv({
      serverUrl: 'http://127.0.0.1:4321/app-bridge',
      sessionId: undefined,
      token: 'secret-token',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ summary: 'Which approach?: Small change' }), {
        status: 200,
      }),
    );

    await askQuestionViaBridge({
      input,
      env,
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({
      questions: input.questions,
    });
  });

  it('uses env step routing for app-scoped bridge requests', async () => {
    const env = createQuestionBridgeEnv({
      serverUrl: 'http://127.0.0.1:4321/app-bridge',
      sessionId: undefined,
      stepId: 'step-from-env',
      registrationId: 'registration-1',
      token: 'secret-token',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ summary: 'Which approach?: Small change' }), {
        status: 200,
      }),
    );

    await askQuestionViaBridge({ input, env, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({
      stepId: 'step-from-env',
      registrationId: 'registration-1',
      questions: input.questions,
    });
  });

  it('requires bridge environment variables', async () => {
    await expect(
      askQuestionViaBridge({
        input,
        env: {},
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(AskQuestionBridgeError);
    await expect(
      askQuestionViaBridge({
        input,
        env: {},
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow('Missing question bridge environment');
  });

  it('rejects incomplete question bridge environment variables', async () => {
    const env = createQuestionBridgeEnv({
      serverUrl: '',
      sessionId: 'session-1',
      token: 'secret-token',
    });

    await expect(
      askQuestionViaBridge({
        input,
        env,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow('Missing question bridge environment');
  });

  it('rejects invalid question input before sending a request', async () => {
    const env = await createQuestionBridgeEnv();
    const fetchImpl = vi.fn();

    await expect(
      askQuestionViaBridge({
        input: {
          questions: [
            {
              id: 'choice',
              type: 'single_choice',
              label: 'Pick one',
            },
          ],
        },
        env,
        fetchImpl,
      }),
    ).rejects.toThrow('Invalid ask_question input');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects duplicate question ids', async () => {
    const env = await createQuestionBridgeEnv();

    await expect(
      askQuestionViaBridge({
        input: {
          questions: [
            { id: 'duplicate', type: 'text', label: 'First' },
            { id: 'duplicate', type: 'text', label: 'Second' },
          ],
        },
        env,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow('Question ids must be unique');
  });

  it('rejects option ids with surrounding whitespace', async () => {
    const env = await createQuestionBridgeEnv();

    await expect(
      askQuestionViaBridge({
        input: {
          questions: [
            {
              id: 'approach',
              type: 'single_choice',
              label: 'Which approach?',
              options: [{ id: ' small ', label: 'Small' }],
            },
          ],
        },
        env,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow('Invalid ask_question input');
  });

  it('rejects allowOther on text questions', async () => {
    const env = await createQuestionBridgeEnv();

    await expect(
      askQuestionViaBridge({
        input: {
          questions: [
            {
              id: 'notes',
              type: 'text',
              label: 'Any notes?',
              allowOther: true,
            },
          ],
        },
        env,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow('Invalid ask_question input');
  });

  it('turns bridge non-2xx responses into tool errors', async () => {
    const env = await createQuestionBridgeEnv();
    await expect(
      askQuestionViaBridge({
        input,
        env,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response('request cancelled', {
            status: 409,
          }),
        ),
      }),
    ).rejects.toThrow('Question bridge returned 409: request cancelled');
  });

  it('rejects malformed bridge responses', async () => {
    const env = await createQuestionBridgeEnv();
    await expect(
      askQuestionViaBridge({
        input,
        env,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ result: 'missing summary' }), {
            status: 200,
          }),
        ),
      }),
    ).rejects.toThrow('Question bridge returned malformed response');
  });
});

function createQuestionBridgeEnv(
  config = {
    serverUrl: 'http://127.0.0.1:4321/session-bridge',
    sessionId: 'session-1' as string | undefined,
    stepId: undefined as string | undefined,
    registrationId: undefined as string | undefined,
    token: 'secret-token',
  } as {
    serverUrl: string;
    sessionId?: string;
    stepId?: string;
    registrationId?: string;
    token: string;
  },
): NodeJS.ProcessEnv {
  return {
    JC_MCP_BRIDGE_URL: config.serverUrl,
    JC_MCP_AUTH_TOKEN: config.token,
    ...(config.sessionId !== undefined
      ? { JC_MCP_SESSION_ID: config.sessionId }
      : {}),
    ...(config.stepId !== undefined ? { JC_MCP_STEP_ID: config.stepId } : {}),
    ...(config.registrationId !== undefined
      ? { JC_MCP_REGISTRATION_ID: config.registrationId }
      : {}),
  };
}
