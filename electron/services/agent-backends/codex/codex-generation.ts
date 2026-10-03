import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';

import type { TextGenerationInput } from '@shared/agent-backend-provider-types';

import { dbg } from '../../../lib/debug';
import { getChildProcessEnv } from '../../../lib/child-process-env';

// Ignore user configuration as well: merely disabling shell tools on the shared
// app-server would still leave configured MCP servers and hooks available.
const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
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

export async function generateCodexWithoutTools({
  model,
  prompt,
  outputSchema,
  thinkingEffort,
  abortController,
  usageContext,
}: TextGenerationInput & {
  outputSchema?: Record<string, unknown>;
}): Promise<unknown> {
  const signal = abortController.signal;
  signal.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), 'jc-codex-generation-'));
  const startedAt = Date.now();
  try {
    const args = [
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
      '--skip-git-repo-check', '--sandbox', 'read-only', '--json',
      '--cd', directory,
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      '-c', 'mcp_servers={}',
      '-c', 'apps._default.enabled=false',
      '-c', 'project_doc_max_bytes=0',
      '-c', 'features.skip_host_skill_discovery=true',
      '-c', 'tools.view_image=false',
      ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    ];
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
          const reason = signal.aborted
            ? 'canceled'
            : stderr.trim().slice(-2000) || error.code || 'process error';
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
        throw new Error('Codex isolated generation reported a failed turn');
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
