import { access, mkdir, readFile } from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { generateCodexWithoutTools } from './codex-generation';

const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
const output = [
  { type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"Done"}' } },
  { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } },
].map((event) => JSON.stringify(event)).join('\n');

beforeEach(async () => {
  await mkdir(tmpdir(), { recursive: true });
  vi.clearAllMocks();
  stdin.removeAllListeners();
  execFileMock.mockImplementation((_command, _args, _options, callback) => {
    queueMicrotask(() => callback(null, output, ''));
    return { stdin };
  });
});

it('isolates generation, passes the prompt through stdin and cleans its schema', async () => {
  const schema = { type: 'object' };
  let schemaPath = '';
  execFileMock.mockImplementation((_command, args, _options, callback) => {
    schemaPath = args[args.indexOf('--output-schema') + 1];
    void readFile(schemaPath, 'utf-8').then((content) => {
      expect(JSON.parse(content)).toEqual(schema);
      callback(null, output, '');
    });
    return { stdin };
  });
  await expect(generateCodexWithoutTools({
    model: 'chosen-model', prompt: 'a full transcript', outputSchema: schema,
    abortController: new AbortController(),
  })).resolves.toEqual({ summary: 'Done' });
  const [command, args, options] = execFileMock.mock.calls[0];
  expect(command).toBe('codex');
  expect(args).toEqual(expect.arrayContaining([
    '--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox',
    'read-only', 'approval_policy="never"', 'web_search="disabled"',
    'shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', '--model', 'chosen-model',
  ]));
  expect(args).not.toContain('a full transcript');
  expect(stdin.end).toHaveBeenCalledWith('a full transcript');
  expect(options.killSignal).toBe('SIGKILL');
  await expect(access(options.cwd)).rejects.toThrow();
});

it.each([
  ['nonzero exit', new Error('failed'), '', 'unsupported argument'],
  ['failed turn', null, '{"type":"turn.failed"}', ''],
  ['missing completed turn', null, '{"type":"thread.started"}', ''],
  ['invalid JSON', null, 'not json', ''],
])('rejects %s and cleans the temporary directory', async (_name, error, stdout, stderr) => {
  execFileMock.mockImplementation((_command, _args, _options, callback) => {
    queueMicrotask(() => callback(error, stdout, stderr));
    return { stdin };
  });
  await expect(generateCodexWithoutTools({
    model: 'default', prompt: 'summarize', abortController: new AbortController(),
  })).rejects.toThrow();
  await expect(access(execFileMock.mock.calls[0][2].cwd)).rejects.toThrow();
});

it('does not spawn an already canceled generation', async () => {
  const abortController = new AbortController();
  abortController.abort();
  await expect(generateCodexWithoutTools({
    model: 'default', prompt: 'summarize', abortController,
  })).rejects.toThrow();
  expect(execFileMock).not.toHaveBeenCalled();
});

it('passes cancellation to the process and cleans up after termination', async () => {
  const abortController = new AbortController();
  execFileMock.mockImplementation((_command, _args, options, callback) => {
    expect(options.signal).toBe(abortController.signal);
    options.signal.addEventListener('abort', () => callback(new Error('aborted'), '', ''));
    queueMicrotask(() => abortController.abort());
    return { stdin };
  });
  await expect(generateCodexWithoutTools({
    model: 'default', prompt: 'summarize', abortController,
  })).rejects.toThrow('canceled');
  await expect(access(execFileMock.mock.calls[0][2].cwd)).rejects.toThrow();
});
