import { createInterface, type Interface as ReadlineInterface } from 'readline';
import type { Readable, Writable } from 'stream';
import type { EventEmitter } from 'events';

export type AcpJsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type AcpJsonRpcRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

export type AcpJsonRpcProcess = Pick<EventEmitter, 'on' | 'off'> & {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  kill: () => void;
};

export class AcpJsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpJsonRpcError';
  }
}

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  write: PendingWrite | undefined;
};

type PendingWrite = {
  reject: (error: Error) => void;
  resolve: () => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AcpJsonRpcClient {
  private nextId = 1;
  private disposed = false;
  private terminalError: Error | undefined;
  private noopErrorHandlersInstalled = false;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly pendingWrites = new Set<PendingWrite>();
  private readonly notifications = new Set<
    (message: AcpJsonRpcNotification) => void
  >();
  private readonly requests = new Set<(message: AcpJsonRpcRequest) => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private readonly readline: ReadlineInterface;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly options: {
      process: AcpJsonRpcProcess;
      requestTimeoutMs?: number;
    },
  ) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.readline = createInterface({ input: options.process.stdout });
    this.readline.on('line', this.handleLine);
    this.readline.on('error', this.handleReadlineError);
    options.process.on('exit', this.handleExit);
    options.process.on('error', this.handleProcessError);
    options.process.stdin.on('error', this.handleStdinError);
    options.process.stdout.on('error', this.handleStdoutError);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const activeError = this.getInactiveError();
    if (activeError !== undefined) {
      return Promise.reject(activeError);
    }

    const id = this.nextId++;
    const message = this.withOptionalParams(
      { jsonrpc: '2.0', id, method },
      params,
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }

        const error = new Error(`ACP JSON-RPC request timed out: ${method}`);
        this.pending.delete(id);
        pending.write?.reject(error);
        reject(error);
      }, this.requestTimeoutMs);
      timeout.unref?.();

      const write = this.writeLine(message);
      this.pending.set(id, { method, resolve, reject, timeout, write });
      write.promise.catch((error: unknown) => {
        this.failTerminal(this.toError(error));
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    const activeError = this.getInactiveError();
    if (activeError !== undefined) {
      return Promise.reject(activeError);
    }

    const message = this.withOptionalParams({ jsonrpc: '2.0', method }, params);
    return this.writeLine(message).promise.catch((error: unknown) => {
      const normalized = this.toError(error);
      this.failTerminal(normalized);
      throw normalized;
    });
  }

  respond(id: string | number, result: unknown): Promise<void> {
    const activeError = this.getInactiveError();
    if (activeError !== undefined) {
      return Promise.reject(activeError);
    }

    return this.writeLine({ jsonrpc: '2.0', id, result }).promise.catch(
      (error: unknown) => {
        const normalized = this.toError(error);
        this.failTerminal(normalized);
        throw normalized;
      },
    );
  }

  respondError(
    id: string | number,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    const activeError = this.getInactiveError();
    if (activeError !== undefined) {
      return Promise.reject(activeError);
    }

    return this.writeLine({ jsonrpc: '2.0', id, error }).promise.catch(
      (writeError: unknown) => {
        const normalized = this.toError(writeError);
        this.failTerminal(normalized);
        throw normalized;
      },
    );
  }

  onNotification(
    listener: (message: AcpJsonRpcNotification) => void,
  ): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onRequest(listener: (message: AcpJsonRpcRequest) => void): () => void {
    this.requests.add(listener);
    return () => this.requests.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.terminalError = new Error('ACP JSON-RPC client disposed');
    this.options.process.off('exit', this.handleExit);
    this.options.process.off('error', this.handleProcessError);
    this.options.process.stdin.off('error', this.handleStdinError);
    this.options.process.stdout.off('error', this.handleStdoutError);
    this.installNoopErrorHandlers();
    this.readline.off('line', this.handleLine);
    this.readline.off('error', this.handleReadlineError);
    this.readline.close();
    this.rejectAll(this.terminalError);
    this.rejectPendingWrites(this.terminalError);
    this.notifications.clear();
    this.requests.clear();
    this.errors.clear();
    this.options.process.kill();
  }

  private readonly handleLine = (line: string) => {
    if (line.trim() === '') {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emitError(
        new Error(
          `Failed to parse ACP JSON-RPC line: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      return;
    }

    if (!this.isObject(message)) {
      return;
    }

    if (
      typeof message.method === 'string' &&
      (typeof message.id === 'number' || typeof message.id === 'string')
    ) {
      this.emitRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (typeof message.method === 'string' && message.id === undefined) {
      this.emitNotification({ method: message.method, params: message.params });
      return;
    }

    this.handleResponse(message);
  };

  private readonly handleExit = (
    code: number | null,
    signal: string | null,
  ) => {
    this.failTerminal(
      new Error(
        `ACP process exited${code === null ? '' : ` with code ${code}`}${
          signal === null ? '' : ` and signal ${signal}`
        }`,
      ),
    );
  };

  private readonly handleProcessError = (error: Error) => {
    this.failTerminal(error);
  };

  private readonly handleStdinError = (error: Error) => {
    this.failTerminal(error);
  };

  private readonly handleStdoutError = (error: Error) => {
    this.failTerminal(error);
  };

  private readonly handleReadlineError = (error: Error) => {
    this.failTerminal(error);
  };

  private handleResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number' && typeof message.id !== 'string') {
      return;
    }

    const pendingKey = this.pendingKeyForResponse(message.id);
    if (pendingKey === undefined) {
      return;
    }

    const pending = this.pending.get(pendingKey);
    if (pending === undefined) {
      return;
    }

    this.pending.delete(pendingKey);
    clearTimeout(pending.timeout);
    pending.write?.resolve();

    if (message.error !== undefined) {
      pending.reject(this.errorFromResponse(pending.method, message.error));
      return;
    }

    pending.resolve(message.result);
  }

  private pendingKeyForResponse(id: string | number): string | number | undefined {
    if (this.pending.has(id)) {
      return id;
    }

    if (typeof id !== 'string' || id.trim() === '') {
      return undefined;
    }

    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId)) {
      return undefined;
    }

    return this.pending.has(numericId) ? numericId : undefined;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.write?.reject(error);
      pending.reject(error);
    }
  }

  private failTerminal(error: Error): void {
    if (this.terminalError !== undefined) {
      return;
    }

    this.terminalError = error;
    this.options.process.off('exit', this.handleExit);
    this.options.process.off('error', this.handleProcessError);
    this.options.process.stdin.off('error', this.handleStdinError);
    this.options.process.stdout.off('error', this.handleStdoutError);
    this.installNoopErrorHandlers();
    this.readline.off('line', this.handleLine);
    this.readline.off('error', this.handleReadlineError);
    this.readline.close();
    this.rejectAll(error);
    this.rejectPendingWrites(error);
    this.emitError(error);
  }

  private emitNotification(message: AcpJsonRpcNotification): void {
    for (const listener of this.notifications) {
      try {
        listener(message);
      } catch {
        // Notification subscribers must not break stream processing.
      }
    }
  }

  private emitRequest(message: AcpJsonRpcRequest): void {
    for (const listener of this.requests) {
      try {
        listener(message);
      } catch {
        // Request subscribers must not break stream processing.
      }
    }
  }

  private installNoopErrorHandlers(): void {
    if (this.noopErrorHandlersInstalled) {
      return;
    }

    this.noopErrorHandlersInstalled = true;
    this.options.process.on('error', this.ignoreLateError);
    this.options.process.stdin.on('error', this.ignoreLateError);
    this.options.process.stdout.on('error', this.ignoreLateError);
  }

  private readonly ignoreLateError = () => {};

  private emitError(error: Error): void {
    for (const listener of this.errors) {
      try {
        listener(error);
      } catch {
        // Error subscribers must not prevent request rejection.
      }
    }
  }

  private getInactiveError(): Error | undefined {
    if (this.disposed) {
      return new Error('ACP JSON-RPC client disposed');
    }

    return this.terminalError;
  }

  private writeLine(message: Record<string, unknown>): {
    promise: Promise<void>;
    reject: (error: Error) => void;
    resolve: () => void;
  } {
    let rejectWrite: (error: Error) => void = () => {};
    let resolveWrite: () => void = () => {};
    const handle: PendingWrite = {
      reject: (error) => rejectWrite(error),
      resolve: () => resolveWrite(),
    };
    const promise = new Promise<void>((resolve, reject) => {
      const activeError = this.getInactiveError();
      if (activeError !== undefined) {
        reject(activeError);
        return;
      }

      let settled = false;
      const timeout = setTimeout(() => {
        rejectWrite(new Error('ACP JSON-RPC write timed out'));
      }, this.requestTimeoutMs);
      timeout.unref?.();

      rejectWrite = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this.pendingWrites.delete(handle);
        reject(error);
      };
      resolveWrite = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this.pendingWrites.delete(handle);
        resolve();
      };

      this.pendingWrites.add(handle);

      try {
        this.options.process.stdin.write(
          `${JSON.stringify(message)}\n`,
          (error?: Error | null) => {
            if (error != null) {
              rejectWrite(error);
              return;
            }

            resolveWrite();
          },
        );
      } catch (error) {
        rejectWrite(this.toError(error));
      }
    });

    return { promise, reject: handle.reject, resolve: handle.resolve };
  }

  private rejectPendingWrites(error: Error): void {
    for (const write of [...this.pendingWrites]) {
      write.reject(error);
    }
  }

  private withOptionalParams<T extends Record<string, unknown>>(
    message: T,
    params: unknown,
  ): T & { params?: unknown } {
    if (params === undefined) {
      return message;
    }

    return { ...message, params };
  }

  private errorFromResponse(method: string, error: unknown): Error {
    if (this.isObject(error) && typeof error.message === 'string') {
      return new AcpJsonRpcError(
        error.message,
        typeof error.code === 'number' ? error.code : undefined,
        error.data,
      );
    }

    return new Error(
      `ACP JSON-RPC request failed: ${method}: ${JSON.stringify(error)}`,
    );
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
