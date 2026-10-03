import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';

import type { TextGenerationInput } from '@shared/agent-backend-provider-types';

import { dbg } from '../../../lib/debug';
import { getChildProcessEnv } from '../../../lib/child-process-env';

// Ignore user configuration as well: merely disabling shell tools on the shared
// app-server would still leave configured MCP servers and hooks available.
// Re-enabled only when the caller passes `allowReadOnlyShell`. Codex exposes no
// scoped Read tool: reading a file *is* a shell command, so file access and
// shell access are the same capability and cannot be separated.
const SHELL_FEATURES = ['shell_tool', 'unified_exec', 'shell_snapshot'];

const DISABLED_FEATURES = [
  ...SHELL_FEATURES,
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'computer_use',
  'image_generation',
  'view_image',
  'code_mode',
  'code_mode_host',
  'skill_search',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'memories',
  'goals',
  'in_app_browser',
  'remote_plugin',
];

// The Codex app-server rejects turn/start with `input_too_large` above this.
// Fail with an actionable message instead of a raw JSON-RPC error.
// The limit is counted in CHARACTERS, not UTF-8 bytes — verified empirically
// against codex-cli 0.155.0: a 400k-char / 1.2MB-UTF-8 CJK prompt is accepted,
// while 1_048_600 ASCII chars is rejected with `actual_chars: 1048600`. So do
// not "fix" this to Buffer.byteLength: that would reject multi-byte prompts the
// server accepts. JS `.length` (UTF-16 units) is always >= Rust's
// `chars().count()`, so this guard errs conservatively and never under-counts.
const MAX_CODEX_PROMPT_CHARS = 1_048_576;

/**
 * The human-readable failure out of a `codex exec --json` stream.
 *
 * Turn-level failures (usage limit, auth, model error) are emitted as JSON
 * events on stdout while the process exits 1 with no stderr, so this is the
 * only place the actual reason exists. Startup warnings (`item.completed` of
 * type `error`) are deliberately ignored: they are not failures.
 */
function codexErrorFromJsonStream(stdout: string): string | null {
  let reason: string | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const { type, message, error } = event as {
      type?: unknown;
      message?: unknown;
      error?: { message?: unknown };
    };
    if (type === 'error' && typeof message === 'string' && message.trim()) {
      reason = message.trim();
    } else if (
      type === 'turn.failed' &&
      typeof error?.message === 'string' &&
      error.message.trim()
    ) {
      reason = error.message.trim();
    }
  }
  return reason ? reason.slice(0, 2000) : null;
}

export async function generateCodexWithoutTools({
  model,
  prompt,
  outputSchema,
  thinkingEffort,
  abortController,
  usageContext,
  allowReadOnlyShell,
  cwd,
}: TextGenerationInput & {
  outputSchema?: Record<string, unknown>;
}): Promise<unknown> {
  const signal = abortController.signal;
  signal.throwIfAborted();
  if (prompt.length > MAX_CODEX_PROMPT_CHARS) {
    throw new Error(
      `Codex isolated generation prompt is too large: ${prompt.length} characters (max ${MAX_CODEX_PROMPT_CHARS})`,
    );
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'jc-codex-generation-'));
  const startedAt = Date.now();
  try {
    const args = [
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
      '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
      '--cd', allowReadOnlyShell && cwd ? cwd : directory,
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      '-c', 'mcp_servers={}',
      '-c', 'apps._default.enabled=false',
      '-c', 'project_doc_max_bytes=0',
      '-c', 'features.skip_host_skill_discovery=true',
      '-c', 'tools.view_image=false',
      ...(allowReadOnlyShell
        ? DISABLED_FEATURES.filter(
            (feature) => !SHELL_FEATURES.includes(feature),
          )
        : DISABLED_FEATURES
      ).flatMap((feature) => ['--disable', feature]),
    ];
    if (allowReadOnlyShell) {
      // Keep PATH and friends so the granted shell can actually run `cat`, but
      // strip credential-shaped variables so process env is not readable
      // through it. The read-only sandbox still permits reading any file the
      // user can read — that is the accepted tradeoff for file access, since
      // Codex cannot scope reads to a single path.
      args.push(
        '-c', 'shell_environment_policy.inherit="core"',
        '-c', 'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*","*PASSWORD*","*CREDENTIAL*","AWS_*","AZURE_*","GITHUB_*","OPENAI_*","ANTHROPIC_*"]',
      );
    }
    if (model !== 'default') args.push('--model', model);
    if (thinkingEffort && thinkingEffort !== 'default') {
      args.push('-c', `model_reasoning_effort=${JSON.stringify(thinkingEffort)}`);
    }
    if (outputSchema) {
      const schemaPath = path.join(directory, 'schema.json');
      await writeFile(schemaPath, JSON.stringify(outputSchema), 'utf-8');
      args.push('--output-schema', schemaPath);
    }
    args.push('-');
    signal.throwIfAborted();
    dbg.agent(
      'Codex isolated generation starting model=%s promptChars=%d',
      model,
      prompt.length,
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('codex', args, {
        cwd: directory,
        env: getChildProcessEnv(),
        signal,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      }, (error, output, stderr) => {
        dbg.agent(
          'Codex isolated generation finished model=%s durationMs=%d exit=%s',
          model,
          Date.now() - startedAt,
          error?.code ?? 0,
        );
        if (error) {
          // Do not include the command or prompt in errors. CLI diagnostics are
          // bounded so a failing process cannot flood the step error UI.
          //
          // `codex exec --json` reports turn failures (usage limit, auth, model
          // errors) as JSON on STDOUT and exits 1 with an EMPTY stderr, so
          // reading stderr alone produced the useless "failed: 1".
          const reason = signal.aborted
            ? 'canceled'
            : codexErrorFromJsonStream(output) ||
              stderr.trim().slice(-2000) ||
              error.code ||
              'process error';
          reject(new Error(`Codex isolated generation failed: ${reason}`));
        } else {
          resolve(output);
        }
      });
      // An early CLI exit can close stdin before the full transcript is sent.
      // execFile's callback reports that process failure.
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
    });
    signal.throwIfAborted();
    let text: string | undefined;
    let completed = false;
    for (const line of stdout.split('\n').filter((value) => value.trim())) {
      const event = JSON.parse(line);
      if (event.type === 'error' || event.type === 'turn.failed') {
        const reason = codexErrorFromJsonStream(stdout);
        throw new Error(
          reason
            ? `Codex isolated generation failed: ${reason}`
            : 'Codex isolated generation reported a failed turn',
        );
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        text = event.item.text;
      }
      if (event.type === 'turn.completed') {
        completed = true;
        if (usageContext) {
          const { aiUsageTrackingService } = await import(
            '../../ai-usage-tracking-service'
          );
          aiUsageTrackingService.recordUsageSafe({
            context: usageContext,
            backend: 'codex',
            model,
            usage: {
              inputTokens: event.usage?.input_tokens,
              outputTokens: event.usage?.output_tokens,
              cacheReadTokens: event.usage?.cached_input_tokens,
            },
            allowEmptyUsage: true,
          });
        }
      }
    }
    if (!completed || typeof text !== 'string' || !text.trim()) {
      throw new Error('Codex isolated generation returned no completed response');
    }
    return outputSchema ? JSON.parse(text) : text.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
