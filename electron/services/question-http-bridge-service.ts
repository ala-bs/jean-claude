import type { Socket } from 'net';

import http from 'http';
import { randomBytes } from 'crypto';

import type { NormalizedQuestionRequest } from '@shared/agent-backend-types';

import {
  type BrokerQuestionRequest,
  QuestionBrokerService,
  type QuestionSpec,
} from './question-broker-service';

const MAX_BODY_BYTES = 1024 * 1024;

export interface QuestionHttpBridgeHandle {
  serverUrl: string;
  sessionId: string;
  token: string;
  close: (reason?: string) => Promise<void>;
}

interface QuestionHttpBridgeRoute {
  taskId: string;
  stepId: string;
  sessionId?: string;
  onQuestionRequest: (request: NormalizedQuestionRequest) => Promise<void>;
  onQuestionCancelled?: (requestId: string) => Promise<void> | void;
}

type QuestionHttpBridgeStartOptions =
  | (QuestionHttpBridgeRoute & { sessionId: string })
  | {
      routes: QuestionHttpBridgeRoute[];
    };

export class QuestionHttpBridgeService {
  constructor(private readonly broker: QuestionBrokerService) {}

  async start(
    options: QuestionHttpBridgeStartOptions,
  ): Promise<QuestionHttpBridgeHandle> {
    const routeMode = 'routes' in options ? 'app' : 'session';
    const routes = 'routes' in options ? options.routes : [options];
    if (routeMode === 'app') {
      assertUniqueRouteStepIds(routes);
    }
    const routeByStepId = new Map(routes.map((route) => [route.stepId, route]));
    const routeBySessionId = new Map(
      routes.flatMap((route) =>
        route.sessionId ? ([[route.sessionId, route]] as const) : [],
      ),
    );
    const sessionId = 'routes' in options ? '' : options.sessionId;
    const token = randomBytes(32).toString('hex');
    let closed = false;
    const sockets = new Set<Socket>();
    const responseSockets = new Set<Socket>();
    const pendingRequestIds = new Set<string>();
    const pendingRoutesByRequestId = new Map<string, QuestionHttpBridgeRoute>();
    const notifyingAgentRequestIds = new Set<string>();
    const responseSocketByRequestId = new Map<string, Socket>();

    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/ask-question') {
        writeJson(res, 404, { error: 'Not found' });
        return;
      }

      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${token}`) {
        writeJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        writeJson(res, 400, { error: getErrorMessage(error) });
        return;
      }

      if (closed) {
        writeJson(res, 503, { error: 'Question bridge is closed' });
        return;
      }

      if (!isAskQuestionBody(body)) {
        writeJson(res, 400, { error: 'Invalid ask-question body' });
        return;
      }

      const route =
        routeMode === 'session'
          ? resolveSessionRoute({ body, routeBySessionId })
          : resolveAppRoute({ body, routeByStepId });
      if (!route.ok) {
        writeJson(res, route.statusCode, { error: route.error });
        return;
      }

      let brokerRequest: BrokerQuestionRequest | null = null;
      let responseFinished = false;
      const notifyQuestionCancelled = (requestId: string) => {
        const pendingRoute = pendingRoutesByRequestId.get(requestId);
        void Promise.resolve(pendingRoute?.onQuestionCancelled?.(requestId)).catch(
          () => {},
        );
      };
      const cancelBrokerRequest = (reason: string) => {
        const requestId = brokerRequest?.request.requestId;
        if (!requestId || !pendingRequestIds.has(requestId)) return;
        pendingRequestIds.delete(requestId);
        this.broker.cancelRequest(requestId, reason);
        notifyQuestionCancelled(requestId);
        pendingRoutesByRequestId.delete(requestId);
        notifyingAgentRequestIds.delete(requestId);
        responseSocketByRequestId.delete(requestId);
      };
      res.on('close', () => {
        responseSockets.delete(req.socket);
        if (!responseFinished) {
          cancelBrokerRequest('Question bridge client disconnected');
        }
      });
      try {
        brokerRequest = this.broker.createRequest({
          taskId: route.value.taskId,
          stepId: route.value.stepId,
          questions: body.questions,
        });
        void brokerRequest.result.catch(() => {});
        pendingRequestIds.add(brokerRequest.request.requestId);
        pendingRoutesByRequestId.set(
          brokerRequest.request.requestId,
          route.value,
        );
        responseSockets.add(req.socket);
        responseSocketByRequestId.set(brokerRequest.request.requestId, req.socket);
        notifyingAgentRequestIds.add(brokerRequest.request.requestId);
        try {
          await route.value.onQuestionRequest(brokerRequest.request);
        } finally {
          notifyingAgentRequestIds.delete(brokerRequest.request.requestId);
        }
        const summary = await brokerRequest.result;
        pendingRequestIds.delete(brokerRequest.request.requestId);
        pendingRoutesByRequestId.delete(brokerRequest.request.requestId);
        responseSocketByRequestId.delete(brokerRequest.request.requestId);
        responseFinished = true;
        writeJson(res, 200, { summary });
      } catch (error) {
        if (brokerRequest?.request.requestId) {
          void brokerRequest.result.catch(() => {});
          cancelBrokerRequest(getErrorMessage(error));
        }
        if (!res.destroyed) {
          responseFinished = true;
          writeJson(res, 500, { error: getErrorMessage(error) });
        }
      }
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
      if (closed) {
        socket.destroy();
      }
    });

    const close = async (reason = 'Question bridge closed'): Promise<void> => {
      if (closed) return;
      closed = true;
      for (const route of routes) {
        this.broker.cancelSession(route.stepId, reason);
      }
      await Promise.all(
        Array.from(pendingRequestIds).map(async (requestId) => {
          await Promise.resolve(
            pendingRoutesByRequestId.get(requestId)?.onQuestionCancelled?.(
              requestId,
            ),
          ).catch(() => {});
          pendingRequestIds.delete(requestId);
          pendingRoutesByRequestId.delete(requestId);
        }),
      );
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      for (const socket of sockets) {
        if (!responseSockets.has(socket)) {
          socket.destroy();
        }
      }
      for (const requestId of notifyingAgentRequestIds) {
        responseSocketByRequestId.get(requestId)?.destroy();
        responseSocketByRequestId.delete(requestId);
      }
      notifyingAgentRequestIds.clear();

      await serverClosed;
    };

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      await close('Question bridge failed to bind');
      throw new Error('Question bridge failed to bind');
    }

    return {
      serverUrl: `http://127.0.0.1:${address.port}`,
      sessionId,
      token,
      close,
    };
  }
}

function assertUniqueRouteStepIds(routes: QuestionHttpBridgeRoute[]): void {
  const stepIds = new Set<string>();
  for (const route of routes) {
    if (stepIds.has(route.stepId)) {
      throw new Error(`Duplicate question bridge route stepId: ${route.stepId}`);
    }
    stepIds.add(route.stepId);
  }
}

function isAskQuestionBody(
  body: unknown,
): body is { sessionId?: string; stepId?: string; questions: QuestionSpec[] } {
  if (!body || typeof body !== 'object') return false;
  const value = body as {
    sessionId?: unknown;
    stepId?: unknown;
    questions?: unknown;
  };
  return (
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    (value.stepId === undefined || typeof value.stepId === 'string') &&
    Array.isArray(value.questions)
  );
}

function resolveSessionRoute({
  body,
  routeBySessionId,
}: {
  body: { sessionId?: string; stepId?: string; questions: QuestionSpec[] };
  routeBySessionId: Map<string, QuestionHttpBridgeRoute>;
}): { ok: true; value: QuestionHttpBridgeRoute } | BridgeRouteError {
  if (!body.sessionId) {
    return { ok: false, statusCode: 403, error: 'Invalid session' };
  }
  const route = routeBySessionId.get(body.sessionId);
  if (!route) {
    return { ok: false, statusCode: 403, error: 'Invalid session' };
  }
  return { ok: true, value: route };
}

function resolveAppRoute({
  body,
  routeByStepId,
}: {
  body: { sessionId?: string; stepId?: string; questions: QuestionSpec[] };
  routeByStepId: Map<string, QuestionHttpBridgeRoute>;
}): { ok: true; value: QuestionHttpBridgeRoute } | BridgeRouteError {
  if (!body.stepId) {
    return { ok: false, statusCode: 403, error: 'Missing stepId' };
  }
  const route = routeByStepId.get(body.stepId);
  if (!route) {
    return { ok: false, statusCode: 404, error: 'Unknown stepId' };
  }
  return { ok: true, value: route };
}

interface BridgeRouteError {
  ok: false;
  statusCode: 403 | 404;
  error: string;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error('Request body is required');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(statusCode, {
    connection: 'close',
    'content-type': 'application/json',
  });
  res.end(JSON.stringify(body));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
