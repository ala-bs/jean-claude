import http from 'http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type QuestionHttpBridgeHandle,
  QuestionHttpBridgeService,
} from './question-http-bridge-service';
import { QuestionBrokerService } from './question-broker-service';

const QUESTIONS = [
  {
    id: 'approach',
    type: 'single_choice' as const,
    label: 'Which approach?',
    options: [{ label: 'Small' }, { label: 'Large' }],
  },
];

describe('question-http-bridge-service', () => {
  let handle: QuestionHttpBridgeHandle | null = null;

  afterEach(async () => {
    await handle?.close('test cleanup');
    handle = null;
  });

  it('rejects requests without the session bearer token', async () => {
    const broker = new QuestionBrokerService();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest: vi.fn(),
    });

    const response = await fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'session-1',
        questions: QUESTIONS,
      }),
    });

    expect(response.status).toBe(401);
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('rejects requests for the wrong session', async () => {
    const broker = new QuestionBrokerService();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest: vi.fn(),
    });

    const response = await fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-2',
        questions: QUESTIONS,
      }),
    });

    expect(response.status).toBe(403);
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('returns direct bridge environment values without writing config files', async () => {
    const broker = new QuestionBrokerService();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest: vi.fn(),
    });

    expect(handle.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.sessionId).toBe('session-1');
    expect(handle.token).toMatch(/^[a-f0-9]{64}$/);
    expect(handle).not.toHaveProperty('configPath');
  });

  it('creates a broker request, waits for an answer, and returns a summary', async () => {
    const broker = new QuestionBrokerService();
    const onQuestionRequest = vi.fn(async (request) => {
      broker.answerRequest(request.requestId, { approach: 'Small' });
    });
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest,
    });

    const response = await fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        questions: QUESTIONS,
      }),
    });

    await expect(response.json()).resolves.toEqual({
      summary: 'Which approach?: Small',
    });
    expect(response.status).toBe(200);
    expect(onQuestionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            id: 'approach',
            question: 'Which approach?',
          }),
        ],
      }),
    );
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('routes app-scoped requests by stepId', async () => {
    const broker = new QuestionBrokerService();
    const onStep1QuestionRequest = vi.fn(async (request) => {
      broker.answerRequest(request.requestId, { approach: 'Small' });
    });
    const onStep2QuestionRequest = vi.fn(async (request) => {
      broker.answerRequest(request.requestId, { approach: 'Large' });
    });
    handle = await new QuestionHttpBridgeService(broker).start({
      routes: [
        {
          taskId: 'task-1',
          stepId: 'step-1',
          onQuestionRequest: onStep1QuestionRequest,
        },
        {
          taskId: 'task-2',
          stepId: 'step-2',
          onQuestionRequest: onStep2QuestionRequest,
        },
      ],
    });

    const response = await fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        stepId: 'step-2',
        questions: QUESTIONS,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      summary: 'Which approach?: Large',
    });
    expect(onStep1QuestionRequest).not.toHaveBeenCalled();
    expect(onStep2QuestionRequest).toHaveBeenCalledTimes(1);
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
    expect(broker.getPendingRequestsForStep('step-2')).toHaveLength(0);
  });

  it('rejects app-scoped requests with missing or unknown stepId', async () => {
    const broker = new QuestionBrokerService();
    const onQuestionRequest = vi.fn();
    handle = await new QuestionHttpBridgeService(broker).start({
      routes: [
        {
          taskId: 'task-1',
          stepId: 'step-1',
          onQuestionRequest,
        },
      ],
    });

    const missingStepResponse = await fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        questions: QUESTIONS,
      }),
    });
    const unknownStepResponse = await fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        stepId: 'step-2',
        questions: QUESTIONS,
      }),
    });

    expect(missingStepResponse.status).toBe(403);
    expect(unknownStepResponse.status).toBe(404);
    expect(onQuestionRequest).not.toHaveBeenCalled();
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('rejects duplicate app-scoped route stepIds', async () => {
    const broker = new QuestionBrokerService();

    await expect(
      new QuestionHttpBridgeService(broker).start({
        routes: [
          {
            taskId: 'task-1',
            stepId: 'step-1',
            onQuestionRequest: vi.fn(),
          },
          {
            taskId: 'task-2',
            stepId: 'step-1',
            onQuestionRequest: vi.fn(),
          },
        ],
      }),
    ).rejects.toThrow('Duplicate question bridge route stepId: step-1');
  });

  it('cancels pending broker requests when the bridge closes', async () => {
    const broker = new QuestionBrokerService();
    let requestId: string | null = null;
    const onQuestionCancelled = vi.fn();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
      }),
      onQuestionCancelled,
    });

    const responsePromise = fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        questions: QUESTIONS,
      }),
    });
    responsePromise.catch(() => {});

    await vi.waitFor(() => {
      expect(requestId).not.toBeNull();
    });

    await handle.close('cancelled by test');
    handle = null;

    const response = await responsePromise;
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('cancelled by test'),
    });
    expect(onQuestionCancelled).toHaveBeenCalledWith(requestId);
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('closes when shutdown starts while onQuestionRequest is still pending', async () => {
    const broker = new QuestionBrokerService();
    let requestId: string | null = null;
    const onQuestionCancelled = vi.fn();
    const pendingQuestionRequest = createDeferred<void>();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
        await pendingQuestionRequest.promise;
      }),
      onQuestionCancelled,
    });

    const responsePromise = fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        questions: QUESTIONS,
      }),
    });
    responsePromise.catch(() => {});

    await vi.waitFor(() => {
      expect(requestId).not.toBeNull();
    });

    await expect(withTimeout(handle.close('shutdown during notify'))).resolves.toBe(
      undefined,
    );
    handle = null;

    await expect(responsePromise).rejects.toThrow();
    expect(onQuestionCancelled).toHaveBeenCalledWith(requestId);
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('closes listener and sockets when onQuestionCancelled rejects during close', async () => {
    const broker = new QuestionBrokerService();
    let requestId: string | null = null;
    const onQuestionCancelled = vi.fn(async () => {
      throw new Error('cancel callback failed');
    });
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
      }),
      onQuestionCancelled,
    });

    const responsePromise = fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        questions: QUESTIONS,
      }),
    });
    responsePromise.catch(() => {});

    await vi.waitFor(() => {
      expect(requestId).not.toBeNull();
    });

    const serverUrl = handle.serverUrl;
    await expect(handle.close('shutdown with callback failure')).resolves.toBe(
      undefined,
    );
    handle = null;

    const response = await responsePromise;
    expect(response.status).toBe(500);
    expect(onQuestionCancelled).toHaveBeenCalledWith(requestId);
    await expect(fetch(`${serverUrl}/ask-question`)).rejects.toThrow();
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('cancels the broker request when the MCP HTTP client disconnects', async () => {
    const broker = new QuestionBrokerService();
    let requestId: string | null = null;
    const onQuestionCancelled = vi.fn();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
      }),
      onQuestionCancelled,
    });

    const req = http.request(
      new URL('/ask-question', handle.serverUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          'content-type': 'application/json',
        },
      },
      () => {},
    );
    req.on('error', () => {});
    req.end(
      JSON.stringify({
        sessionId: 'session-1',
        questions: QUESTIONS,
      }),
    );

    await vi.waitFor(() => {
      expect(requestId).not.toBeNull();
    });
    req.destroy();

    await vi.waitFor(() => {
      expect(onQuestionCancelled).toHaveBeenCalledWith(requestId);
    });
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('does not create a broker request when close starts while a request body is still reading', async () => {
    const broker = new QuestionBrokerService();
    const onQuestionRequest = vi.fn();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest,
    });

    const responsePromise = postQuestionInChunks({
      serverUrl: handle.serverUrl,
      token: handle.token,
      firstChunk: '{"sessionId":"session-1",',
      secondChunk: `"questions":${JSON.stringify(QUESTIONS)}}`,
    });
    responsePromise.catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 10));

    const closePromise = handle.close('cancelled while reading');
    handle = null;
    finishChunkedPost(responsePromise);

    await closePromise;

    await expect(responsePromise).rejects.toThrow('ECONNRESET');
    expect(onQuestionRequest).not.toHaveBeenCalled();
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('closes active sockets when a request body never finishes', async () => {
    const broker = new QuestionBrokerService();
    const onQuestionRequest = vi.fn();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest,
    });

    const responsePromise = postQuestionInChunks({
      serverUrl: handle.serverUrl,
      token: handle.token,
      firstChunk: '{"sessionId":"session-1",',
      secondChunk: `"questions":${JSON.stringify(QUESTIONS)}}`,
    });
    responsePromise.catch(() => {});

    await responsePromise.firstChunkWritten;

    await expect(handle.close('cancelled while body is incomplete')).resolves.toBe(
      undefined,
    );
    handle = null;

    expect(onQuestionRequest).not.toHaveBeenCalled();
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });

  it('cancels the broker request when notifying the agent service fails', async () => {
    const broker = new QuestionBrokerService();
    handle = await new QuestionHttpBridgeService(broker).start({
      taskId: 'task-1',
      stepId: 'step-1',
      sessionId: 'session-1',
      onQuestionRequest: vi.fn(async () => {
        throw new Error('agent-service failed');
      }),
    });

    const response = await fetch(`${handle.serverUrl}/ask-question`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        questions: QUESTIONS,
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'agent-service failed',
    });
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });
});

interface ChunkedPostResponse {
  statusCode: number;
  body: string;
}

interface ChunkedPostPromise extends Promise<ChunkedPostResponse> {
  endRequest: () => void;
  firstChunkWritten: Promise<void>;
}

function postQuestionInChunks({
  serverUrl,
  token,
  firstChunk,
  secondChunk,
}: {
  serverUrl: string;
  token: string;
  firstChunk: string;
  secondChunk: string;
}): ChunkedPostPromise {
  const url = new URL('/ask-question', serverUrl);
  let endRequest = () => {};
  let resolveFirstChunkWritten = () => {};
  const firstChunkWritten = new Promise<void>((resolve) => {
    resolveFirstChunkWritten = resolve;
  });
  const promise = new Promise<ChunkedPostResponse>((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(firstChunk, resolveFirstChunkWritten);
    endRequest = () => {
      req.end(secondChunk);
    };
  }) as ChunkedPostPromise;
  promise.endRequest = endRequest;
  promise.firstChunkWritten = firstChunkWritten;
  return promise;
}

function finishChunkedPost(promise: ChunkedPostPromise): void {
  promise.endRequest();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for promise'));
        }, 1000);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
