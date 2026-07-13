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
const QUESTION_RESULT_TTL_MS = 10 * 60 * 1000;

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

type QuestionResultState =
  | { status: 'pending'; route: RegisteredJcMcpBridgeRoute }
  | { status: 'answered'; summary: string }
  | { status: 'cancelled'; reason: string };

export class JcMcpBridgeService {
  private readonly routesByStepId = new Map<string, RegisteredJcMcpBridgeRoute>();
  private readonly token = randomBytes(32).toString('hex');
  private readonly sockets = new Set<Socket>();
  private readonly pendingRequestIds = new Set<string>();
  private readonly pendingRouteByRequestId = new Map<
    string,
    RegisteredJcMcpBridgeRoute
  >();
  private readonly resultStateByRequestId = new Map<string, QuestionResultState>();
  private readonly resultCleanupTimerByRequestId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
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
          this.setResultState(requestId, {
            status: 'cancelled',
            reason: 'Agent session ended',
          });
          this.broker.cancelRequest(requestId, 'Agent session ended');
          await Promise.resolve(
            pendingRoute.onQuestionCancelled?.(requestId),
          ).catch(() => {});
        }),
    );
  }

  async close(reason = 'Jean-Claude MCP bridge closed'): Promise<void> {
    if (!this.server || this.closed) return;

    this.closed = true;
    const routes = Array.from(this.routesByStepId.values());
    this.routesByStepId.clear();
    for (const route of routes) {
      this.broker.cancelSession(route.stepId, reason);
    }

    await Promise.all(
      Array.from(this.pendingRequestIds).map(async (requestId) => {
        const route = this.pendingRouteByRequestId.get(requestId);
        await Promise.resolve(route?.onQuestionCancelled?.(requestId)).catch(
          () => {},
        );
        this.pendingRequestIds.delete(requestId);
        this.pendingRouteByRequestId.delete(requestId);
        this.setResultState(requestId, { status: 'cancelled', reason });
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
      socket.destroy();
    }
    for (const timer of this.resultCleanupTimerByRequestId.values()) {
      clearTimeout(timer);
    }
    this.resultCleanupTimerByRequestId.clear();
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
    if (req.method !== 'POST') {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }

    if (req.headers.authorization !== `Bearer ${this.token}`) {
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (this.closed) {
      writeJson(res, 503, { error: 'Question bridge is closed' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      writeJson(res, 400, { error: getErrorMessage(error) });
      return;
    }

    if (req.url === '/question-result') {
      this.handleQuestionResult({ res, body });
      return;
    }

    if (req.url !== '/ask-question') {
      writeJson(res, 404, { error: 'Not found' });
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

    await this.handleAskQuestion({ res, route: route.value, body });
  }

  private resolveRoute(body: {
    stepId?: string;
    registrationId?: string;
    contextReminder?: string;
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
    res,
    route,
    body,
  }: {
    res: http.ServerResponse;
    route: RegisteredJcMcpBridgeRoute;
    body: { contextReminder?: string; questions: QuestionSpec[] };
  }): Promise<void> {
    if (!route) {
      writeJson(res, 404, { error: 'Unknown stepId' });
      return;
    }

    let brokerRequest: BrokerQuestionRequest | null = null;
    const cancelBrokerRequest = (reason: string) => {
      const requestId = brokerRequest?.request.requestId;
      if (!requestId || !this.pendingRequestIds.has(requestId)) return;
      this.pendingRequestIds.delete(requestId);
      this.pendingRouteByRequestId.delete(requestId);
      this.setResultState(requestId, { status: 'cancelled', reason });
      this.broker.cancelRequest(requestId, reason);
      void Promise.resolve(route.onQuestionCancelled?.(requestId)).catch(() => {});
    };

    try {
      brokerRequest = this.broker.createRequest({
        taskId: route.taskId,
        stepId: route.stepId,
        contextReminder: body.contextReminder,
        questions: body.questions,
      });
      const requestId = brokerRequest.request.requestId;
      void brokerRequest.result.catch(() => {});
      this.pendingRequestIds.add(requestId);
      this.pendingRouteByRequestId.set(requestId, route);
      this.setResultState(requestId, {
        status: 'pending',
        route,
      });
      void brokerRequest.result.then(
        (summary) => {
          this.pendingRequestIds.delete(requestId);
          this.pendingRouteByRequestId.delete(requestId);
          this.setResultState(requestId, {
            status: 'answered',
            summary,
          });
        },
        (error) => {
          this.pendingRequestIds.delete(requestId);
          this.pendingRouteByRequestId.delete(requestId);
          if (this.resultStateByRequestId.get(requestId)?.status === 'cancelled') {
            return;
          }
          this.setResultState(requestId, {
            status: 'cancelled',
            reason: getErrorMessage(error),
          });
        },
      );

      writeJson(res, 202, { requestId });
      await route.onQuestionRequest(brokerRequest.request);
    } catch (error) {
      if (brokerRequest?.request.requestId) {
        void brokerRequest.result.catch(() => {});
        cancelBrokerRequest(getErrorMessage(error));
      }
      if (!res.destroyed && !res.writableEnded) {
        writeJson(res, 500, { error: getErrorMessage(error) });
      }
    }
  }

  private handleQuestionResult({
    res,
    body,
  }: {
    res: http.ServerResponse;
    body: unknown;
  }): void {
    if (!isQuestionResultBody(body)) {
      writeJson(res, 400, { error: 'Invalid question-result body' });
      return;
    }

    const state = this.resultStateByRequestId.get(body.requestId);
    if (!state) {
      writeJson(res, 404, { error: 'Unknown requestId' });
      return;
    }

    if (state.status === 'pending') {
      writeJson(res, 202, { status: 'pending' });
      return;
    }

    this.deleteResultState(body.requestId);
    if (state.status === 'cancelled') {
      writeJson(res, 409, { error: state.reason });
      return;
    }

    writeJson(res, 200, { summary: state.summary });
  }

  private setResultState(requestId: string, state: QuestionResultState): void {
    this.resultStateByRequestId.set(requestId, state);
    const existingTimer = this.resultCleanupTimerByRequestId.get(requestId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.resultCleanupTimerByRequestId.delete(requestId);
    }
    if (state.status === 'pending') return;

    const cleanupTimer = setTimeout(() => {
      this.deleteResultState(requestId);
    }, QUESTION_RESULT_TTL_MS);
    cleanupTimer.unref?.();
    this.resultCleanupTimerByRequestId.set(requestId, cleanupTimer);
  }

  private deleteResultState(requestId: string): void {
    this.resultStateByRequestId.delete(requestId);
    const timer = this.resultCleanupTimerByRequestId.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.resultCleanupTimerByRequestId.delete(requestId);
    }
  }
}

function isAskQuestionBody(
  body: unknown,
): body is {
  stepId?: string;
  registrationId?: string;
  contextReminder?: string;
  questions: QuestionSpec[];
} {
  if (!body || typeof body !== 'object') return false;
  const value = body as {
    stepId?: unknown;
    registrationId?: unknown;
    contextReminder?: unknown;
    questions?: unknown;
  };
  return (
    (value.stepId === undefined || typeof value.stepId === 'string') &&
    (value.registrationId === undefined ||
      typeof value.registrationId === 'string') &&
    (value.contextReminder === undefined ||
      (typeof value.contextReminder === 'string' &&
        value.contextReminder.trim().length > 0)) &&
    Array.isArray(value.questions)
  );
}

function isQuestionResultBody(body: unknown): body is { requestId: string } {
  if (!body || typeof body !== 'object') return false;
  const value = body as { requestId?: unknown };
  return typeof value.requestId === 'string' && value.requestId.length > 0;
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
