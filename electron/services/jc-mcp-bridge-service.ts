import http from 'http';
import { randomBytes } from 'crypto';
import type { Socket } from 'net';

import { nanoid } from 'nanoid';

import type { NormalizedQuestionRequest } from '@shared/agent-backend-types';

import {
  type BrokerQuestionRequest,
  QuestionBrokerService,
  type QuestionSpec,
} from './question-broker-service';

const MAX_BODY_BYTES = 1024 * 1024;

export interface JcMcpBridgeConfig {
  serverUrl: string;
  token: string;
  stepId?: string;
  registrationId?: string;
}

export interface JcMcpBridgeRegistration extends JcMcpBridgeConfig {
  stepId: string;
  registrationId: string;
}

export interface JcMcpBridgeRoute {
  taskId: string;
  stepId: string;
  onQuestionRequest: (request: NormalizedQuestionRequest) => Promise<void>;
  onQuestionCancelled?: (requestId: string) => Promise<void> | void;
}

interface RegisteredJcMcpBridgeRoute extends JcMcpBridgeRoute {
  registrationId: string;
}

export class JcMcpBridgeService {
  private readonly routesByStepId = new Map<string, RegisteredJcMcpBridgeRoute>();
  private readonly token = randomBytes(32).toString('hex');
  private readonly sockets = new Set<Socket>();
  private readonly responseSockets = new Set<Socket>();
  private readonly pendingRequestIds = new Set<string>();
  private readonly pendingRouteByRequestId = new Map<
    string,
    RegisteredJcMcpBridgeRoute
  >();
  private readonly responseSocketByRequestId = new Map<string, Socket>();
  private server: http.Server | null = null;
  private serverUrl: string | null = null;
  private startPromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly broker: QuestionBrokerService) {}

  async getBridgeConfig(): Promise<JcMcpBridgeConfig> {
    await this.ensureStarted();
    if (!this.serverUrl) {
      throw new Error('Jean-Claude MCP bridge failed to start');
    }

    return {
      serverUrl: this.serverUrl,
      token: this.token,
    };
  }

  async registerStep(
    route: JcMcpBridgeRoute,
  ): Promise<JcMcpBridgeRegistration> {
    await this.ensureStarted();
    const registrationId = nanoid();
    this.routesByStepId.set(route.stepId, { ...route, registrationId });
    return {
      ...(await this.getBridgeConfig()),
      stepId: route.stepId,
      registrationId,
    };
  }

  async unregisterStep(
    stepId: string,
    registrationId?: string,
  ): Promise<void> {
    const route = this.routesByStepId.get(stepId);
    const shouldRemoveCurrentRoute =
      route !== undefined &&
      (!registrationId || route.registrationId === registrationId);

    if (shouldRemoveCurrentRoute) {
      this.routesByStepId.delete(stepId);
      this.broker.cancelSession(stepId, 'Agent session ended');
    }
    const socketsToDestroy: Socket[] = [];

    await Promise.all(
      Array.from(this.pendingRouteByRequestId.entries())
        .filter(
          ([, pendingRoute]) =>
            pendingRoute.stepId === stepId &&
            (!registrationId ||
              pendingRoute.registrationId === registrationId),
        )
        .map(async ([requestId, pendingRoute]) => {
          this.pendingRequestIds.delete(requestId);
          this.pendingRouteByRequestId.delete(requestId);
          this.broker.cancelRequest(requestId, 'Agent session ended');
          const socket = this.responseSocketByRequestId.get(requestId);
          if (socket) {
            socketsToDestroy.push(socket);
            this.responseSocketByRequestId.delete(requestId);
          }
          await Promise.resolve(
            pendingRoute.onQuestionCancelled?.(requestId),
          ).catch(() => {});
        }),
    );

    for (const socket of socketsToDestroy) {
      socket.destroy();
    }
  }

  async close(reason = 'Jean-Claude MCP bridge closed'): Promise<void> {
    if (!this.server || this.closed) return;

    this.closed = true;
    const routes = Array.from(this.routesByStepId.values());
    this.routesByStepId.clear();
    for (const route of routes) {
      this.broker.cancelSession(route.stepId, reason);
    }

    const socketsToDestroy = new Set<Socket>();
    await Promise.all(
      Array.from(this.pendingRequestIds).map(async (requestId) => {
        const route = this.pendingRouteByRequestId.get(requestId);
        await Promise.resolve(route?.onQuestionCancelled?.(requestId)).catch(
          () => {},
        );
        this.pendingRequestIds.delete(requestId);
        this.pendingRouteByRequestId.delete(requestId);
        const socket = this.responseSocketByRequestId.get(requestId);
        if (socket) {
          socketsToDestroy.add(socket);
          this.responseSocketByRequestId.delete(requestId);
        }
      }),
    );

    const server = this.server;
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    for (const socket of this.sockets) {
      if (!this.responseSockets.has(socket)) {
        socket.destroy();
      }
    }
    for (const socket of socketsToDestroy) {
      socket.destroy();
    }
    this.responseSocketByRequestId.clear();

    await serverClosed;
    this.server = null;
    this.serverUrl = null;
    this.startPromise = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.serverUrl && !this.closed) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.closed = false;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
      if (this.closed) {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Jean-Claude MCP bridge failed to bind');
    }

    this.server = server;
    this.serverUrl = `http://127.0.0.1:${address.port}`;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/ask-question') {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }

    if (req.headers.authorization !== `Bearer ${this.token}`) {
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

    if (this.closed) {
      writeJson(res, 503, { error: 'Question bridge is closed' });
      return;
    }

    if (!isAskQuestionBody(body)) {
      writeJson(res, 400, { error: 'Invalid ask-question body' });
      return;
    }

    const route = this.resolveRoute(body);
    if (!route.ok) {
      writeJson(res, route.statusCode, { error: route.error });
      return;
    }
    if (body.registrationId !== route.value.registrationId) {
      writeJson(res, 403, { error: 'Invalid registration' });
      return;
    }

    await this.handleAskQuestion({ req, res, route: route.value, body });
  }

  private resolveRoute(body: {
    stepId?: string;
    registrationId?: string;
    questions: QuestionSpec[];
  }):
    | { ok: true; value: RegisteredJcMcpBridgeRoute }
    | { ok: false; statusCode: 403 | 404; error: string } {
    if (body.stepId) {
      const route = this.routesByStepId.get(body.stepId);
      if (!route) {
        return { ok: false, statusCode: 404, error: 'Unknown stepId' };
      }
      return { ok: true, value: route };
    }

    if (this.routesByStepId.size !== 1) {
      return { ok: false, statusCode: 403, error: 'Missing stepId' };
    }

    const route = Array.from(this.routesByStepId.values())[0];
    return { ok: true, value: route };
  }

  private async handleAskQuestion({
    req,
    res,
    route,
    body,
  }: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    route: RegisteredJcMcpBridgeRoute;
    body: { questions: QuestionSpec[] };
  }): Promise<void> {
    if (!route) {
      writeJson(res, 404, { error: 'Unknown stepId' });
      return;
    }

    let brokerRequest: BrokerQuestionRequest | null = null;
    let responseFinished = false;
    const cancelBrokerRequest = (reason: string) => {
      const requestId = brokerRequest?.request.requestId;
      if (!requestId || !this.pendingRequestIds.has(requestId)) return;
      this.pendingRequestIds.delete(requestId);
      this.pendingRouteByRequestId.delete(requestId);
      this.responseSocketByRequestId.delete(requestId);
      this.broker.cancelRequest(requestId, reason);
      void Promise.resolve(route.onQuestionCancelled?.(requestId)).catch(() => {});
    };

    res.on('close', () => {
      this.responseSockets.delete(req.socket);
      if (!responseFinished) {
        cancelBrokerRequest('Question bridge client disconnected');
      }
    });

    try {
      brokerRequest = this.broker.createRequest({
        taskId: route.taskId,
        stepId: route.stepId,
        questions: body.questions,
      });
      void brokerRequest.result.catch(() => {});
      this.pendingRequestIds.add(brokerRequest.request.requestId);
      this.pendingRouteByRequestId.set(brokerRequest.request.requestId, route);
      this.responseSockets.add(req.socket);
      this.responseSocketByRequestId.set(
        brokerRequest.request.requestId,
        req.socket,
      );

      await route.onQuestionRequest(brokerRequest.request);
      const summary = await brokerRequest.result;
      this.pendingRequestIds.delete(brokerRequest.request.requestId);
      this.pendingRouteByRequestId.delete(brokerRequest.request.requestId);
      this.responseSocketByRequestId.delete(brokerRequest.request.requestId);
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
  }
}

function isAskQuestionBody(
  body: unknown,
): body is {
  stepId?: string;
  registrationId?: string;
  questions: QuestionSpec[];
} {
  if (!body || typeof body !== 'object') return false;
  const value = body as {
    stepId?: unknown;
    registrationId?: unknown;
    questions?: unknown;
  };
  return (
    (value.stepId === undefined || typeof value.stepId === 'string') &&
    (value.registrationId === undefined ||
      typeof value.registrationId === 'string') &&
    Array.isArray(value.questions)
  );
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
